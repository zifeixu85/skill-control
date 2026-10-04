import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { classifyPath, contentHash } from "./fs-links.mjs";
import { compactHomePath, exists, homeVariants, isWithin, readBoundedJson } from "./fs-safe.mjs";
import { AGENT_TIERS, agentOwnDirectories, readAgentSwitches, tierOf } from "./library-agents.mjs";
import { readSkillsLock } from "./update-sources.mjs";

/**
 * Read-only view of the shared library (~/.agents/skills): each entry's kind and content
 * hash, where it came from, and — per Agent, using that product's own loading rules —
 * whether the Agent sees it (visible / hidden / missing / duplicate / private-copy).
 */

const ENTRY_LIMIT = 2_000;
const MANAGERS = [[".mirasim", "Mirasim", "/Applications/Mirasim.app"]];

export const libraryPathOf = (homeDirectory) => path.join(homeDirectory, ".agents", "skills");

/** Memoized content hashes; git checkouts are external and never hashed. */
export function createHasher() {
  const memo = new Map();
  return async (directory) => {
    const real = await realpath(directory).catch(() => null);
    if (!real) return null;
    if (!memo.has(real)) {
      memo.set(real, (async () => ((await exists(path.join(real, ".git"))) ? null : contentHash(real)))());
    }
    return memo.get(real);
  };
}

async function libraryEntries(libraryPath, realRoot, hasher, lock) {
  let dirents;
  try {
    dirents = await readdir(libraryPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const entries = [];
  for (const dirent of dirents.slice(0, ENTRY_LIMIT)) {
    if (dirent.name.startsWith(".")) continue;
    const full = path.join(libraryPath, dirent.name);
    const info = await lstat(full).catch(() => null);
    if (!info) continue;
    let kind;
    let real = null;
    if (info.isSymbolicLink()) {
      real = await realpath(full).catch(() => null);
      kind = !real ? "broken" : isWithin(realRoot, real) ? "link-internal" : "link-external";
    } else if (info.isDirectory()) {
      kind = "real";
      real = await realpath(full);
    } else {
      continue;
    }
    const gitCheckout = real ? await exists(path.join(real, ".git")) : false;
    const lockEntry = lock.entries.get(dirent.name);
    entries.push({
      name: dirent.name,
      path: full,
      kind,
      real,
      gitCheckout,
      hash: real ? await hasher(real) : null,
      ...(lockEntry ? { sourceFromLocks: { source: lockEntry.source, sourceType: lockEntry.sourceType, file: "~/.agents/.skill-lock.json" } } : {}),
    });
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

/** One Agent's view of one library entry. */
async function agentView(agent, entry, context) {
  const { tier, ownDirs, switches } = agent;
  const own = [];
  for (const directory of ownDirs) {
    const target = path.join(directory, entry.name);
    const classified = await classifyPath(target, entry.path);
    if (classified.kind === "absent") continue;
    // The very folder a library link points at is the library entry itself, not a copy.
    const real = classified.real || (classified.kind === "real-dir" ? await realpath(target).catch(() => null) : null);
    if (entry.real && real === entry.real) {
      own.push({ directory, target, kind: "link-to-library", real });
      continue;
    }
    own.push({ directory, target, ...classified, real });
  }
  const sameContent = async (item) =>
    item.kind === "real-dir" && entry.hash && (await context.hasher(item.target)) === entry.hash;
  const disabled = switches.disabled?.has(entry.name) || (entry.real && switches.disabledPaths?.has(entry.real));
  if (entry.kind === "broken") return { tier, state: "hidden", reason: "库中的链接已失效" };

  if (tier === "native") {
    if (agent.containment && entry.kind === "link-external") return { tier, state: "hidden", reason: "链接的真实路径在库外，该产品拒绝加载" };
    if (disabled) return { tier, state: "hidden", reason: "已在该 Agent 中停用" };
    const copy = own.find((item) => item.kind === "real-dir" || item.kind === "foreign-link" || item.kind === "real-file");
    if (copy) {
      const identical = await sameContent(copy);
      if (agent.containment) return { tier, state: "visible", reason: `自有目录里的同名${identical ? "相同" : "不同"}副本被库覆盖` };
      return { tier, state: "duplicate", reason: identical ? "自有目录里有相同副本，会出现两次（可删除副本）" : "自有目录里有不同版本，两份都会出现", path: context.display(copy.target) };
    }
    return { tier, state: "visible", reason: own.length ? "自有目录里另有指向库的链接" : null };
  }

  if (tier === "config") {
    if (!switches.available) return { tier, state: "none", reason: "未安装" };
    if (disabled) return { tier, state: "hidden", reason: "已在 Hermes 中停用" };
    const local = own.find(Boolean);
    const configured = (switches.externalDirs || []).includes(context.realRoot);
    if (local?.kind === "link-to-library") return { tier, state: "visible", reason: configured ? "本地链接与外部目录指向同一份" : "经本地链接可见" };
    if (local) {
      const identical = await sameContent(local);
      return identical
        ? { tier, state: "visible", reason: "本地有相同副本（本地优先）", path: context.display(local.target) }
        : { tier, state: "duplicate", reason: "本地有同名不同内容的副本，Hermes 会报重名", path: context.display(local.target) };
    }
    return configured ? { tier, state: "visible", reason: null } : { tier, state: "missing", reason: "skills.external_dirs 中没有库目录" };
  }

  if (tier === "link") {
    const local = own[0];
    if (!local) return { tier, state: "missing", reason: "没有链接到库" };
    if (local.kind === "link-to-library") return { tier, state: "visible", reason: null };
    if (local.kind === "broken-link") return { tier, state: "hidden", reason: "同名链接已失效", path: context.display(local.target) };
    if (local.kind === "foreign-link") return { tier, state: "private-copy", reason: `链接指向库外：${context.display(local.real)}`, path: context.display(local.target) };
    if (local.kind === "real-file") return { tier, state: "private-copy", reason: "同名的是文件而不是目录", path: context.display(local.target) };
    const identical = await sameContent(local);
    return { tier, state: "private-copy", reason: identical ? "与库内容相同的独立副本（可改为链接）" : "与库内容不同的独立副本", identical, path: context.display(local.target) };
  }

  const copy = own[0];
  return copy ? { tier: "none", state: "private-copy", reason: "该 Agent 不读取库，使用自己的副本" } : { tier: "none", state: "missing", reason: "该 Agent 不读取库" };
}

async function ownerOf(libraryPath, homeDirectory, display) {
  const info = await lstat(libraryPath).catch(() => null);
  if (!info?.isSymbolicLink()) return null;
  const real = await realpath(libraryPath).catch(() => null);
  for (const [folder, name, app] of MANAGERS) {
    if (real && isWithin(path.join(homeDirectory, folder), real)) {
      return { kind: "symlink", realPath: display(real), manager: name, appInstalled: await exists(app) };
    }
  }
  return { kind: "symlink", realPath: real ? display(real) : null, manager: null, appInstalled: null };
}

/**
 * Agents shown: primary Agents plus every Agent with an existing skills folder (others
 * are listed with `collapsed: true`).
 */
async function agentsInScope(config, homeDirectory, libraryPath) {
  const primary = new Set(config.primaryAgentIds || []);
  const agents = [];
  for (const agent of config.agents || []) {
    const ownDirs = [];
    for (const directory of await agentOwnDirectories(agent, { homeDirectory, libraryPath })) {
      if ((await stat(directory).catch(() => null))?.isDirectory()) ownDirs.push(directory);
    }
    const tier = tierOf(agent.id);
    const switches = await readAgentSwitches(agent.id, homeDirectory);
    if (agent.id === "hermes" && switches.skillsDir && !ownDirs.includes(switches.skillsDir) && (await exists(switches.skillsDir))) ownDirs.push(switches.skillsDir);
    if (["openclaw", "qclaw"].includes(agent.id) && switches.stateDir) {
      const managed = path.join(switches.stateDir, "skills");
      if (!ownDirs.includes(managed) && (await exists(managed))) ownDirs.push(managed);
    }
    const relevant = primary.has(agent.id) || ownDirs.length > 0 || tier === "native";
    if (!relevant) continue;
    agents.push({
      agentId: agent.id,
      name: agent.name,
      realOwnDirs: await Promise.all(ownDirs.map((directory) => realpath(directory).catch(() => directory))),
      tier,
      containment: Boolean(AGENT_TIERS[agent.id]?.containment),
      primary: primary.has(agent.id),
      collapsed: !primary.has(agent.id),
      ownDirs,
      switches,
      notes: AGENT_TIERS[agent.id]?.note || "该 Agent 不读取库，只能使用自己的副本",
    });
  }
  return agents;
}

export async function readLibrary({ config, homeDirectory, homes = [homeDirectory], stateDirectory, hasher = createHasher() }) {
  const allHomes = [...new Set([...homes, ...(await homeVariants(homeDirectory))])];
  const display = (value) => (value ? compactHomePath(value, allHomes) : null);
  const libraryPath = libraryPathOf(homeDirectory);
  const realRoot = await realpath(libraryPath).catch(() => null);
  const lock = await readSkillsLock(homeDirectory);
  const entries = realRoot ? await libraryEntries(libraryPath, realRoot, hasher, lock) : [];
  const agents = await agentsInScope(config, homeDirectory, libraryPath);
  const context = { hasher, realRoot, display };
  const libraryLock = await readBoundedJson(path.join(stateDirectory, "library-lock.json"), 4_000_000);
  const recorded = libraryLock.status === "ok" ? libraryLock.value?.skills || {} : {};
  for (const entry of entries) {
    entry.fanout = {};
    for (const agent of agents) entry.fanout[agent.agentId] = await agentView(agent, entry, context);
    if (recorded[entry.name]) entry.recorded = { adoptedFrom: recorded[entry.name].adoptedFrom || null, updatedAt: recorded[entry.name].updatedAt || null };
  }
  const issues = [];
  const external = entries.filter((entry) => entry.kind === "link-external");
  if (external.length) {
    issues.push({ id: "library-external-link", severity: "warn", title: `库中有 ${external.length} 个链接指向库外`, detail: "OpenClaw / QClaw 会因根目录包含检查隐藏它们；可收编为实体目录。", names: external.map((entry) => entry.name).slice(0, 50) });
  }
  const broken = entries.filter((entry) => entry.kind === "broken");
  if (broken.length) issues.push({ id: "library-broken-link", severity: "error", title: `库中有 ${broken.length} 个失效链接`, detail: "", names: broken.map((entry) => entry.name) });
  for (const agent of agents.filter((item) => item.tier === "link")) {
    const drift = entries.filter((entry) => entry.fanout[agent.agentId]?.identical);
    if (drift.length) issues.push({ id: "library-drift", severity: "info", agentId: agent.agentId, title: `${agent.name} 有 ${drift.length} 个与库相同的独立副本`, detail: "两边各自修改会逐渐不一致，可改为链接。", names: drift.map((entry) => entry.name).slice(0, 50) });
  }
  const owner = await ownerOf(libraryPath, homeDirectory, display);
  if (owner?.manager && owner.appInstalled === false) {
    issues.push({ id: "library-owner-missing", severity: "warn", title: `库目录由 ${owner.manager} 托管，但应用已不存在`, detail: "可把库目录改为实体目录。" });
  }
  return {
    root: display(libraryPath),
    realRoot: display(realRoot),
    exists: Boolean(realRoot),
    ...(owner ? { owner } : {}),
    entries: entries.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      ...(entry.kind.startsWith("link") || entry.kind === "broken" ? { target: display(entry.real) } : {}),
      hash: entry.hash ? entry.hash.slice(0, 16) : null,
      ...(entry.gitCheckout ? { externalManaged: "git" } : {}),
      ...(entry.sourceFromLocks ? { sourceFromLocks: entry.sourceFromLocks } : {}),
      ...(entry.recorded ? { recorded: entry.recorded } : {}),
      fanout: Object.fromEntries(Object.entries(entry.fanout).map(([agentId, view]) => [agentId, { tier: view.tier, state: view.state, reason: view.reason, ...(view.path ? { path: view.path } : {}) }])),
    })),
    agents: agents.map((agent) => ({ agentId: agent.agentId, name: agent.name, tier: agent.tier, primary: agent.primary, collapsed: agent.collapsed, notes: agent.notes, directories: agent.ownDirs.map(display) })),
    issues,
    internal: { libraryPath, realRoot, entries, agents },
  };
}
