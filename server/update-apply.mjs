import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { compactHomeInText, compactHomePath, isWithin, scrubTokens } from "./fs-safe.mjs";
import { gitBlobSha, installExclude, localTreeSha } from "./git-tree.mjs";
import { createWriteTracker } from "./sync-targets.mjs";
import { createPlanStore } from "./plan-store.mjs";

/**
 * Update execution. Nothing runs without a plan created by this process in the last ten
 * minutes and an explicit confirmation. Skill Control updates skills-cli GitHub skills
 * itself (download → verify the git tree hash → backup → atomic replace → lock rewrite);
 * everything else is delegated to the owning CLI with an argument array, a timeout and a
 * redacted, bounded output tail.
 */

export const PLAN_TTL_MS = 10 * 60_000;
const MAX_FILES = 1_500;
const MAX_FILE_BYTES = 25_000_000;
const MAX_TOTAL_BYTES = 100_000_000;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL = 4_000;
const NAME = /^[\w.@+-]{1,128}$/u;

export class UpdateError extends Error {
  constructor(statusCode, message, code = null) {
    super(message);
    this.statusCode = statusCode;
    // Machine-readable reason for the UI (see docs/ARCHITECTURE.md, "Error codes").
    if (code) this.code = code;
  }
}

const timestampLabel = (now) => new Date(now).toISOString().replace(/[:.]/gu, "-");

async function blobShas(directory) {
  const result = new Map();
  async function visit(current, relative) {
    for (const dirent of await readdir(current, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${dirent.name}` : dirent.name;
      if (dirent.name === ".git" || installExclude(childRelative, dirent.isDirectory())) continue;
      const full = path.join(current, dirent.name);
      if (dirent.isDirectory()) await visit(full, childRelative);
      else if (dirent.isFile()) result.set(childRelative, gitBlobSha(await readFile(full)).toString("hex"));
    }
  }
  await visit(directory, "");
  return result;
}

function diffFiles(local, upstreamFiles) {
  const upstream = new Map(upstreamFiles.map((file) => [file.path, file.sha]));
  const added = [...upstream.keys()].filter((file) => !local.has(file));
  const removed = [...local.keys()].filter((file) => !upstream.has(file));
  const modified = [...upstream.keys()].filter((file) => local.has(file) && local.get(file) !== upstream.get(file));
  const cap = (list) => list.sort().slice(0, 200);
  return { added: cap(added), modified: cap(modified), removed: cap(removed) };
}

function redactTail(value, homes) {
  const tail = String(value || "").slice(-OUTPUT_TAIL);
  return scrubTokens(compactHomeInText(tail, homes)).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

/** Runs one command; never through a shell. */
export function runCommand(file, args, { cwd, timeoutMs = COMMAND_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env }, (error, stdout, stderr) => {
      resolve({ exitCode: error ? (typeof error.code === "number" ? error.code : error.killed ? "timeout" : 1) : 0, stdout, stderr });
    });
  });
}

/**
 * `context`: { homeDirectory, homes, stateDirectory, backupDirectory, historyFile,
 *   findCommand(name), getAgents() (config agents, absolute roots), transportFactory(maxRequests),
 *   allowedCommandRoots (optional: only binaries inside these folders may run),
 *   materialize({ sourcePath, destinationPath, backupPath }), run(file, args, options), now() }
 */
export function createUpdateExecutor(context) {
  const now = context.now || (() => Date.now());
  const plans = createPlanStore({ ttlMs: PLAN_TTL_MS, now, label: "更新计划" });
  const run = context.run || runCommand;
  const display = (value) => compactHomePath(value, context.homes);

  const remember = (plan) => plans.remember(plan);

  async function planSelf(unit, view, facts, cache, choice) {
    const upstream = facts?.upstream;
    if (!upstream?.filtered || !upstream.commit) throw new UpdateError(409, "请先检查更新，再生成更新计划。", "check-required");
    if (upstream.unsupported) throw new UpdateError(409, "上游包含软链接或子模块，无法自动更新，请手动处理。", "unsupported");
    if (view.status === "up-to-date") throw new UpdateError(409, "已经是最新版本。", "up-to-date");
    const folderFacts = cache.repos[unit.check.repo]?.folders?.[unit.check.folder];
    const files = (folderFacts?.files || []).filter((file) => !file.path.split("/").some((part, index, parts) => installExclude(parts.slice(0, index + 1).join("/"), index < parts.length - 1)));
    if (!folderFacts?.files || files.length === 0 || files.length > MAX_FILES) throw new UpdateError(409, "上游文件列表不可用或过大，无法自动更新。", "too-large");
    const total = files.reduce((sum, file) => sum + (file.size || 0), 0);
    if (total > MAX_TOTAL_BYTES || files.some((file) => (file.size || 0) > MAX_FILE_BYTES)) throw new UpdateError(409, "上游内容超过大小上限，无法自动更新。", "too-large");
    const modified = view.status === "conflict" || view.status === "locally-modified";
    const choices = ["keep-local", "overwrite", "save-as"];
    if (modified && !choices.includes(choice)) {
      return { requiresChoice: true, unitKey: unit.unitKey, status: view.status, choices, message: "本地修改过这个技能，请选择保留本地、覆盖（先备份）或另存为 <名称>@local。" };
    }
    const primary = unit.primaryPath;
    const local = await blobShas(primary);
    const changes = diffFiles(local, files);
    if (choice === "keep-local") {
      const planId = remember({ kind: "none", unitKey: unit.unitKey });
      return { planId, unitKey: unit.unitKey, kind: "none", steps: [{ type: "keep-local", description: "保留本地版本，不做任何改动。" }], changes, expiresAt: new Date(now() + PLAN_TTL_MS).toISOString() };
    }
    const tracker = await createWriteTracker({ agents: await context.getAgents(), expandPath: (value) => value, displayHomeDirectory: context.homeDirectory });
    const group = timestampLabel(now());
    const writes = [];
    const seen = new Set();
    for (const instance of unit.instances) {
      const claim = await tracker.claim(instance.agentId, instance.absolutePath, instance.agentId);
      if (seen.has(claim.writePath)) continue;
      seen.add(claim.writePath);
      writes.push({
        agentId: instance.agentId,
        writePath: claim.writePath,
        backupPath: path.join(context.backupDirectory, group, instance.agentId, path.basename(claim.writePath)),
        alsoVisibleTo: claim.alsoVisibleTo,
      });
    }
    const saveAs = choice === "save-as" ? path.join(path.dirname(primary), `${path.basename(primary)}@local`) : null;
    if (saveAs && (await lstat(saveAs).catch(() => null))) throw new UpdateError(409, `${display(saveAs)} 已存在，请先处理。`, "conflict");
    const steps = [
      { type: "download", description: `从 github.com/${unit.check.repo} 下载 ${files.length} 个文件（提交 ${upstream.commit.slice(0, 7)}），并校验 git 树哈希。` },
      ...(saveAs ? [{ type: "save-as", description: `把本地版本另存为 ${display(saveAs)}。` }] : []),
      ...writes.map((write) => ({ type: "replace", path: display(write.writePath), backup: display(write.backupPath), agentId: write.agentId, alsoVisibleTo: write.alsoVisibleTo })),
      { type: "lock", path: display(unit.lockFile), description: `更新 ${unit.sourceRef.name} 的 skillFolderHash（先备份锁文件）。` },
    ];
    const planId = remember({
      kind: "self",
      unitKey: unit.unitKey,
      repo: unit.check.repo,
      folder: unit.check.folder,
      commit: upstream.commit,
      expected: upstream.filtered,
      upstreamRaw: upstream.raw,
      files,
      writes,
      saveAs,
      primary,
      localHash: unit.local?.hash,
      lockFile: unit.lockFile,
      lockName: unit.sourceRef.name,
      lockBaseline: unit.baseline?.hash || null,
      backupGroup: group,
      title: unit.title,
    });
    return { planId, unitKey: unit.unitKey, kind: "self", steps, changes, expiresAt: new Date(now() + PLAN_TTL_MS).toISOString() };
  }

  async function delegateSteps(unit) {
    const tool = async (name, preferred = null) => {
      const found = preferred || (await context.findCommand(name));
      if (!found) throw new UpdateError(409, `找不到 ${name} 命令，请先安装或把它加入 PATH。`, "missing-command");
      return found;
    };
    switch (unit.sourceType) {
      case "lark-cli": {
        const binary = unit.binaries.find((item) => !item.hermes) || unit.binaries[0];
        return {
          steps: [{ file: await tool("lark-cli", binary?.absolutePath || null), args: ["update", "--json"] }],
          notes: unit.binaries.filter((item) => item.hermes).map((item) => `Hermes 自带的 lark-cli（${item.version || "未知版本"}）不会被这条命令更新。`),
        };
      }
      case "claude-plugin": {
        const { plugin, marketplace, scope } = unit.sourceRef;
        if (!NAME.test(plugin) || !NAME.test(marketplace)) throw new UpdateError(400, "插件名称无效。", "invalid-request");
        const claude = await tool("claude");
        return {
          steps: [
            { file: claude, args: ["plugin", "marketplace", "update", marketplace] },
            { file: claude, args: ["plugin", "update", `${plugin}@${marketplace}`, "--json", ...(scope && scope !== "user" ? ["-s", scope] : [])] },
          ],
          notes: ["更新后需要重启 Claude Code 才会生效。"],
        };
      }
      case "codex-marketplace": {
        const { marketplace } = unit.sourceRef;
        if (!NAME.test(marketplace)) throw new UpdateError(400, "市场名称无效。", "invalid-request");
        return { steps: [{ file: await tool("codex"), args: ["plugin", "marketplace", "upgrade", marketplace, "--json"] }], notes: [] };
      }
      case "hermes-hub": {
        if (!NAME.test(unit.title)) throw new UpdateError(400, "技能名称无效。", "invalid-request");
        return { steps: [{ file: await tool("hermes"), args: ["skills", "update", unit.title] }], notes: [] };
      }
      case "git": {
        const git = await tool("git");
        const status = await run(git, ["-C", unit.gitRoot, "status", "--porcelain"], { timeoutMs: 20_000, env: commandEnv() });
        if (status.exitCode !== 0) throw new UpdateError(409, "无法读取仓库状态。", "refused");
        if (status.stdout.trim()) throw new UpdateError(409, "仓库有未提交的改动，为避免覆盖已拒绝更新。", "conflict");
        return { steps: [{ file: git, args: ["-C", unit.gitRoot, "pull", "--ff-only"] }], notes: ["只做快进合并；如果本地已分叉会失败，不会改动文件。"], gitRoot: unit.gitRoot };
      }
      default:
        throw new UpdateError(409, "这个来源不能由 Skill Control 执行更新。", "refused");
    }
  }

  async function plan({ unit, view, facts, cache, choice }) {
    if (!unit) throw new UpdateError(404, "找不到这个更新单元。", "not-found");
    if (view.action.kind === "self") return planSelf(unit, view, facts, cache, choice);
    if (view.action.kind === "delegate") {
      const { steps, notes, gitRoot } = await delegateSteps(unit);
      const planId = remember({ kind: "delegate", unitKey: unit.unitKey, steps, gitRoot, title: unit.title, sourceType: unit.sourceType });
      return {
        planId,
        unitKey: unit.unitKey,
        kind: "delegate",
        steps: steps.map((step) => ({ type: "command", command: commandLine(step, display) })),
        notes,
        expiresAt: new Date(now() + PLAN_TTL_MS).toISOString(),
      };
    }
    return { planId: null, unitKey: unit.unitKey, kind: view.action.kind, steps: [], instructions: view.action.label, command: view.action.command || null };
  }

  async function applySelf(stored) {
    const transport = context.transportFactory(stored.files.length + 5);
    if (stored.localHash && (await localTreeSha(stored.primary, { exclude: installExclude })) !== stored.localHash) {
      throw new UpdateError(409, "本地内容在生成计划后有变化，请重新生成计划。", "stale-plan");
    }
    const lockText = await readFile(stored.lockFile, "utf8");
    const lock = JSON.parse(lockText);
    const entry = lock?.skills?.[stored.lockName];
    if (!entry || (stored.lockBaseline && entry.skillFolderHash !== stored.lockBaseline)) {
      throw new UpdateError(409, "锁文件在生成计划后被修改，请重新生成计划。", "stale-plan");
    }
    const staging = path.join(context.stateDirectory, "staging", randomUUID());
    const completed = [];
    try {
      for (const file of stored.files) {
        const parts = file.path.split("/");
        if (parts.some((part) => !part || part === "." || part === "..")) throw new UpdateError(409, "上游文件路径无效。", "integrity");
        const url = `https://raw.githubusercontent.com/${stored.repo}/${stored.commit}/${[...(stored.folder ? stored.folder.split("/") : []), ...parts].map(encodeURIComponent).join("/")}`;
        const content = await transport.getBuffer(url);
        if (gitBlobSha(content).toString("hex") !== file.sha) throw new UpdateError(409, `下载的 ${file.path} 校验失败，已停止更新，未做任何改动。`, "integrity");
        const target = path.join(staging, ...parts);
        if (!isWithin(staging, target)) throw new UpdateError(409, "上游文件路径无效。", "integrity");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, content);
        if (file.mode === "100755") await chmod(target, 0o755);
      }
      if ((await localTreeSha(staging, { exclude: installExclude })) !== stored.expected) {
        throw new UpdateError(409, "下载内容的 git 树哈希与上游不一致，已停止更新，未做任何改动。", "integrity");
      }
      if (stored.saveAs) await cp(stored.primary, stored.saveAs, { recursive: true, errorOnExist: true, force: false });
      for (const write of stored.writes) {
        await context.materialize({ sourcePath: staging, destinationPath: write.writePath, backupPath: write.backupPath });
        completed.push(write);
        if ((await localTreeSha(write.writePath, { exclude: installExclude })) !== stored.expected) {
          throw new UpdateError(500, "写入后的内容校验失败，已从备份恢复。", "integrity");
        }
      }
    } catch (error) {
      // Roll back every replaced directory from its backup.
      for (const write of completed.reverse()) {
        await rm(write.writePath, { recursive: true, force: true }).catch(() => {});
        await cp(write.backupPath, write.writePath, { recursive: true, preserveTimestamps: true }).catch(() => {});
      }
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
    // Lock: backup first, then an atomic rewrite of this one entry.
    const lockBackup = path.join(context.backupDirectory, stored.backupGroup, "skill-lock.json");
    await mkdir(path.dirname(lockBackup), { recursive: true });
    await writeFile(lockBackup, lockText, { flag: "wx" });
    lock.skills[stored.lockName] = { ...entry, skillFolderHash: stored.upstreamRaw, updatedAt: new Date(now()).toISOString() };
    const temporary = `${stored.lockFile}.skill-control-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(lock, null, 2)}${lockText.endsWith("\n") ? "\n" : ""}`);
    await rename(temporary, stored.lockFile);
    return {
      changed: completed.map((write) => ({ agentId: write.agentId, path: display(write.writePath), backup: display(write.backupPath) })),
      lockBackup: display(lockBackup),
      savedAs: stored.saveAs ? display(stored.saveAs) : null,
    };
  }

  async function assertAllowedCommand(file) {
    if (!context.allowedCommandRoots) return;
    // The command's own location counts (npm links into node_modules are fine), in both
    // its given and its real-folder form.
    const realFolder = await realpath(path.dirname(file)).catch(() => null);
    const candidates = [file, realFolder ? path.join(realFolder, path.basename(file)) : null].filter(Boolean);
    const roots = [
      ...context.allowedCommandRoots,
      ...(await Promise.all(context.allowedCommandRoots.map((root) => realpath(root).catch(() => root)))),
    ];
    const allowed = candidates.some((candidate) => roots.some((root) => isWithin(root, candidate)));
    if (!allowed) throw new UpdateError(403, "这个命令不在允许执行的目录中，已拒绝执行。", "command-not-allowed");
  }

  async function applyDelegate(stored) {
    // Delegated updates download things: never in offline mode.
    if (process.env.SKILL_MANAGER_UPDATES_OFFLINE === "1") throw new UpdateError(409, "离线模式下不执行会联网的更新命令。", "updates-offline");
    const results = [];
    for (const step of stored.steps) await assertAllowedCommand(step.file);
    for (const step of stored.steps) {
      const outcome = await run(step.file, step.args, { timeoutMs: COMMAND_TIMEOUT_MS, env: commandEnv() });
      results.push({
        command: commandLine(step, display),
        exitCode: outcome.exitCode,
        stdout: redactTail(outcome.stdout, context.homes),
        stderr: redactTail(outcome.stderr, context.homes),
      });
      if (outcome.exitCode !== 0) break;
    }
    return { commands: results, ok: results.every((result) => result.exitCode === 0) };
  }

  async function apply({ planId, confirm }) {
    if (confirm !== true) throw new UpdateError(400, "需要明确确认后才能执行更新。", "confirm-required");
    const stored = plans.take(planId);
    const result = stored.kind === "self" ? await applySelf(stored) : stored.kind === "delegate" ? await applyDelegate(stored) : { changed: [] };
    const record = {
      id: createHash("sha1").update(`${now()}:${stored.unitKey}`).digest("hex").slice(0, 12),
      type: "update",
      unitKey: stored.unitKey,
      kind: stored.kind,
      title: stored.title || null,
      ok: result.ok !== false,
      targets: result.changed?.map((item) => item.agentId) || [],
      backups: result.changed?.length || 0,
      exitCodes: result.commands?.map((command) => command.exitCode) || [],
      // Self updates replace folders with backups: the same shape as sync history, so they can be undone.
      actions: (result.changed || []).map((item) => ({ agentId: item.agentId, action: "replace", mode: "copy", destination: item.path, realDestination: item.path, backup: item.backup, afterHash: null })),
      createdAt: new Date(now()).toISOString(),
    };
    await mkdir(path.dirname(context.historyFile), { recursive: true });
    await appendFile(context.historyFile, `${JSON.stringify(record)}\n`, "utf8");
    return { planId: stored.planId, unitKey: stored.unitKey, kind: stored.kind, ...result, historyEntry: record };
  }

  return { plan, apply };
}

export function commandEnv() {
  return { ...process.env, DO_NOT_TRACK: "1", DISABLE_TELEMETRY: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" };
}

/** Display form of a command: home compacted, arguments quoted when needed. */
export function commandLine(step, display) {
  const quote = (value) => (/^[\w@%+=:,./~-]+$/u.test(value) ? value : `'${String(value).replace(/'/gu, "'\\''")}'`);
  return [display(step.file), ...step.args.map((arg) => (path.isAbsolute(arg) ? display(arg) : arg))].map(quote).join(" ");
}
