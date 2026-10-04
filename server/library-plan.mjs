import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { classifyPath, relativeLinkTarget } from "./fs-links.mjs";
import { compactHomePath, homeVariants, isWithin, object } from "./fs-safe.mjs";
import { assertSafeWrite } from "./home-guard.mjs";
import { tierOf } from "./library-agents.mjs";
import { LibraryError, runOps } from "./library-ops.mjs";
import { createHasher, readLibrary } from "./library.mjs";
import { writeLibraryLock } from "./library-lock.mjs";
import { disableOps } from "./library-switches.mjs";

/**
 * Library plans: adopt, link, unlink, disable, remove and the batch clean-up. A plan is
 * a list of items, each a small transaction of reversible ops; nothing runs without a plan
 * from this process (10 minutes, single use) and an explicit confirmation. After applying,
 * visibility is re-checked and failing items are rolled back.
 */

export const LIBRARY_PLAN_TTL_MS = 10 * 60_000;
const CHOICES = ["keep-library", "use-this", "save-as", "skip"];
const NAME = /^[\p{L}\p{N}_.@+ -]{1,128}$/u;

const timestamp = (now) => new Date(now).toISOString().replace(/[:.]/gu, "-");

export function createLibraryManager(context) {
  const plans = new Map();
  const now = context.now || (() => Date.now());
  let homes = context.homes;
  const homesReady = homeVariants(context.homeDirectory).then((variants) => {
    homes = [...new Set([...context.homes, ...variants])];
  });
  const display = (value) => compactHomePath(value, homes);

  async function snapshot() {
    const config = await context.getConfig();
    const library = await readLibrary({ config, homeDirectory: context.homeDirectory, homes: context.homes, stateDirectory: context.stateDirectory, hasher: createHasher() });
    return { config, library, ...library.internal };
  }

  // -------------------------------------------------------------------------
  // Item builders. Each returns { id, title, kind, skill, choices?, choice, ops, expect }.

  function linkOps(agent, linkPath, libraryEntryPath) {
    return [{ op: "link", path: linkPath, relativeTarget: relativeLinkTarget(linkPath, libraryEntryPath), absoluteTarget: libraryEntryPath }];
  }

  /** What to leave at an agent's own location once the library holds the skill. */
  function fanBackOps(agent, location, libraryEntryPath, state) {
    const tier = tierOf(agent.agentId);
    if (tier === "link") return linkOps(agent, location, libraryEntryPath);
    if (tier === "config" && !(agent.switches.externalDirs || []).includes(state.realRoot)) return linkOps(agent, location, libraryEntryPath);
    return [];
  }

  const backupPath = (group, agentId, name) => path.join(context.backupDirectory, group, agentId, name);

  /** A library link pointing into an agent's own folder: move the real folder into the library. */
  function adoptReverseLink(entry, state, group) {
    const owner = state.agents.find((agent) => agent.realOwnDirs.some((directory) => path.dirname(entry.real) === directory));
    if (!owner || entry.gitCheckout) {
      return { id: `external:${entry.name}`, title: `${entry.name}：链接指向 ${display(entry.real)}，由外部管理，不搬动`, kind: "external", skill: entry.name, choice: "skip", ops: [], expect: [] };
    }
    const ops = [
      { op: "backup", from: entry.real, to: backupPath(group, owner.agentId, entry.name) },
      { op: "unlink", path: entry.path },
      { op: "move", from: entry.real, to: entry.path },
    ];
    // Links elsewhere that pointed at the old real folder now point at the library.
    for (const agent of state.agents) {
      for (const directory of agent.ownDirs) {
        const candidate = path.join(directory, entry.name);
        if (candidate === entry.real) continue;
        if (state.linkTargets.get(candidate) === entry.real) ops.push({ op: "unlink", path: candidate }, ...linkOps(agent, candidate, entry.path));
      }
    }
    ops.push(...fanBackOps(owner, entry.real, entry.path, state));
    return {
      id: `adopt-link:${entry.name}`,
      title: `收编 ${entry.name}（从 ${display(entry.real)} 移入库）`,
      kind: "adopt",
      skill: entry.name,
      choices: ["adopt", "skip"],
      choice: "adopt",
      ops,
      expect: state.agents.filter((agent) => entry.fanout?.[agent.agentId]?.state === "visible" && tierOf(agent.agentId) !== "none").map((agent) => agent.agentId),
    };
  }

  /** An agent's own copy next to a library entry with the same name. */
  async function copyItem(agent, location, entry, state, group, requested) {
    const classified = await classifyPath(location, entry.path);
    const tier = tierOf(agent.agentId);
    const base = { skill: entry.name, agentId: agent.agentId };
    if (classified.kind === "absent" || classified.kind === "link-to-library") return null;
    if (classified.kind === "foreign-link" && (await state.isExternal(classified.real))) return null;
    if (classified.kind === "broken-link") {
      return { ...base, id: `relink:${agent.agentId}:${entry.name}`, title: `${agent.name}：替换失效链接 ${entry.name}`, kind: "link", choice: "link", choices: ["link", "skip"], ops: [{ op: "unlink", path: location }, ...fanBackOps(agent, location, entry.path, state)], expect: [agent.agentId] };
    }
    const identical =
      (classified.kind === "real-dir" || classified.kind === "foreign-link") && entry.hash && (await state.hasher(location)) === entry.hash;
    const removeCopy = classified.kind === "foreign-link" ? [{ op: "unlink", path: location }] : [{ op: "stash", path: location, to: backupPath(group, agent.agentId, entry.name) }];
    const backAgain = fanBackOps(agent, location, entry.path, state);
    if (identical) {
      return {
        ...base,
        id: `dedupe:${agent.agentId}:${entry.name}`,
        title: tier === "native" ? `${agent.name}：删除与库相同的副本 ${entry.name}（先备份）` : `${agent.name}：${entry.name} 改为链接到库`,
        kind: tier === "native" ? "dedupe" : "link",
        choices: ["link", "skip"],
        choice: "link",
        ops: [...removeCopy, ...backAgain],
        expect: [agent.agentId],
      };
    }
    const choice = CHOICES.includes(requested) ? requested : "skip";
    const ops = {
      "keep-library": [...removeCopy, ...backAgain],
      "use-this": classified.kind === "real-dir" ? [{ op: "stash", path: entry.path, to: backupPath(group, "library", entry.name) }, { op: "move", from: location, to: entry.path }, ...backAgain] : [],
      "save-as": classified.kind === "real-dir" ? [{ op: "move", from: location, to: `${entry.path}@${agent.agentId}` }, ...backAgain] : [],
      skip: [],
    }[choice];
    return {
      ...base,
      id: `conflict:${agent.agentId}:${entry.name}`,
      title: `${agent.name}：${entry.name} 与库内容不同`,
      kind: "conflict",
      choices: classified.kind === "real-dir" ? CHOICES : ["keep-library", "skip"],
      choice,
      requiresChoice: !CHOICES.includes(requested),
      ops,
      expect: choice === "skip" ? [] : [agent.agentId],
    };
  }

  /** A real folder in an agent's own folder that the library does not have yet. */
  function adoptCandidate(agent, location, name, state, group) {
    const target = path.join(state.libraryPath, name);
    return {
      id: `adopt:${agent.agentId}:${name}`,
      title: `收编 ${agent.name} 的 ${name} 到库`,
      kind: "adopt",
      skill: name,
      agentId: agent.agentId,
      choices: ["adopt", "skip"],
      choice: "adopt",
      ops: [{ op: "backup", from: location, to: backupPath(group, agent.agentId, name) }, { op: "move", from: location, to: target }, ...fanBackOps(agent, location, target, state)],
      expect: [agent.agentId],
    };
  }

  async function hermesConfigItem(agent, state) {
    if ((agent.switches.externalDirs || []).includes(state.realRoot)) return null;
    const hermes = await context.findCommand("hermes");
    const current = (state.hermesConfiguredDirs || []).filter((value) => typeof value === "string");
    const next = [...new Set([...current, "~/.agents/skills"])];
    return {
      id: "hermes-external-dirs",
      title: "让 Hermes 读取技能库（skills.external_dirs）",
      kind: "config",
      skill: null,
      agentId: "hermes",
      choices: ["configure", "skip"],
      choice: "skip",
      ops: hermes ? [{ op: "command", file: hermes, args: ["config", "set", "skills.external_dirs", JSON.stringify(next)] }] : await context.hermesYamlOps(next),
      expect: [],
    };
  }

  async function prepareState(raw) {
    const state = { ...raw, hasher: createHasher(), linkTargets: new Map() };
    for (const agent of state.agents) {
      for (const directory of agent.ownDirs) {
        for (const name of await readdir(directory).catch(() => [])) {
          const location = path.join(directory, name);
          const classified = await classifyPath(location, null);
          if (classified.real) state.linkTargets.set(location, classified.real);
        }
      }
    }
    state.isExternal = async (real) => Boolean(real) && (await context.isExternalPath(real));
    state.hermesConfiguredDirs = await context.hermesConfiguredDirs();
    return state;
  }

  async function buildItems(input, raw, group) {
    const state = await prepareState(raw);
    const entries = new Map(state.entries.map((entry) => [entry.name, entry]));
    const agents = new Map(state.agents.map((agent) => [agent.agentId, agent]));
    const choices = object(input.choices);
    const items = [];
    const skill = typeof input.skill === "string" && NAME.test(input.skill) ? input.skill : null;
    const targetAgents = (Array.isArray(input.agents) ? input.agents : state.agents.filter((agent) => agent.primary).map((agent) => agent.agentId))
      .map((id) => agents.get(id))
      .filter(Boolean);
    const own = (agent, name) => agent.ownDirs.map((directory) => path.join(directory, name));

    switch (input.action) {
      case "adopt": {
        if (!skill) throw new LibraryError(400, "缺少技能名称。");
        const entry = entries.get(skill);
        if (entry?.kind === "link-external") items.push(adoptReverseLink(entry, state, group));
        else if (entry?.kind === "real") {
          for (const agent of targetAgents) for (const location of own(agent, skill)) {
            const item = await copyItem(agent, location, entry, state, group, input.choice);
            if (item) items.push(item);
          }
        } else if (!entry) {
          let found = null;
          for (const agent of input.from ? [agents.get(input.from)].filter(Boolean) : state.agents) {
            for (const location of own(agent, skill)) {
              if (!found && (await classifyPath(location, null)).kind === "real-dir") found = { agent, location };
            }
          }
          if (!found) throw new LibraryError(404, "没有找到可收编的技能目录。");
          items.push(adoptCandidate(found.agent, found.location, skill, state, group));
        }
        break;
      }
      case "link": {
        const entry = entries.get(skill);
        if (!entry || entry.kind === "broken") throw new LibraryError(404, "库中没有这个技能。");
        for (const agent of targetAgents) {
          const tier = tierOf(agent.agentId);
          if (tier === "config") {
            const item = await hermesConfigItem(agent, state);
            if (item) items.push({ ...item, choice: "configure" });
          }
          const locations = own(agent, skill);
          let handled = false;
          for (const location of locations) {
            const item = await copyItem(agent, location, entry, state, group, input.choice);
            if (item) {
              items.push(item);
              handled = true;
            }
          }
          const linkPath = locations[0];
          if (!handled && tier === "link" && linkPath && (await classifyPath(linkPath, entry.path)).kind === "absent") {
            items.push({ id: `link:${agent.agentId}:${skill}`, title: `${agent.name}：链接 ${skill} 到库`, kind: "link", skill, agentId: agent.agentId, choices: ["link", "skip"], choice: "link", ops: linkOps(agent, linkPath, entry.path), expect: [agent.agentId] });
          }
        }
        break;
      }
      case "unlink": {
        for (const agent of targetAgents) for (const location of own(agent, skill || "")) {
          if (skill && (await classifyPath(location, entries.get(skill)?.path)).kind === "link-to-library") {
            items.push({ id: `unlink:${agent.agentId}:${skill}`, title: `${agent.name}：移除 ${skill} 的链接`, kind: "unlink", skill, agentId: agent.agentId, choices: ["unlink", "skip"], choice: "unlink", ops: [{ op: "unlink", path: location }], expect: [] });
          }
        }
        break;
      }
      case "disable": {
        if (!skill) throw new LibraryError(400, "缺少技能名称。");
        for (const agent of targetAgents) {
          const item = await disableOps(agent, skill, { ...context, group, libraryEntry: entries.get(skill) });
          if (item) items.push(item);
        }
        break;
      }
      case "remove": {
        const entry = entries.get(skill);
        if (!entry) throw new LibraryError(404, "库中没有这个技能。");
        const trashId = `${group}-${skill}`.replace(/[^\w.@-]/gu, "_");
        const trashRoot = path.join(context.stateDirectory, "trash", trashId);
        const links = [];
        const ops = [];
        for (const agent of state.agents) for (const location of own(agent, skill)) {
          if ((await classifyPath(location, entry.path)).kind === "link-to-library") {
            links.push({ path: location, target: relativeLinkTarget(location, entry.path) });
            ops.push({ op: "unlink", path: location });
          }
        }
        ops.push(entry.kind === "real" ? { op: "stash", path: entry.path, to: path.join(trashRoot, skill) } : { op: "unlink", path: entry.path });
        ops.push({
          op: "write",
          path: path.join(trashRoot, "manifest.json"),
          content: `${JSON.stringify({ trashId, name: skill, originalPath: entry.path, kind: entry.kind, linkTarget: entry.kind === "real" ? null : entry.real, links, removedAt: new Date(now()).toISOString() }, null, 2)}\n`,
          backup: path.join(trashRoot, "manifest.previous.json"),
        });
        items.push({ id: `remove:${skill}`, title: `从库中移除 ${skill}（移到回收站，可恢复）`, kind: "remove", skill, choices: ["remove", "skip"], choice: "remove", ops, expect: [], trashId });
        break;
      }
      case "batch": {
        for (const entry of state.entries) {
          if (entry.kind === "link-external") items.push(adoptReverseLink(entry, state, group));
          if (entry.gitCheckout) items.push({ id: `external:${entry.name}`, title: `${entry.name} 是 git 检出，标为外部托管，不搬动（用它自己的升级方式更新）`, kind: "external", skill: entry.name, choice: "skip", ops: [], expect: [] });
        }
        for (const agent of state.agents.filter((item) => item.primary && ["link", "native"].includes(item.tier))) {
          for (const entry of state.entries.filter((item) => item.kind === "real" && !item.gitCheckout)) {
            for (const location of own(agent, entry.name)) {
              if (entry.gitCheckout || (await state.isExternal(location))) continue;
              const item = await copyItem(agent, location, entry, state, group, choices[`conflict:${agent.agentId}:${entry.name}`]);
              if (item) items.push(item);
            }
          }
        }
        const hermes = state.agents.find((agent) => agent.agentId === "hermes" && agent.primary);
        if (hermes) {
          const item = await hermesConfigItem(hermes, state);
          if (item) items.push(item);
        }
        break;
      }
      default:
        throw new LibraryError(400, "未知的操作。");
    }
    // Per-item choices from the request: "skip" drops an item; an opt-in item (default
    // "skip", e.g. the Hermes config change) runs when its action is chosen. Conflicts take
    // their choice in copyItem.
    for (const item of items) {
      const requested = choices[item.id];
      if (!requested || item.kind === "conflict" || !item.choices?.includes(requested)) continue;
      if (requested === "skip") Object.assign(item, { choice: "skip", ops: [], expect: [] });
      else item.choice = requested;
    }
    return { items, state };
  }

  function publicStep(op) {
    const step = { type: op.op };
    if (op.path) step.path = display(op.path);
    if (op.from) step.from = display(op.from);
    if (op.to) step.to = display(op.to);
    if (op.relativeTarget) step.target = op.relativeTarget;
    if (op.op === "command") step.command = [display(op.file), ...op.args].join(" ");
    if (op.op === "write" && op.diff) step.diff = op.diff;
    return step;
  }

  async function plan(input = {}) {
    await homesReady;
    const raw = await snapshot();
    const group = timestamp(now());
    const { items } = await buildItems(input, raw, group);
    const active = items.filter((item) => item.choice !== "skip" && item.ops.length);
    const publicItems = items.map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      skill: item.skill,
      ...(item.agentId ? { agentId: item.agentId } : {}),
      ...(item.choices ? { choices: item.choices } : {}),
      choice: item.choice,
      ...(item.requiresChoice ? { requiresChoice: true } : {}),
      steps: item.choice === "skip" ? [] : item.ops.map(publicStep),
    }));
    const summary = {};
    for (const item of items) summary[item.kind] = (summary[item.kind] || 0) + 1;
    const needsChoice = items.filter((item) => item.requiresChoice).length;
    if (!active.length) {
      return { planId: null, action: input.action, items: publicItems, summary, needsChoice, message: needsChoice ? "需要先为冲突项选择处理方式。" : "没有需要执行的改动。" };
    }
    for (const [id, stored] of plans) if (now() - stored.createdAt > LIBRARY_PLAN_TTL_MS) plans.delete(id);
    const planId = randomUUID();
    plans.set(planId, { planId, createdAt: now(), action: input.action, items: active, group });
    return { planId, action: input.action, items: publicItems, summary, needsChoice, expiresAt: new Date(now() + LIBRARY_PLAN_TTL_MS).toISOString() };
  }

  async function apply({ planId, confirm }) {
    await homesReady;
    if (confirm !== true) throw new LibraryError(400, "需要明确确认后才能执行。");
    const stored = plans.get(String(planId || ""));
    if (!stored || now() - stored.createdAt > LIBRARY_PLAN_TTL_MS) {
      plans.delete(String(planId || ""));
      throw new LibraryError(404, "计划不存在或已过期（10 分钟），请重新生成。");
    }
    plans.delete(stored.planId);
    const opContext = {
      homeDirectory: context.homeDirectory,
      display,
      backupGroup: path.join(context.backupDirectory, stored.group),
      platform: context.platform,
      fsImpl: context.fsImpl,
      run: context.run,
      commandEnv: context.commandEnv,
    };
    const results = [];
    for (const item of stored.items) {
      try {
        const undo = await runOps(item.ops, opContext);
        results.push({ item, undo, status: "applied" });
      } catch (error) {
        results.push({ item, status: "failed", error: String(error?.message || error).slice(0, 300) });
      }
    }
    // Re-verify visibility once, then roll back items whose Agents lost the skill.
    const after = await snapshot();
    const byName = new Map(after.library.entries.map((entry) => [entry.name, entry]));
    for (const result of [...results].reverse()) {
      if (result.status !== "applied") continue;
      const entry = byName.get(result.item.skill);
      const lost = result.item.expect.filter((agentId) => entry?.fanout?.[agentId]?.state !== "visible");
      if (lost.length) {
        await result.undo();
        Object.assign(result, { status: "rolled-back", error: `复验未通过（${lost.join("、")} 看不到该技能），已回滚。` });
      }
    }
    const final = await snapshot();
    await writeLibraryLock({
      stateDirectory: context.stateDirectory,
      homeDirectory: context.homeDirectory,
      library: final.library,
      adopted: results.filter((result) => result.status === "applied" && result.item.kind === "adopt").map((result) => ({ name: result.item.skill, from: result.item.agentId || "library-link" })),
      removed: results.filter((result) => result.status === "applied" && result.item.kind === "remove").map((result) => result.item.skill),
      now: now(),
    });
    const record = { type: "library", action: stored.action, applied: results.filter((r) => r.status === "applied").length, failed: results.filter((r) => r.status !== "applied").length, createdAt: new Date(now()).toISOString() };
    await mkdir(path.dirname(context.historyFile), { recursive: true });
    await appendFile(context.historyFile, `${JSON.stringify(record)}\n`, "utf8");
    return {
      planId: stored.planId,
      results: results.map((result) => ({ id: result.item.id, title: result.item.title, status: result.status, ...(result.error ? { error: result.error } : {}), ...(result.item.trashId && result.status === "applied" ? { trashId: result.item.trashId } : {}) })),
      backups: display(path.join(context.backupDirectory, stored.group)),
      visibility: Object.fromEntries(
        [...new Set(results.map((result) => result.item.skill).filter(Boolean))].map((name) => [name, byName.get(name)?.fanout || null]),
      ),
      historyEntry: record,
    };
  }

  /** Puts a removed library entry back and recreates its links. */
  async function restore({ trashId }) {
    await homesReady;
    if (!/^[\w.@-]{1,200}$/u.test(String(trashId || ""))) throw new LibraryError(400, "回收站条目无效。");
    const root = path.join(context.stateDirectory, "trash", trashId);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
    } catch {
      throw new LibraryError(404, "回收站中没有这个条目。");
    }
    const libraryRoot = path.join(context.homeDirectory, ".agents", "skills");
    if (!isWithin(libraryRoot, manifest.originalPath)) throw new LibraryError(400, "回收站条目的原位置不在库内。");
    if ((await classifyPath(manifest.originalPath, null)).kind !== "absent") throw new LibraryError(409, "原位置已有同名条目，请先处理。");
    await assertSafeWrite(manifest.originalPath, context.homeDirectory);
    if (manifest.kind === "real") await rename(path.join(root, manifest.name), manifest.originalPath);
    else if (manifest.linkTarget) await symlink(manifest.linkTarget, manifest.originalPath, "dir");
    const restored = [];
    for (const link of manifest.links || []) {
      if ((await classifyPath(link.path, null)).kind !== "absent") continue;
      await assertSafeWrite(link.path, context.homeDirectory);
      await symlink(link.target, link.path, "dir");
      restored.push(display(link.path));
    }
    await rename(root, `${root}.restored-${timestamp(now())}`);
    return { trashId, name: manifest.name, path: display(manifest.originalPath), links: restored };
  }

  async function listTrash() {
    const root = path.join(context.stateDirectory, "trash");
    const items = [];
    for (const name of (await readdir(root).catch(() => [])).filter((entry) => !entry.includes(".restored-"))) {
      try {
        const manifest = JSON.parse(await readFile(path.join(root, name, "manifest.json"), "utf8"));
        items.push({ trashId: manifest.trashId, name: manifest.name, removedAt: manifest.removedAt, links: (manifest.links || []).length });
      } catch {
        // Not a trash entry.
      }
    }
    return items;
  }

  return { plan, apply, restore, listTrash };
}
