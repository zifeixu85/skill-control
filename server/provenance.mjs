import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { frontmatterBlock, readYamlScalar } from "./frontmatter.mjs";
import { compactHomePath, isWithin, readTextPrefix } from "./fs-safe.mjs";
import { installExclude, localTreeSha, skillFolderOf } from "./git-tree.mjs";
import {
  findGitCheckout,
  githubRepoOf,
  readClaudePlugins,
  readCodexPlugins,
  readLarkCli,
  readSkillMeta,
  readSkillsLock,
  readWorkBuddySources,
} from "./update-sources.mjs";

/**
 * Turns scanned skill copies, plugin registries and CLI installs into update units: one
 * unit per installed source, with every Agent copy that shares it. Precedence: host-
 * managed folders → lock files and per-skill metadata → plugin registries → a git
 * checkout → a GitHub homepage in frontmatter (only a possible source) → unknown.
 */

const HOST_SOURCES = {
  "codex-system": { label: "Codex 内置技能", owner: "host:codex" },
  "codex-plugin-cache": { label: "Codex 插件技能", owner: "host:codex" },
  "mirasim-synced": { label: "Mirasim 同步技能", owner: "host:mirasim" },
  "hermes-bundled": { label: "Hermes 内置技能", owner: "host:hermes", guide: "在终端运行 hermes update 更新 Hermes 及其内置技能。" },
  "hermes-org": { label: "Hermes 组织同步技能", owner: "host:hermes" },
  "openclaw-bundled": { label: "OpenClaw 内置技能", owner: "host:openclaw" },
  "qclaw-remote": { label: "QClaw 远程同步技能", owner: "host:qclaw" },
  "qclaw-config": { label: "QClaw 配置技能", owner: "host:qclaw" },
  skillhub: { label: "QClaw SkillHub 技能", owner: "host:qclaw" },
  "smartorder-system": { label: "订单来了内置技能", owner: "host:smartorder" },
  "smartorder-plugin": { label: "订单来了插件技能", owner: "host:smartorder" },
};

export const SOURCE_LABELS = {
  "skills-cli": "skills CLI（GitHub）",
  "well-known": "skills CLI（well-known）",
  "lark-cli": "lark-cli 官方技能",
  "claude-plugin": "Claude Code 插件",
  "codex-marketplace": "Codex 插件市场",
  "codex-remote-plugin": "Codex 远程插件",
  "workbuddy-marketplace": "WorkBuddy 插件市场",
  "workbuddy-skillhub": "WorkBuddy SkillHub",
  clawhub: "ClawHub",
  "hermes-hub": "Hermes Skills Hub",
  host: "由宿主管理",
  git: "Git 仓库",
  unknown: "来源未知",
};

const digest = (value) => createHash("sha1").update(value).digest("hex").slice(0, 16);
const expand = (value, homeDirectory) =>
  value === "~" ? homeDirectory : typeof value === "string" && value.startsWith("~/") ? path.join(homeDirectory, value.slice(2)) : value;

async function physicalCopies(scan, homeDirectory) {
  const byReal = new Map();
  for (const skill of scan.skills || []) {
    for (const instance of skill.instances) {
      const absolutePath = expand(instance.path, homeDirectory);
      const real = await realpath(absolutePath).catch(() => null);
      if (!real) continue;
      const copy = byReal.get(real) || { realPath: real, name: instance.name, hash: instance.hash, source: instance.source, instances: [] };
      copy.instances.push({ agentId: instance.agentId, path: instance.path, absolutePath, realPath: real });
      if (instance.source && instance.source !== "local" && (!copy.source || copy.source === "local")) copy.source = instance.source;
      byReal.set(real, copy);
    }
  }
  return [...byReal.values()];
}

async function possibleSource(realPath) {
  const head = await readTextPrefix(path.join(realPath, "SKILL.md"), 16_000);
  if (head.status !== "ok") return null;
  const block = frontmatterBlock(head.text);
  for (const key of ["homepage", "repository", "url"]) {
    const repo = githubRepoOf(readYamlScalar(block, key));
    if (repo) return repo;
  }
  return null;
}

function newUnit(unitKey, fields) {
  return { unitKey, instances: [], installed: {}, baseline: null, local: null, check: null, confidence: "exact", ...fields };
}

/**
 * Resolves update units. `baselines` (from update-baselines.json) is updated in place
 * for local copies without a recorded baseline; the caller persists it when `changed`.
 */
export async function resolveUpdateUnits({
  scan,
  homeDirectory = homedir(),
  homes = [homeDirectory],
  searchDirectories = [],
  baselines = { units: {} },
  now = Date.now(),
}) {
  const units = new Map();
  let changed = false;
  const realHome = await realpath(homeDirectory).catch(() => homeDirectory);
  const display = (value) => compactHomePath(value, [...homes, realHome]);
  const agentRoots = (
    await Promise.all(
      (scan.agents || []).flatMap((agent) => (agent.roots || []).map((root) => realpath(expand(root.path, homeDirectory)).catch(() => null))),
    )
  ).filter(Boolean);
  const unit = (unitKey, fields) => {
    if (!units.has(unitKey)) units.set(unitKey, newUnit(unitKey, fields()));
    return units.get(unitKey);
  };
  const addCopy = (target, copy) => {
    for (const instance of copy.instances) target.instances.push({ ...instance, name: copy.name, hash: copy.hash });
  };
  const baselineFor = (key, hash, version = null) => {
    const stored = baselines.units[key];
    if (!stored || (version && stored.version !== version)) {
      baselines.units[key] = { hash, algo: "scan-fingerprint", version, recordedAt: new Date(now).toISOString() };
      changed = true;
    }
    return baselines.units[key];
  };

  const lock = await readSkillsLock(homeDirectory);
  const lockDirs = new Map();
  for (const name of lock.entries.keys()) {
    const real = await realpath(path.join(homeDirectory, ".agents", "skills", name)).catch(() => null);
    if (real) lockDirs.set(real, lock.entries.get(name));
  }
  const lark = await readLarkCli(homeDirectory, searchDirectories);
  const pendingUnknown = [];

  for (const copy of await physicalCopies(scan, homeDirectory)) {
    const lockEntry = lockDirs.get(copy.realPath);
    const host = HOST_SOURCES[copy.source];
    if (copy.source === "hermes-hub") {
      addCopy(unit(`hermes-hub:${copy.name}`, () => ({
        title: copy.name, sourceType: "hermes-hub", owner: "host:hermes", check: null,
        hostAction: { kind: "delegate", tool: "hermes", args: ["skills", "update", copy.name], label: "用 Hermes 更新" },
        reason: "检查需要运行 hermes skills check（较慢），请按需在 Hermes 中检查。",
      })), copy);
      continue;
    }
    if (host) {
      const group = unit(`host:${copy.source}`, () => ({ title: host.label, sourceType: "host", owner: host.owner, hostGuide: host.guide || null }));
      addCopy(group, copy);
      continue;
    }
    if (lockEntry?.sourceType === "github" && /^[\w.-]+\/[\w.-]+$/u.test(lockEntry.source)) {
      const target = unit(`skills-cli:${lockEntry.source}:${lockEntry.skillPath}`, () => ({
        title: lockEntry.name,
        sourceType: "skills-cli",
        owner: "skill-control",
        lockFile: lock.file,
        sourceRef: { repo: lockEntry.source, skillPath: lockEntry.skillPath, folder: skillFolderOf(lockEntry.skillPath), name: lockEntry.name },
        baseline: lockEntry.skillFolderHash ? { hash: lockEntry.skillFolderHash, algo: "git-tree", from: "lock" } : null,
        installed: { hashAlgo: "git-tree", updatedAt: lockEntry.updatedAt },
        check: { type: "github-folder", repo: lockEntry.source, folder: skillFolderOf(lockEntry.skillPath) },
      }));
      if (!target.local) {
        const hash = await localTreeSha(copy.realPath, { exclude: installExclude }).catch(() => null);
        target.local = hash ? { hash, algo: "git-tree" } : null;
        target.installed.hash = hash;
        target.primaryPath = copy.realPath;
      }
      addCopy(target, copy);
      continue;
    }
    if (lockEntry?.sourceType === "well-known" && /open\.feishu\.cn$/u.test(lockEntry.source)) {
      const target = unit("lark-cli", () => ({
        title: "lark-cli 与飞书官方技能",
        sourceType: "lark-cli",
        owner: "host:lark-cli",
        lockFile: lock.file,
        installed: { version: lark.binaries.find((binary) => !binary.hermes)?.version || lark.binaries[0]?.version || null },
        check: { type: "lark-cli", installedSkills: [] },
        binaries: lark.binaries,
        cachedLatest: lark.cachedLatest,
        modified: [],
      }));
      target.check.installedSkills.push(lockEntry.name);
      const baseline = baselineFor(`lark-cli#${digest(copy.realPath)}`, copy.hash, lark.skillsVersion);
      if (baseline.hash !== copy.hash) target.modified.push(copy.name);
      addCopy(target, copy);
      continue;
    }
    if (lockEntry?.sourceType === "well-known") {
      const target = unit(`well-known:${lockEntry.source}`, () => ({
        title: `${lockEntry.source} 技能`, sourceType: "well-known", owner: "skill-control", lockFile: lock.file, check: null,
        reason: "well-known 来源没有可比较的版本信息。",
      }));
      addCopy(target, copy);
      continue;
    }
    const meta = await readSkillMeta(copy.realPath);
    if (meta?.kind === "skillhub") {
      const target = unit(`skillhub:${meta.slug}`, () => ({
        title: copy.name, sourceType: "workbuddy-skillhub", owner: "host:workbuddy",
        installed: { version: meta.version }, check: { type: "skillhub", slug: meta.slug },
      }));
      addCopy(target, copy);
      target.baseline = baselineFor(`skillhub:${meta.slug}#${digest(copy.realPath)}`, copy.hash, meta.version);
      target.local = { hash: copy.hash, algo: "scan-fingerprint" };
      continue;
    }
    if (meta?.kind === "clawhub") {
      const target = unit(`clawhub:${meta.registry}:${meta.slug}`, () => ({
        title: copy.name, sourceType: "clawhub", owner: "host:clawhub",
        installed: { version: meta.version }, check: { type: "clawhub", slug: meta.slug, registry: meta.registry },
      }));
      addCopy(target, copy);
      target.baseline = baselineFor(`clawhub:${meta.slug}#${digest(copy.realPath)}`, copy.hash, meta.version);
      target.local = { hash: copy.hash, algo: "scan-fingerprint" };
      continue;
    }
    const checkout = await findGitCheckout(copy.realPath, realHome);
    if (checkout?.url && agentRoots.some((root) => isWithin(root, checkout.root))) {
      const target = unit(`git:${checkout.url}#${digest(checkout.root)}`, () => ({
        title: path.basename(checkout.root),
        sourceType: "git",
        owner: "host:git",
        installed: { commit: checkout.commit, branch: checkout.branch },
        gitRoot: checkout.root,
        check: { type: "git", url: checkout.url, ref: checkout.branch ? `refs/heads/${checkout.branch}` : "HEAD", commit: checkout.commit },
      }));
      addCopy(target, copy);
      continue;
    }
    pendingUnknown.push(copy);
  }

  // Same-content copies of a skills-cli skill elsewhere belong to that unit.
  const cliUnits = [...units.values()].filter((item) => item.sourceType === "skills-cli");
  for (const copy of pendingUnknown) {
    const owner = cliUnits.find((item) => item.sourceRef.name === copy.name && item.instances.some((instance) => instance.hash === copy.hash));
    if (owner) {
      addCopy(owner, copy);
      continue;
    }
    const target = unit(`local:${digest(copy.realPath)}`, () => ({ title: copy.name, sourceType: "unknown", owner: "unknown", confidence: "none" }));
    addCopy(target, copy);
    target.baseline = baselineFor(`local:${digest(copy.realPath)}`, copy.hash);
    target.local = { hash: copy.hash, algo: "scan-fingerprint" };
    const repo = await possibleSource(copy.realPath);
    if (repo) target.possibleSource = repo;
  }

  await addRegistryUnits({ unit, homeDirectory, display });
  for (const item of units.values()) {
    item.sourceLabel = SOURCE_LABELS[item.sourceType] || item.sourceType;
    item.publicInstances = item.instances.map((instance) => ({ agentId: instance.agentId, path: display(instance.absolutePath) }));
    if (item.binaries) item.binaries = item.binaries.map((binary) => ({ ...binary, absolutePath: binary.absolutePath || binary.path, path: display(binary.absolutePath || binary.path) }));
  }
  return { units: [...units.values()], changed };
}

/** Units that come from plugin registries rather than scanned skill folders. */
async function addRegistryUnits({ unit, homeDirectory, display }) {
  const claude = await readClaudePlugins(homeDirectory);
  for (const plugin of claude.plugins) {
    const marketplace = claude.marketplaces.get(plugin.marketplace);
    const scopeKey = plugin.scope === "user" ? "user" : `${plugin.scope}:${digest(plugin.projectPath || "")}`;
    unit(`claude-plugin:${plugin.name}@${plugin.marketplace}:${scopeKey}`, () => ({
      title: `${plugin.name}@${plugin.marketplace}${plugin.scope === "user" ? "" : `（${plugin.scope}）`}`,
      sourceType: "claude-plugin",
      owner: "host:claude",
      installed: { version: plugin.version, commit: plugin.commit },
      pluginPath: plugin.installPath ? display(plugin.installPath) : null,
      sourceRef: { plugin: plugin.name, marketplace: plugin.marketplace, scope: plugin.scope },
      check: marketplace?.repo
        ? { type: "claude-plugin", repo: marketplace.repo, plugin: plugin.name, localSource: marketplace.localSources?.get(plugin.name) || null, version: plugin.version, commit: plugin.commit }
        : null,
      reason: marketplace?.repo ? null : "插件市场不是 GitHub 仓库，无法检查。",
    }));
  }
  const codex = await readCodexPlugins(homeDirectory);
  for (const marketplace of codex.marketplaces) {
    unit(`codex-marketplace:${marketplace.name}`, () => ({
      title: marketplace.name,
      sourceType: "codex-marketplace",
      owner: "host:codex",
      installed: { commit: marketplace.revision },
      sourceRef: { marketplace: marketplace.name },
      check: marketplace.revision ? { type: "git", url: marketplace.url, ref: marketplace.ref === "HEAD" ? "HEAD" : `refs/heads/${marketplace.ref}`, commit: marketplace.revision } : null,
    }));
  }
  for (const plugin of codex.remote) {
    unit(`codex-remote:${plugin.name}`, () => ({
      title: plugin.name,
      sourceType: "codex-remote-plugin",
      owner: "host:codex",
      installed: { version: plugin.version },
      pluginPath: display(plugin.path),
      // Codex keeps its own copy of the remote catalog: compared locally, no request.
      check: { type: "codex-remote", latest: plugin.latest, inCatalog: plugin.inCatalog },
    }));
  }
  const workbuddy = await readWorkBuddySources(homeDirectory);
  for (const zip of workbuddy.zips) {
    unit(`workbuddy-marketplace:${zip.name}`, () => ({
      title: zip.name,
      sourceType: "workbuddy-marketplace",
      owner: "host:workbuddy",
      installed: { version: zip.etag ? `etag ${zip.etag.replace(/^W\//u, "").slice(0, 12)}` : null },
      check: zip.url && zip.etag ? { type: "http-etag", url: zip.url, etag: zip.etag } : null,
    }));
  }
}
