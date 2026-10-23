import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { contentHash } from "./fs-links.mjs";
import { compactHomePath, homeVariants, isStrictlyWithin } from "./fs-safe.mjs";
import { assertSafeWrite } from "./home-guard.mjs";
import { fingerprint, isReversible, LibraryError, recordOp, reverseOp, runOps } from "./library-ops.mjs";
import { createPlanStore } from "./plan-store.mjs";
import { listTrash, readTrashManifest, restoreTrash, trashOps } from "./trash.mjs";

/**
 * History, restore and single-Agent uninstall. Restores put a write's backup back (after
 * backing up what is there now, so a restore can itself be undone) or move a created
 * folder to the trash; uninstall removes a link, or moves a real folder to the trash.
 * Every write: plan from this process within 10 minutes, explicit confirmation, home guard.
 */

export const RESTORE_PLAN_TTL_MS = 10 * 60_000;
const HISTORY_LIMIT = 500;
const timestamp = (now) => new Date(now).toISOString().replace(/[:.]/gu, "-");

export function createRestoreService({ homeDirectory, homes, stateDirectory, backupDirectory, historyFile, getScan, getAgents, materialize, now = () => Date.now() }) {
  const plans = createPlanStore({ ttlMs: RESTORE_PLAN_TTL_MS, now });
  let allHomes = homes;
  const homesReady = homeVariants(homeDirectory).then((variants) => {
    allHomes = [...new Set([...homes, ...variants])];
  });
  const display = (value) => (value ? compactHomePath(value, allHomes) : null);
  const expand = (value) =>
    typeof value === "string" && value.startsWith("~/") ? path.join(homeDirectory, value.slice(2)) : value === "~" ? homeDirectory : value;
  const exists = async (target) => Boolean(target && (await lstat(target).catch(() => null)));

  async function readEntries() {
    const text = await readFile(historyFile, "utf8").catch(() => "");
    const entries = [];
    for (const line of text.split("\n").filter(Boolean).slice(-5_000)) {
      try {
        const entry = JSON.parse(line);
        entry.id ||= createHash("sha1").update(line).digest("hex").slice(0, 12);
        entries.push(entry);
      } catch {
        // A broken line is skipped.
      }
    }
    return entries.reverse();
  }

  async function appendHistory(record) {
    await mkdir(path.dirname(historyFile), { recursive: true });
    await appendFile(historyFile, `${JSON.stringify(record)}\n`, "utf8");
  }

  /** One history line in the shape the frontend lists. */
  async function normalize(entry) {
    const actions = Array.isArray(entry.actions) ? entry.actions : null;
    const base = {
      id: entry.id,
      at: entry.createdAt || null,
      action: entry.type || "unknown",
      skill: entry.skillName || entry.title || entry.unitKey || null,
      agents: actions ? [...new Set(actions.map((item) => item.agentId))] : entry.agentId ? [entry.agentId] : entry.targets || [],
      mode: entry.mode || actions?.[0]?.mode || null,
    };
    if (entry.type === "uninstall" || entry.trashId) {
      const inTrash = await readTrashManifest(stateDirectory, entry.trashId).then(() => true, () => false);
      return { ...base, backups: [], trashId: entry.trashId, restorable: inTrash, ...(inTrash ? {} : { reason: "回收站中已没有这个条目（可能已恢复）。" }) };
    }
    const units = opUnits(entry);
    if (units) {
      const restorable = units.some((unit) => Boolean(unit.trashId) || unit.ops.some(isReversible));
      return { ...base, agents: base.agents, backups: [], units: units.map((unit) => ({ id: unit.id, title: unit.title })), restorable, ...(restorable ? {} : { reason: "这次操作没有可撤销的改动。" }) };
    }
    if (!actions) {
      const reason =
        entry.type === "restore"
          ? "这是一次从回收站的恢复；需要撤销时可再次卸载。"
          : entry.type === "agent-update"
            ? "这是一次 Agent 的官方命令更新，无法自动撤销；需要回退时请按官方文档安装指定版本。"
            : ["library", "cli-fix"].includes(entry.type)
              ? "请在技能库或 CLI 工具中处理这类改动。"
              : "旧记录没有保存恢复所需的路径。";
      return { ...base, backups: [], restorable: false, reason };
    }
    const backups = [];
    for (const item of actions) {
      if (item.action === "replace") {
        const present = await exists(expand(item.backup));
        backups.push({ agentId: item.agentId, path: item.backup, target: item.realDestination, restorable: present, ...(present ? {} : { reason: "备份已不存在" }) });
      }
    }
    const restorable = actions.length > 0 && backups.every((item) => item.restorable);
    return { ...base, backups, restorable, ...(restorable ? {} : { reason: actions.length ? "部分备份已不存在。" : "这次操作没有写入。" }) };
  }

  /** Units of an op-recording entry: library items, restore units, or one unit per file op. */
  function opUnits(entry) {
    if (Array.isArray(entry.items)) return entry.items.map((item) => ({ id: item.id, title: item.title, ops: item.ops || [], trashId: item.trashId || null }));
    if (Array.isArray(entry.units)) return entry.units.map((unit) => ({ id: unit.id, title: unit.title, ops: unit.ops || [] }));
    if (Array.isArray(entry.ops)) return entry.ops.map((op, index) => ({ id: `op-${index}`, title: display(expand(op.path || op.restoreFile?.path || op.to)) || `第 ${index + 1} 项`, ops: [op] }));
    return null;
  }

  /** Reverse ops of a unit with their preconditions; conflicts and missing backups are reported. */
  async function planUnit(unit, backupGroup) {
    if (unit.trashId) {
      const manifest = await readTrashManifest(stateDirectory, unit.trashId).catch(() => null);
      return manifest
        ? { id: unit.id, title: unit.title, trashId: unit.trashId, steps: [{ type: "restore-trash", target: display(manifest.originalPath) }], ops: [], checks: [], conflict: false }
        : { id: unit.id, title: unit.title, steps: [], ops: [], checks: [], conflict: false, unrestorable: "回收站中已没有这个条目。" };
    }
    const ops = [];
    const checks = [];
    const steps = [];
    let conflict = null;
    let unrestorable = null;
    // Paths that earlier reverse steps of this unit will have cleared by the time a step runs.
    const freed = new Set();
    for (const record of [...unit.ops].reverse()) {
      const reverse = reverseOp(record, { expand, backupGroup });
      if (!reverse) continue;
      if (reverse.unsupported) {
        unrestorable = reverse.unsupported;
        continue;
      }
      if (reverse.needs && !(await exists(reverse.needs))) unrestorable = `备份 ${display(reverse.needs)} 已不存在。`;
      if (reverse.check) {
        const current = await fingerprint(reverse.check);
        checks.push({ path: reverse.check, current });
        if (reverse.expect !== undefined && reverse.expect !== null && current !== reverse.expect) conflict = `${display(reverse.check)} 在那次操作之后又被修改过。`;
      }
      if (reverse.free && !freed.has(reverse.free) && (await exists(reverse.free))) {
        conflict = `${display(reverse.free)} 已有内容。`;
        checks.push({ path: reverse.free, current: await fingerprint(reverse.free) });
      }
      if (["unlink", "stash"].includes(reverse.op.op)) freed.add(reverse.op.path);
      if (reverse.op.op === "move") freed.add(reverse.op.from);
      ops.push(reverse.op);
      steps.push({ type: reverse.op.op, path: display(reverse.op.path || reverse.op.to), ...(reverse.op.from ? { from: display(reverse.op.from) } : {}) });
    }
    return { id: unit.id, title: unit.title, steps, ops, checks, conflict, unrestorable };
  }

  async function planOpRestore(entry, units, select) {
    const backupGroup = path.join(backupDirectory, `${timestamp(now())}-restore`);
    const planned = [];
    for (const unit of units) planned.push(await planUnit(unit, backupGroup));
    for (const unit of planned) {
      unit.selected = !unit.unrestorable && (select ? select.includes(unit.id) : !unit.conflict);
    }
    if (!planned.some((unit) => unit.selected)) {
      // Each unit row carries its own conflict or reason; warnings never repeat them.
      const explained = planned.some((unit) => unit.unrestorable || unit.conflict);
      return { planId: null, historyId: entry.id, units: planned.map(publicUnit), steps: [], warnings: explained ? [] : ["没有可撤销的改动。"], message: "没有可以直接撤销的项目；有冲突的项目可以逐项选择后再生成计划。" };
    }
    const overwritten = planned.filter((unit) => unit.selected && unit.conflict).length;
    const planId = remember({ kind: "restore", historyId: entry.id, entry, units: planned.filter((unit) => unit.selected), backupGroup });
    return {
      planId,
      historyId: entry.id,
      units: planned.map(publicUnit),
      steps: planned.filter((unit) => unit.selected).flatMap((unit) => unit.steps),
      // One summary for the plan; the per-unit conflict text lives on the unit only.
      warnings: overwritten ? [`选中的 ${overwritten} 项在那次操作之后又被改动过，恢复会覆盖这些改动（当前内容会先备份）。`] : [],
      expiresAt: new Date(now() + RESTORE_PLAN_TTL_MS).toISOString(),
    };
  }

  const publicUnit = (unit) => ({ id: unit.id, title: unit.title, selected: Boolean(unit.selected), ...(unit.conflict ? { conflict: unit.conflict } : {}), ...(unit.unrestorable ? { unrestorable: unit.unrestorable } : {}), steps: unit.steps });

  async function applyOpRestore(stored) {
    const done = [];
    for (const unit of stored.units) {
      for (const check of unit.checks) {
        if ((await fingerprint(check.path)) !== check.current) throw new LibraryError(409, `${display(check.path)} 在生成计划后有变化，请重新生成恢复计划。`, "stale-plan");
      }
    }
    for (const unit of stored.units) {
      if (unit.trashId) {
        const result = await restoreTrash({ trashId: unit.trashId, stateDirectory, homeDirectory, allowedRoots: await allowedRoots(), display, stamp: timestamp(now()) });
        done.push({ id: unit.id, title: unit.title, ops: [], restoredTrash: result.trashId });
        continue;
      }
      // Each unit is all-or-nothing; the reverse ops back up what they overwrite.
      await runOps(unit.ops, { homeDirectory, display, backupGroup: stored.backupGroup });
      done.push({ id: unit.id, title: unit.title, ops: (await Promise.all(unit.ops.map((op) => recordOp(op, display)))).filter(Boolean) });
    }
    const record = {
      id: createHash("sha1").update(`${now()}:restore:${stored.historyId}`).digest("hex").slice(0, 12),
      type: "restore",
      restoredFrom: stored.historyId,
      skillName: stored.entry.skillName || null,
      units: done.filter((unit) => unit.ops.length),
      createdAt: new Date(now()).toISOString(),
    };
    await appendHistory(record);
    return { planId: stored.planId, restoredUnits: done.map((unit) => ({ id: unit.id, title: unit.title })), historyEntry: record };
  }

  async function listHistory(limit = 50) {
    await homesReady;
    const count = Math.min(HISTORY_LIMIT, Math.max(1, Number.parseInt(String(limit), 10) || 50));
    return { entries: await Promise.all((await readEntries()).slice(0, count).map(normalize)) };
  }

  const remember = (stored) => plans.remember(stored);
  const takePlan = (planId, kind) => plans.take(planId, kind);

  async function allowedRoots() {
    const agents = await getAgents();
    return [...new Set([...agents.flatMap((agent) => agent.paths), path.join(homeDirectory, ".agents", "skills")])];
  }

  async function planRestore({ historyId, select = null }) {
    await homesReady;
    const entry = (await readEntries()).find((item) => item.id === historyId);
    if (!entry) throw new LibraryError(404, "没有找到这条历史记录。", "not-found");
    const units = opUnits(entry);
    if (units) return planOpRestore(entry, units, Array.isArray(select) ? select : null);
    if (entry.type === "uninstall" && entry.trashId) {
      const manifest = await readTrashManifest(stateDirectory, entry.trashId);
      const planId = remember({ kind: "restore", historyId, trashId: entry.trashId, steps: [] });
      return { planId, historyId, steps: [{ type: "restore-trash", target: display(manifest.originalPath), trashId: entry.trashId }], warnings: [] };
    }
    if (!Array.isArray(entry.actions) || !entry.actions.length) throw new LibraryError(409, "这条记录没有可恢复的写入（旧版本记录不含路径）。", "refused");
    const steps = [];
    const warnings = [];
    const seen = new Set();
    for (const action of entry.actions) {
      const target = expand(action.realDestination);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      const currentHash = (await exists(target)) ? await contentHash(target) : null;
      if (action.afterHash && currentHash !== action.afterHash) warnings.push(`${display(target)} 在那次操作之后又被修改过，恢复会覆盖这些修改（当前内容会先备份）。`);
      if (action.action === "replace") {
        const backup = expand(action.backup);
        if (!(await exists(backup))) throw new LibraryError(409, `备份 ${action.backup} 已不存在，无法恢复。`, "backup-missing");
        steps.push({ type: "restore-backup", agentId: action.agentId, target, backup, currentHash });
      } else if (action.action === "create" && currentHash !== null) {
        steps.push({ type: "trash-created", agentId: action.agentId, target, currentHash });
      }
    }
    if (!steps.length) throw new LibraryError(409, "没有需要恢复的内容。", "nothing-to-do");
    const planId = remember({ kind: "restore", historyId, entry, steps });
    return {
      planId,
      historyId,
      steps: steps.map((step) => ({ type: step.type, agentId: step.agentId, target: display(step.target), ...(step.backup ? { from: display(step.backup) } : {}), precondition: step.currentHash ? step.currentHash.slice(0, 16) : "absent" })),
      warnings,
      expiresAt: new Date(now() + RESTORE_PLAN_TTL_MS).toISOString(),
    };
  }

  async function applyRestore({ planId, confirm }) {
    await homesReady;
    if (confirm !== true) throw new LibraryError(400, "需要明确确认后才能恢复。", "confirm-required");
    const stored = takePlan(planId, "restore");
    if (stored.units) return applyOpRestore(stored);
    if (stored.trashId) {
      const result = await restoreTrash({ trashId: stored.trashId, stateDirectory, homeDirectory, allowedRoots: await allowedRoots(), display, stamp: timestamp(now()) });
      await appendHistory({ id: createHash("sha1").update(`${now()}:restore:${stored.trashId}`).digest("hex").slice(0, 12), type: "restore", restoredFrom: stored.historyId, skillName: result.name, createdAt: new Date(now()).toISOString() });
      return { planId: stored.planId, restored: [result] };
    }
    // Preconditions first: nothing may have changed since the plan was made.
    for (const step of stored.steps) {
      const current = (await exists(step.target)) ? await contentHash(step.target) : null;
      if (current !== step.currentHash) throw new LibraryError(409, `${display(step.target)} 在生成计划后有变化，请重新生成恢复计划。`, "stale-plan");
    }
    const group = path.join(backupDirectory, `${timestamp(now())}-restore`);
    const actions = [];
    const trashed = [];
    for (const step of stored.steps) {
      await assertSafeWrite(step.target, homeDirectory);
      if (step.type === "restore-backup") {
        const present = await exists(step.target);
        const stateBackup = present ? path.join(group, step.agentId, path.basename(step.target)) : null;
        if (stateBackup) await assertSafeWrite(stateBackup, homeDirectory);
        await materialize({ sourcePath: step.backup, destinationPath: step.target, backupPath: stateBackup });
        actions.push({ agentId: step.agentId, action: present ? "replace" : "create", mode: "copy", destination: display(step.target), realDestination: display(step.target), backup: stateBackup ? display(stateBackup) : null, afterHash: await contentHash(step.target) });
      } else {
        const trashId = `${timestamp(now())}-${step.agentId}-${path.basename(step.target)}`.replace(/[^\w.@-]/gu, "_");
        await runOps(trashOps({ stateDirectory, trashId, name: path.basename(step.target), target: step.target, kind: "real", source: "restore", agentId: step.agentId, removedAt: new Date(now()).toISOString() }), { homeDirectory, display, backupGroup: group });
        trashed.push({ agentId: step.agentId, path: display(step.target), trashId });
      }
    }
    const record = {
      id: createHash("sha1").update(`${now()}:restore:${stored.historyId}`).digest("hex").slice(0, 12),
      type: "restore",
      restoredFrom: stored.historyId,
      skillName: stored.entry.skillName || stored.entry.title || null,
      actions,
      trashed,
      createdAt: new Date(now()).toISOString(),
    };
    await appendHistory(record);
    return { planId: stored.planId, restored: actions.map((action) => ({ agentId: action.agentId, path: action.realDestination, backup: action.backup })), trashed, historyEntry: record };
  }

  async function planUninstall({ skillId, agentId }) {
    await homesReady;
    const scan = await getScan();
    const skill = scan.skills.find((item) => item.id === skillId);
    const instance = skill?.instances.find((item) => item.agentId === agentId);
    if (!instance) throw new LibraryError(404, "没有找到这个 Agent 中的技能。", "not-found");
    const nameOf = (id) => scan.agents.find((agent) => agent.id === id)?.name || id;
    const agentName = nameOf(agentId);
    if (instance.readOnly || instance.managed) {
      throw new LibraryError(409, `这是 ${agentName} 的${instance.sourceLabel || "托管"}技能，由 ${agentName} 或同步工具自己管理，不能在这里卸载。`, "refused");
    }
    const target = expand(instance.path);
    const roots = await allowedRoots();
    if (!roots.some((root) => isStrictlyWithin(root, target))) throw new LibraryError(409, "这个技能不在 Agent 的技能目录内，已拒绝卸载。", "refused");
    const info = await lstat(target).catch(() => null);
    if (!info) throw new LibraryError(404, "技能目录已不存在，请重新扫描。", "not-found");
    const isLink = info.isSymbolicLink();
    // A real folder disappears for every Agent that reaches it; a link only for viewers of that path.
    const alsoAffects = [
      ...new Set(
        scan.skills
          .flatMap((item) => item.instances)
          .filter((other) => other.agentId !== agentId && (isLink ? expand(other.path) === target : other.realPathId === instance.realPathId))
          .map((other) => other.agentId),
      ),
    ];
    const name = path.basename(target);
    const trashId = `${timestamp(now())}-${agentId}-${name}`.replace(/[^\w.@-]/gu, "_");
    const ops = trashOps({ stateDirectory, trashId, name, target, kind: isLink ? "link" : "real", linkTarget: isLink ? await readlink(target) : null, source: "uninstall", agentId, removedAt: new Date(now()).toISOString() });
    const planId = remember({ kind: "uninstall", ops, trashId, skillName: skill.name, agentId, isLink });
    return {
      planId,
      skillId,
      agentId,
      kind: isLink ? "link" : "real",
      steps: [isLink ? { type: "unlink", path: display(target), description: "只移除链接，不动它指向的目录。" } : { type: "move-to-trash", path: display(target), to: display(path.join(stateDirectory, "trash", trashId, name)) }],
      alsoAffects,
      ...(alsoAffects.length ? { warning: `${alsoAffects.map(nameOf).join("、")} 也会因此看不到这个技能。` } : {}),
      expiresAt: new Date(now() + RESTORE_PLAN_TTL_MS).toISOString(),
    };
  }

  async function applyUninstall({ planId, confirm }) {
    await homesReady;
    if (confirm !== true) throw new LibraryError(400, "需要明确确认后才能卸载。", "confirm-required");
    const stored = takePlan(planId, "uninstall");
    await runOps(stored.ops, { homeDirectory, display, backupGroup: path.join(backupDirectory, `${timestamp(now())}-uninstall`) });
    const record = { id: createHash("sha1").update(`${now()}:uninstall:${stored.trashId}`).digest("hex").slice(0, 12), type: "uninstall", skillName: stored.skillName, agentId: stored.agentId, trashId: stored.trashId, kind: stored.isLink ? "link" : "real", createdAt: new Date(now()).toISOString() };
    await appendHistory(record);
    return { planId: stored.planId, trashId: stored.trashId, historyEntry: record };
  }

  async function trashRestore({ trashId }) {
    await homesReady;
    const result = await restoreTrash({ trashId, stateDirectory, homeDirectory, allowedRoots: await allowedRoots(), display, stamp: timestamp(now()) });
    await appendHistory({ id: createHash("sha1").update(`${now()}:trash:${trashId}`).digest("hex").slice(0, 12), type: "restore", restoredFrom: trashId, skillName: result.name, createdAt: new Date(now()).toISOString() });
    return result;
  }

  return {
    listHistory,
    planRestore,
    applyRestore,
    planUninstall,
    applyUninstall,
    listTrash: async () => {
      await homesReady;
      return { items: await listTrash(stateDirectory, display) };
    },
    trashRestore,
  };
}
