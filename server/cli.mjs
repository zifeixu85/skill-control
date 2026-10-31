#!/usr/bin/env node
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * `skill-control`: the library from the command line (v0.3 §4.1), for people and for
 * Agents installing skills. It reuses the app's modules, so it has the same rules: one
 * copy in ~/.agents/skills reached by each Agent through its tier, plans executed as small
 * reversible transactions under the shared library lock, backups and history (every write
 * prints its historyId and how to undo it). It never uses the network: remote skills are
 * downloaded by the Agent first, then added with `add`.
 *
 * Read-only mode (`--read-only`, or SKILL_MANAGER_DRY_RUN=1 / SKILL_CONTROL_READ_ONLY=1):
 * nothing is written at all, not even config or lock files; write commands show their plan.
 */

const USAGE = `skill-control —— Skill Control 技能库命令行

用法：
  skill-control status [<名称>] [--json]          技能库位置、自动接入设置、该技能在各 Agent 的状态
  skill-control add <文件夹> [--name <名称>] [--link primary|all|<a,b>|none] [--replace] [--dry-run] [--json]
                                                  校验 SKILL.md，复制进技能库，再接入 Agent（默认 primary）；
                                                  --link a,b 或 none 时，没列出的 Agent 之后也不会被自动接入
  skill-control link <名称> [--primary|--all|--agents a,b] [--dry-run] [--json]
  skill-control unlink <名称> --agents a,b [--dry-run] [--json]   取消接入（之后不会再自动接回）
  skill-control adopt <agentId> <名称> [--dry-run] [--json]       把某个 Agent 的副本收进库，原位置换成链接
  skill-control sync [--dry-run] [--json]                         按自动接入设置接入新技能
  skill-control undo <historyId> [--json]                         撤销一次改动
  skill-control doctor [--json]                                   解释哪些 Agent 看不到哪些技能、为什么

通用选项：--json 输出 JSON；--dry-run 只预览；--read-only 什么都不写（也可设 SKILL_MANAGER_DRY_RUN=1）。
不联网：远程来源请先下载到临时目录，再用 add。`;

const BOOLEAN_FLAGS = new Set(["json", "dry-run", "read-only", "replace", "primary", "all", "help", "version"]);
const VALUE_FLAGS = new Set(["name", "link", "agents"]);
const NAME = /^[\p{L}\p{N}_.@+ -]{1,128}$/u;
const STATE_LABELS = { visible: "能看到", missing: "看不到", hidden: "被隐藏", duplicate: "重复", "private-copy": "自有副本", none: "不支持" };
const TIER_LABELS = { native: "原生读取", config: "额外目录", link: "软链接", copy: "复制", none: "不支持" };

/** Terminal columns of a string (CJK and full-width characters take two). */
const columns = (value) => [...value].reduce((sum, char) => sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1), 0);
const pad = (value, size) => `${value}${" ".repeat(Math.max(1, size - columns(value)))}`;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.code = "usage";
  }
}

/** argv (without node and the script) → { command, positional, flags }. */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split(/=(.*)/su);
      if (BOOLEAN_FLAGS.has(key)) flags[key] = true;
      else if (VALUE_FLAGS.has(key)) {
        const value = inline ?? argv[++index];
        if (value === undefined || value.startsWith("--")) throw new UsageError(`--${key} 需要一个值。`);
        flags[key] = value;
      } else throw new UsageError(`未知选项 --${key}。`);
    } else if (arg === "-h") flags.help = true;
    else positional.push(arg);
  }
  return { command: positional[0] || null, positional: positional.slice(1), flags };
}

const list = (value) => String(value || "").split(",").map((item) => item.trim()).filter(Boolean);

async function packageVersion() {
  try {
    return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version || null;
  } catch {
    return null;
  }
}

/** The app's services, assembled like server/manage-routes.mjs does (no HTTP, no network). */
async function createCore({ readOnly }) {
  const homeDirectory = homedir();
  const stateDirectory = path.join(homeDirectory, ".agent-skill-manager");
  const backupDirectory = path.join(stateDirectory, "backups");
  const historyFile = path.join(stateDirectory, "history.jsonl");
  const [{ loadConfig, materializeSkillDirectory }, { createLibraryService }, { createRestoreService }, { readAutoLinkState }, { defaultSearchDirectories, findCommand }] = await Promise.all([
    import("./local-server.mjs"),
    import("./library-service.mjs"),
    import("./restore-service.mjs"),
    import("./auto-link.mjs"),
    import("./path-lookup.mjs"),
  ]);
  const expand = (value) => (value === "~" ? homeDirectory : value.startsWith("~/") ? path.join(homeDirectory, value.slice(2)) : path.resolve(value));
  // Primary Agents: the user's choice, else what the app last resolved, else the visible ones.
  const getConfig = async () => {
    const config = await loadConfig({ persist: !readOnly });
    const state = await readAutoLinkState(stateDirectory);
    return { ...config, primaryAgentIds: config.primaryAgentIds || state.effectivePrimaryAgentIds || config.visibleAgentIds };
  };
  const library = createLibraryService({
    homeDirectory,
    homes: [homeDirectory],
    stateDirectory,
    backupDirectory,
    historyFile,
    getConfig,
    findCommand: async (name) => findCommand(name, await defaultSearchDirectories({ homeDirectory })),
    readOnly,
    origin: "cli",
    autoLink: { disabled: true, noWatch: true },
  });
  const restore = createRestoreService({
    homeDirectory,
    homes: [homeDirectory],
    stateDirectory,
    backupDirectory,
    historyFile,
    getScan: async () => {
      throw new Error("命令行里不能卸载单个 Agent 的技能，请用 unlink 或在应用里操作。");
    },
    getAgents: async () => (await getConfig()).agents.map((agent) => ({ ...agent, paths: agent.paths.map(expand) })),
    materialize: materializeSkillDirectory,
    onLinksChanged: (changes) => library.autoLink.record(changes),
    readOnly,
  });
  return { homeDirectory, stateDirectory, getConfig, library, restore };
}

// ---------------------------------------------------------------------------
// Output helpers

function agentName(view, agentId) {
  return view.agents.find((agent) => agent.agentId === agentId)?.name || agentId;
}

function describeResults(result, view) {
  const lines = [];
  for (const item of result.results || []) {
    const who = item.agentId ? `${agentName(view, item.agentId)}：` : "";
    const status = item.status === "applied" ? "完成" : item.status === "rolled-back" ? "已回滚" : item.status === "skipped" ? "已跳过" : "失败";
    lines.push(`  ${status}  ${who}${item.title.replace(/^[^：]*：/u, "")}${item.error ? `（${item.error}）` : ""}`);
  }
  return lines;
}

function undoHint(historyEntry) {
  return historyEntry?.id ? `撤销：skill-control undo ${historyEntry.id}` : null;
}

function planLines(plan) {
  const lines = [];
  for (const item of plan.items || []) {
    if (item.choice === "skip" && !item.requiresChoice) continue;
    lines.push(`  ${item.requiresChoice ? "需要选择" : "将执行"}  ${item.title}`);
    for (const step of item.steps || []) lines.push(`      ${step.type} ${step.path || step.to || ""}${step.target ? ` → ${step.target}` : ""}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Commands

async function primaryAgents(core, view) {
  const config = await core.getConfig();
  return (config.primaryAgentIds || []).map((agentId) => view.agents.find((agent) => agent.agentId === agentId) || { agentId, name: agentId, tier: "none", method: "不支持" });
}

async function commandStatus(core, { positional }) {
  const view = await core.library.view();
  const config = await core.getConfig();
  const name = positional[0] || null;
  const primary = await primaryAgents(core, view);
  const result = {
    library: { root: view.root, exists: view.exists, count: view.entries.length },
    installMode: config.library?.installMode || "library",
    autoLink: view.autoLink,
    primaryAgents: primary.map((agent) => ({ agentId: agent.agentId, name: agent.name, tier: agent.tier, method: agent.method })),
    coverage: Object.fromEntries(primary.map((agent) => [agent.agentId, view.coverage[agent.agentId] || null])),
  };
  const lines = [
    `技能库    ${view.root}（${view.exists ? `${view.entries.length} 个技能` : "还不存在"}）`,
    `安装方式  ${result.installMode === "library" ? "统一技能库" : "各装一份"}`,
    `自动接入  ${view.autoLink.enabled ? `开启 · ${view.autoLink.scope === "all" ? "所有 Agent" : "常用 Agent"}${view.autoLink.baselineAt ? ` · 基线 ${view.autoLink.baselineAt.slice(0, 16).replace("T", " ")}` : ""}` : "关闭"}`,
    `常用 Agent ${primary.map((agent) => `${agent.name}（${agent.method}）`).join("、") || "未设置"}`,
  ];
  if (name) {
    const entry = view.entries.find((item) => item.name === name);
    if (!entry) {
      const snapshot = await core.library.snapshot();
      const copies = [];
      for (const agent of snapshot.agents) {
        for (const directory of agent.ownDirs) if (await stat(path.join(directory, name)).catch(() => null)) copies.push(agent.agentId);
      }
      result.skill = { name, inLibrary: false, privateCopies: [...new Set(copies)] };
      lines.push("", `${name}  不在技能库中${copies.length ? `；这些 Agent 有自己的副本：${[...new Set(copies)].map((id) => agentName(view, id)).join("、")}（可用 skill-control adopt <agentId> ${name} 收进库）` : "（可用 skill-control add <文件夹> 加入）"}`);
    } else {
      const agents = Object.entries(entry.fanout)
        .map(([agentId, item]) => ({ agentId, name: agentName(view, agentId), primary: primary.some((agent) => agent.agentId === agentId), ...item }))
        .sort((left, right) => Number(right.primary) - Number(left.primary));
      result.skill = { name, inLibrary: true, kind: entry.kind, agents };
      lines.push("", `${name}  在技能库中${entry.kind === "real" ? "" : `（${entry.kind}）`}`);
      for (const agent of agents.filter((item) => item.primary || item.state !== "missing" || ["link", "copy", "config"].includes(item.tier))) {
        const hint = agent.state === "missing" && ["link", "copy"].includes(agent.tier) ? ` → skill-control link ${name} --agents ${agent.agentId}` : "";
        lines.push(`  ${agent.primary ? "*" : " "} ${pad(agent.name, 16)}${pad(TIER_LABELS[agent.tier] || agent.tier, 10)}${STATE_LABELS[agent.state] || agent.state}${agent.reason ? `：${agent.reason}` : ""}${hint}`);
      }
      lines.push("  （* 常用 Agent）");
    }
  }
  return { result, lines };
}

async function agentNames(core, ids) {
  const config = await core.getConfig();
  return ids.map((id) => config.agents.find((agent) => agent.id === id)?.name || id).join("、");
}

async function resolveAgents(core, flags, { required = false, defaultPrimary = true } = {}) {
  const config = await core.getConfig();
  const known = new Set(config.agents.map((agent) => agent.id));
  if (flags.agents) {
    const ids = list(flags.agents);
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new UsageError(`未知的 Agent：${unknown.join("、")}。可用：${[...known].join("、")}`);
    return ids;
  }
  if (required) throw new UsageError("需要 --agents a,b。");
  if (flags.all) {
    const snapshot = await core.library.snapshot();
    return snapshot.agents.filter((agent) => ["link", "copy", "config"].includes(agent.tier)).map((agent) => agent.agentId);
  }
  return defaultPrimary || flags.primary ? config.primaryAgentIds || [] : [];
}

/** Plans, then (unless dry-run / read-only) applies; returns the command output. */
async function planAndApply(core, input, { flags, readOnly, title }) {
  const plan = await core.library.plan(input);
  const view = await core.library.view();
  if (!plan.planId && !plan.needsChoice) return { result: { nothingToDo: true, plan }, lines: [title, `  ${plan.message || "没有需要执行的改动。"}`] };
  if (flags["dry-run"] || readOnly || !plan.planId) {
    const lines = [`${title}${readOnly ? "（只读模式：没有写入）" : flags["dry-run"] ? "（预览，没有写入）" : ""}`, ...planLines(plan)];
    if (!plan.planId) lines.push(`  ${plan.message || "没有需要执行的改动。"}`);
    return { result: { dryRun: true, plan }, lines, exitCode: plan.planId || !plan.needsChoice ? 0 : 3 };
  }
  const applied = await core.library.apply({ planId: plan.planId, confirm: true });
  const lines = [title, ...describeResults(applied, view), ...(applied.backups ? [`备份：${applied.backups}`] : []), undoHint(applied.historyEntry)].filter(Boolean);
  const failed = applied.results.some((item) => item.status !== "applied");
  return { result: { plan: { needsChoice: plan.needsChoice }, results: applied.results, historyId: applied.historyEntry?.id || null, undo: undoHint(applied.historyEntry) }, lines, exitCode: failed ? 1 : 0 };
}

async function readSkillFolder(folder) {
  const directory = path.resolve(folder);
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) throw new UsageError(`${folder} 不是文件夹。`);
  const manifest = await readFile(path.join(directory, "SKILL.md"), "utf8").catch(() => null);
  if (manifest === null) throw new UsageError(`${folder} 里没有 SKILL.md。`);
  const { frontmatterBlock, readYamlScalar } = await import("./frontmatter.mjs");
  const block = frontmatterBlock(manifest);
  if (!block) throw new UsageError("SKILL.md 开头缺少 frontmatter（--- 包起来的 name / description）。");
  const name = readYamlScalar(block, "name");
  const description = readYamlScalar(block, "description");
  const problems = [];
  if (!name) problems.push("缺少 name");
  if (!description) problems.push("缺少 description");
  if (description && description.length > 1024) problems.push("description 超过 1024 个字符");
  if (problems.length) throw new UsageError(`SKILL.md 的 frontmatter 不完整：${problems.join("、")}。`);
  return { directory: await realpath(directory), name, description };
}

async function commandAdd(core, { positional, flags }, readOnly) {
  if (!positional[0]) throw new UsageError("用法：skill-control add <文件夹> [--name <名称>] [--link primary|all|<a,b>|none]");
  const skill = await readSkillFolder(positional[0]);
  const name = flags.name || skill.name || path.basename(skill.directory);
  if (!NAME.test(name) || name.startsWith(".")) throw new UsageError(`技能名称“${name}”不能用作文件夹名，请用 --name 指定。`);
  const link = flags.link || "primary";
  const agentIds = link === "none" ? [] : link === "primary" ? await resolveAgents(core, {}) : link === "all" ? await resolveAgents(core, { all: true }, { defaultPrimary: false }) : await resolveAgents(core, { agents: link });
  // `--link a,b` and `--link none`: the Agents left out are tombstoned, so auto-link (in the app
  // or a later `sync`) does not connect them anyway.
  const skipAgentIds = link === "primary" || link === "all" ? [] : await core.library.autoLink.unpickedAgents(agentIds);
  const { contentHash } = await import("./fs-links.mjs");
  const out = await planAndApply(
    core,
    { action: "install", install: { sourcePath: skill.directory, name, sourceHash: await contentHash(skill.directory), agentIds, skipAgentIds }, choices: flags.replace ? { [`replace:${name}`]: "use-new" } : {} },
    { flags, readOnly, title: `把 ${name} 加入技能库${agentIds.length ? `，接入 ${await agentNames(core, agentIds)}` : ""}` },
  );
  if (out.exitCode === 3) out.lines.push(`技能库里已有不同内容的 ${name}。确认要替换时加 --replace（旧版本会先备份，可撤销）。`);
  if (skipAgentIds.length && !out.result.nothingToDo) out.lines.push(`${out.result.dryRun ? "将不再" : "不会再"}自动接入：${await agentNames(core, skipAgentIds)}（之后可用 skill-control link 手动接入）`);
  if (name !== skill.name) out.lines.push(`注意：文件夹名 ${name} 与 SKILL.md 里的 name（${skill.name}）不同，有些 Agent 以 name 为准。`);
  return { ...out, result: { ...out.result, skill: name, library: (await core.library.snapshot()).library.root, autoLinkSkip: skipAgentIds } };
}

async function commandSync(core, { flags }, readOnly) {
  const result = await core.library.autoLink.run({ reason: "cli", origin: "cli", dryRun: Boolean(flags["dry-run"] || readOnly) });
  if (!result.enabled) return { result, lines: ["自动接入已关闭，没有做任何事。可在应用的技能库页开启，或用 skill-control link 手动接入。"] };
  const lines = [];
  if (result.dryRun) {
    lines.push(`将自动接入 ${result.connect.length} 项${readOnly ? "（只读模式：没有写入）" : "（预览，没有写入）"}`);
    for (const pair of result.connect.slice(0, 50)) lines.push(`  ${pair.skill} → ${pair.agentId}`);
  } else if (result.connected.length) {
    lines.push("已自动接入：");
    for (const item of result.connected) lines.push(`  ${item.skill} → ${item.agents.join("、")}`);
    if (result.historyId) lines.push(`撤销：skill-control undo ${result.historyId}`);
  } else lines.push("没有需要自动接入的新技能。");
  const pending = Object.entries(result.pending || {}).filter(([, count]) => count);
  if (pending.length) lines.push(`开启自动接入之前已有的缺口（不会自动处理，可在应用里“补齐接入”）：${pending.map(([agentId, count]) => `${agentId} ${count} 个`).join("、")}`);
  for (const item of result.needsConfirmation || []) lines.push(`${item.agentId}：${item.title}（缺 ${item.missing} 个）`);
  return { result, lines, exitCode: result.failed?.length ? 1 : 0 };
}

async function commandUndo(core, { positional }, readOnly) {
  const historyId = positional[0];
  if (!historyId || !/^[\w-]{1,64}$/u.test(historyId)) throw new UsageError("用法：skill-control undo <historyId>");
  const plan = await core.restore.planRestore({ historyId });
  const lines = [];
  for (const unit of plan.units || []) lines.push(`  ${unit.selected ? "将撤销" : "跳过"}  ${unit.title}${unit.conflict ? `（${unit.conflict}）` : ""}${unit.unrestorable ? `（${unit.unrestorable}）` : ""}`);
  if (!plan.planId || readOnly) {
    return { result: { plan }, lines: [readOnly ? "只读模式：没有撤销。" : plan.message || "没有可以撤销的改动。", ...lines], exitCode: plan.planId ? 0 : 1 };
  }
  const applied = await core.restore.applyRestore({ planId: plan.planId, confirm: true });
  return { result: { restored: applied.restoredUnits || applied.restored || [], historyId: applied.historyEntry?.id || null }, lines: ["已撤销：", ...lines, ...(applied.historyEntry?.id ? [`这次撤销也记在历史里：${applied.historyEntry.id}`] : [])] };
}

async function commandDoctor(core) {
  const view = await core.library.view();
  const config = await core.getConfig();
  const primary = new Set(config.primaryAgentIds || []);
  const agents = [];
  for (const agent of [...view.agents].sort((left, right) => Number(primary.has(right.agentId)) - Number(primary.has(left.agentId)))) {
    if (agent.tier === "native" && !primary.has(agent.agentId) && !view.coverage[agent.agentId]?.hidden && !view.coverage[agent.agentId]?.duplicate) continue;
    const groups = new Map();
    for (const entry of view.entries) {
      const item = entry.fanout[agent.agentId];
      if (!item || item.state === "visible") continue;
      const key = `${item.state}|${item.reason || ""}`;
      const group = groups.get(key) || { state: item.state, reason: item.reason || null, skills: [] };
      group.skills.push(entry.name);
      groups.set(key, group);
    }
    agents.push({ agentId: agent.agentId, name: agent.name, tier: agent.tier, method: agent.method, primary: primary.has(agent.agentId), counts: view.coverage[agent.agentId] || null, problems: [...groups.values()].sort((left, right) => right.skills.length - left.skills.length) });
  }
  const lines = [`技能库 ${view.root}：${view.entries.length} 个技能`];
  for (const agent of agents) {
    const counts = agent.counts || {};
    lines.push("", `${agent.primary ? "*" : " "} ${agent.name}（${agent.method}）：能看到 ${counts.visible ?? 0} / ${counts.total ?? 0}`);
    for (const problem of agent.problems.slice(0, 6)) {
      const sample = problem.skills.slice(0, 6).join("、");
      lines.push(`    ${STATE_LABELS[problem.state] || problem.state} ${problem.skills.length} 个${problem.reason ? `（${problem.reason}）` : ""}：${sample}${problem.skills.length > 6 ? " 等" : ""}`);
    }
    if (agent.problems.some((problem) => problem.state === "missing") && ["link", "copy"].includes(agent.tier)) {
      lines.push(`    处理：新技能会自动接入；已有的缺口在应用技能库页“补齐接入”，或 skill-control link <名称> --agents ${agent.agentId}`);
    }
  }
  for (const issue of view.issues || []) lines.push("", `! ${issue.title}${issue.detail ? `：${issue.detail}` : ""}`);
  return { result: { library: { root: view.root, count: view.entries.length }, agents, issues: view.issues || [], autoLink: view.autoLink }, lines };
}

async function run(parsed, { readOnly }) {
  const { command, positional, flags } = parsed;
  if (flags.version) return { result: { version: await packageVersion() }, lines: [`skill-control ${(await packageVersion()) || ""}`.trim()] };
  if (!command || flags.help || command === "help") return { result: { usage: USAGE }, lines: [USAGE] };
  const core = await createCore({ readOnly });
  switch (command) {
    case "status":
      return commandStatus(core, parsed);
    case "add":
      return commandAdd(core, parsed, readOnly);
    case "link": {
      if (!positional[0]) throw new UsageError("用法：skill-control link <名称> [--primary|--all|--agents a,b]");
      const agents = await resolveAgents(core, flags);
      return planAndApply(core, { action: "link", skill: positional[0], agents }, { flags, readOnly, title: `接入 ${positional[0]}：${await agentNames(core, agents)}` });
    }
    case "unlink": {
      if (!positional[0]) throw new UsageError("用法：skill-control unlink <名称> --agents a,b");
      const agents = await resolveAgents(core, flags, { required: true });
      return planAndApply(core, { action: "unlink", skill: positional[0], agents }, { flags, readOnly, title: `取消接入 ${positional[0]}：${await agentNames(core, agents)}（之后不会自动接回）` });
    }
    case "adopt": {
      const [agentId, name] = positional;
      if (!agentId || !name) throw new UsageError("用法：skill-control adopt <agentId> <名称>");
      await resolveAgents(core, { agents: agentId });
      return planAndApply(core, { action: "adopt", skill: name, agents: [agentId], from: agentId }, { flags, readOnly, title: `把 ${agentId} 的 ${name} 收进技能库` });
    }
    case "sync":
      return commandSync(core, parsed, readOnly);
    case "undo":
      return commandUndo(core, parsed, readOnly);
    case "doctor":
      return commandDoctor(core);
    default:
      throw new UsageError(`未知命令 ${command}。\n\n${USAGE}`);
  }
}

/** Runs the CLI; returns the exit code (0 ok, 1 failed, 2 usage, 3 needs a choice). */
export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }
  const json = Boolean(parsed.flags.json);
  const readOnly = Boolean(parsed.flags["read-only"]) || env.SKILL_MANAGER_DRY_RUN === "1" || env.SKILL_CONTROL_READ_ONLY === "1";
  try {
    const output = await run(parsed, { readOnly });
    const exitCode = output.exitCode ?? 0;
    if (json) stdout.write(`${JSON.stringify({ ok: exitCode === 0, command: parsed.command, readOnly, ...output.result }, null, 2)}\n`);
    else stdout.write(`${output.lines.join("\n")}\n`);
    return exitCode;
  } catch (error) {
    const usage = error instanceof UsageError || error?.code === "usage";
    if (json) stdout.write(`${JSON.stringify({ ok: false, command: parsed.command, error: String(error?.message || error), code: error?.code || null }, null, 2)}\n`);
    else stderr.write(`skill-control：${error?.message || error}\n`);
    return usage ? 2 : 1;
  }
}

const invokedAsScript = process.argv[1] && (() => {
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url || path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
// The Linux launcher passes "skill-control" as argv[1] (node -e); it never matches this file.
if (invokedAsScript || process.argv[1] === "skill-control") {
  main().then((code) => {
    process.exitCode = code;
  });
}
