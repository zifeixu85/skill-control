import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { exists, object, readBoundedJson, readBoundedText, readBoundedToml, text } from "./fs-safe.mjs";

/**
 * Local facts about where installed things came from: lock files, plugin registries,
 * marketplace metadata and CLI installs. Only files are read; nothing is executed or
 * fetched here.
 */

const LIMIT = 4_000_000;
export const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/u;
export const NAME = /^[\w.@:+-]{1,128}$/u;

export function githubRepoOf(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(?:https:\/\/|git@)github\.com[/:]([\w.-]{1,100})\/([\w.-]{1,100}?)(?:\.git)?\/?$/u);
  return match ? `${match[1]}/${match[2]}` : REPO.test(value.trim()) ? value.trim() : null;
}

/** ~/.agents/.skill-lock.json (vercel `skills` v3): entries by skill name. */
export async function readSkillsLock(homeDirectory = homedir()) {
  const file = path.join(homeDirectory, ".agents", ".skill-lock.json");
  const read = await readBoundedJson(file, LIMIT);
  if (read.status !== "ok") return { file, status: read.status, entries: new Map() };
  const entries = new Map();
  for (const [name, raw] of Object.entries(object(object(read.value).skills)).slice(0, 5_000)) {
    const entry = object(raw);
    if (!NAME.test(name) || typeof entry.sourceType !== "string") continue;
    entries.set(name, {
      name,
      sourceType: entry.sourceType,
      source: typeof entry.source === "string" ? entry.source : "",
      sourceUrl: typeof entry.sourceUrl === "string" ? entry.sourceUrl : "",
      skillPath: typeof entry.skillPath === "string" ? entry.skillPath : "",
      skillFolderHash: /^[a-f0-9]{40}$/u.test(String(entry.skillFolderHash || "")) ? entry.skillFolderHash : null,
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : null,
    });
  }
  return { file, status: "ok", version: object(read.value).version, entries };
}

/** Version of an npm-installed CLI, from the package.json above its real binary. */
async function packageVersionOf(binaryPath, packageName) {
  let current;
  try {
    current = path.dirname(await realpath(binaryPath));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 6; depth += 1) {
    const pkg = await readBoundedJson(path.join(current, "package.json"), 512_000);
    if (pkg.status === "ok" && object(pkg.value).name === packageName) return text(String(object(pkg.value).version || ""), 40) || null;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** Every `lark-cli` on the search path plus Hermes' bundled copy, with versions. */
export async function readLarkCli(homeDirectory, searchDirectories) {
  const candidates = [
    ...searchDirectories.map(({ directory }) => path.join(directory, "lark-cli")),
    path.join(homeDirectory, ".hermes", "node", "bin", "lark-cli"),
  ];
  const binaries = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!(await exists(candidate))) continue;
    const real = await realpath(candidate).catch(() => null);
    if (!real || seen.has(real)) continue;
    seen.add(real);
    binaries.push({
      path: candidate,
      version: await packageVersionOf(candidate, "@larksuite/cli"),
      hermes: candidate.startsWith(path.join(homeDirectory, ".hermes")),
    });
  }
  const updateState = await readBoundedJson(path.join(homeDirectory, ".lark-cli", "update-state.json"), 256_000);
  const skillsState = await readBoundedJson(path.join(homeDirectory, ".lark-cli", "skills-state.json"), 512_000);
  const state = object(skillsState.status === "ok" ? skillsState.value : {});
  return {
    binaries,
    cachedLatest: updateState.status === "ok" ? text(String(object(updateState.value).latest_version || ""), 40) || null : null,
    skillsVersion: text(String(state.version || ""), 40) || null,
    officialSkills: (Array.isArray(state.official_skills) ? state.official_skills : []).filter((name) => NAME.test(String(name))),
  };
}

/** Claude Code installed_plugins.json + known_marketplaces.json. */
export async function readClaudePlugins(homeDirectory = homedir()) {
  const root = path.join(homeDirectory, ".claude", "plugins");
  const installed = await readBoundedJson(path.join(root, "installed_plugins.json"), LIMIT);
  const known = await readBoundedJson(path.join(root, "known_marketplaces.json"), LIMIT);
  const marketplaces = new Map();
  for (const [name, raw] of Object.entries(object(known.status === "ok" ? known.value : {}))) {
    if (!NAME.test(name)) continue;
    const source = object(object(raw).source);
    const installLocation = typeof object(raw).installLocation === "string" ? object(raw).installLocation : null;
    // The local clone's manifest tells where each plugin lives, to follow upstream renames.
    const local = installLocation ? await readBoundedJson(path.join(installLocation, ".claude-plugin", "marketplace.json"), LIMIT) : null;
    const localSources = new Map(
      (Array.isArray(object(local?.value).plugins) ? local.value.plugins : [])
        .filter((plugin) => typeof object(plugin).name === "string" && typeof object(plugin).source === "string")
        .map((plugin) => [plugin.name, plugin.source]),
    );
    marketplaces.set(name, {
      name,
      repo: source.source === "github" ? githubRepoOf(source.repo) : source.source === "git" ? githubRepoOf(source.url) : null,
      installLocation,
      lastUpdated: typeof object(raw).lastUpdated === "string" ? object(raw).lastUpdated : null,
      localSources,
    });
  }
  const plugins = [];
  for (const [key, list] of Object.entries(object(object(installed.status === "ok" ? installed.value : {}).plugins))) {
    const at = key.lastIndexOf("@");
    if (at < 1) continue;
    const name = key.slice(0, at);
    const marketplace = key.slice(at + 1);
    if (!NAME.test(name) || !NAME.test(marketplace)) continue;
    for (const raw of (Array.isArray(list) ? list : []).slice(0, 20)) {
      const entry = object(raw);
      plugins.push({
        name,
        marketplace,
        scope: ["user", "project", "local"].includes(entry.scope) ? entry.scope : "user",
        projectPath: typeof entry.projectPath === "string" ? entry.projectPath : null,
        installPath: typeof entry.installPath === "string" ? entry.installPath : null,
        version: text(String(entry.version || ""), 64) || null,
        commit: /^[a-f0-9]{7,40}$/u.test(String(entry.gitCommitSha || "")) ? entry.gitCommitSha : null,
      });
    }
  }
  const gcsSha = await readBoundedText(path.join(root, "marketplaces", "claude-plugins-official", ".gcs-sha"), 256);
  return { plugins, marketplaces, officialSnapshot: gcsSha.status === "ok" ? gcsSha.text.trim().slice(0, 64) : null };
}

/** Codex git marketplaces ([marketplaces.*] with last_revision) and remote plugins. */
export async function readCodexPlugins(homeDirectory = homedir()) {
  const config = await readBoundedToml(path.join(homeDirectory, ".codex", "config.toml"), LIMIT);
  const marketplaces = [];
  for (const [name, raw] of Object.entries(object(object(config.status === "ok" ? config.value : {}).marketplaces))) {
    const entry = object(raw);
    if (!NAME.test(name) || entry.source_type !== "git" || typeof entry.source !== "string") continue;
    if (!/^https:\/\/[\w.-]+\/[\w./-]+$/u.test(entry.source)) continue;
    marketplaces.push({
      name,
      url: entry.source,
      ref: typeof entry.ref === "string" && /^[\w./-]{1,100}$/u.test(entry.ref) ? entry.ref : "HEAD",
      revision: /^[a-f0-9]{40}$/u.test(String(entry.last_revision || "")) ? entry.last_revision : null,
      updatedAt: typeof entry.last_updated === "string" ? entry.last_updated : null,
    });
  }
  const remoteRoot = path.join(homeDirectory, ".codex", "plugins", "cache", "openai-curated-remote");
  const catalog = new Map();
  const catalogRoot = path.join(homeDirectory, ".codex", "cache", "remote_plugin_catalog");
  for (const file of (await readdir(catalogRoot).catch(() => [])).filter((name) => name.endsWith(".json")).slice(0, 10)) {
    const read = await readBoundedJson(path.join(catalogRoot, file), 40_000_000);
    for (const plugin of Array.isArray(object(read.value).plugins) ? read.value.plugins : []) {
      const id = object(plugin).id;
      if (typeof id === "string") catalog.set(id, text(String(object(object(plugin).release).version || ""), 64) || null);
    }
  }
  const remote = [];
  for (const entry of (await readdir(remoteRoot, { withFileTypes: true }).catch(() => [])).filter((item) => item.isDirectory()).slice(0, 200)) {
    if (!NAME.test(entry.name)) continue;
    const meta = await readBoundedJson(path.join(remoteRoot, entry.name, ".codex-remote-plugin-install.json"), 64_000);
    const id = object(meta.value).remote_plugin_id;
    const versions = (await readdir(path.join(remoteRoot, entry.name), { withFileTypes: true }).catch(() => []))
      .filter((item) => item.isDirectory() && /^\d[\w.+-]{0,40}$/u.test(item.name))
      .map((item) => item.name);
    remote.push({
      name: entry.name,
      remoteId: typeof id === "string" ? id : null,
      version: versions.sort().at(-1) || null,
      latest: typeof id === "string" ? catalog.get(id) ?? null : null,
      inCatalog: typeof id === "string" && catalog.has(id),
      path: path.join(remoteRoot, entry.name),
    });
  }
  return { marketplaces, remote };
}

/** WorkBuddy zip marketplaces (download URL + ETag) and SkillHub skills. */
export async function readWorkBuddySources(homeDirectory = homedir()) {
  const root = path.join(homeDirectory, ".workbuddy");
  const zips = [];
  const marketplacesRoot = path.join(root, "plugins", "marketplaces");
  for (const entry of (await readdir(marketplacesRoot, { withFileTypes: true }).catch(() => [])).filter((item) => item.isDirectory()).slice(0, 50)) {
    const meta = await readBoundedJson(path.join(marketplacesRoot, entry.name, ".zip-metadata.json"), 64_000);
    if (meta.status !== "ok") continue;
    const value = object(meta.value);
    let url = null;
    try {
      url = new URL(value.url).protocol === "https:" ? new URL(value.url).toString() : null;
    } catch {
      url = null;
    }
    zips.push({ name: entry.name, url, etag: typeof value.etag === "string" ? value.etag.slice(0, 200) : null, lastModified: value.lastModified || null });
  }
  return { zips };
}

/** Per-skill registry metadata found inside a skill directory. */
export async function readSkillMeta(directory) {
  const skillhub = await readBoundedJson(path.join(directory, "_skillhub_meta.json"), 64_000);
  if (skillhub.status === "ok" && typeof object(skillhub.value).slug === "string") {
    const value = object(skillhub.value);
    return { kind: "skillhub", slug: value.slug, version: text(String(value.version || ""), 40) || null };
  }
  for (const folder of [".clawhub", ".clawdhub"]) {
    const origin = await readBoundedJson(path.join(directory, folder, "origin.json"), 64_000);
    if (origin.status === "ok" && typeof object(origin.value).slug === "string") {
      const value = object(origin.value);
      return {
        kind: "clawhub",
        slug: value.slug,
        registry: typeof value.registry === "string" ? value.registry : "https://clawhub.ai",
        version: text(String(value.installedVersion || value.version || ""), 40) || null,
      };
    }
  }
  return null;
}

/** The nearest git checkout containing `directory` (at most `levels` up, never above `stop`). */
export async function findGitCheckout(directory, stop, levels = 4) {
  let current = directory;
  for (let level = 0; level <= levels; level += 1) {
    if (!current.startsWith(stop) || current === stop) return null;
    const gitDir = path.join(current, ".git");
    const info = await stat(gitDir).catch(() => null);
    if (info?.isDirectory()) {
      const config = await readBoundedText(path.join(gitDir, "config"), 256_000);
      const remote = config.status === "ok" ? config.text.match(/\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/u)?.[1] : null;
      const head = await readBoundedText(path.join(gitDir, "HEAD"), 1_000);
      let commit = null;
      let branch = null;
      if (head.status === "ok") {
        const ref = head.text.trim().match(/^ref:\s*(refs\/heads\/[\w./-]{1,200})$/u)?.[1];
        if (ref) {
          branch = ref.slice("refs/heads/".length);
          const loose = await readBoundedText(path.join(gitDir, ...ref.split("/")), 200);
          commit = loose.status === "ok" ? loose.text.trim() : null;
          if (!commit) {
            const packed = await readBoundedText(path.join(gitDir, "packed-refs"), 4_000_000);
            commit = packed.status === "ok" ? packed.text.match(new RegExp(`^([a-f0-9]{40}) ${ref.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "mu"))?.[1] : null;
          }
        } else if (/^[a-f0-9]{40}$/u.test(head.text.trim())) {
          commit = head.text.trim();
        }
      }
      // Credentials embedded in a remote URL are never kept.
      const url = remote && /^https:\/\//u.test(remote) ? remote.replace(/\/\/[^/@]+@/u, "//") : null;
      return { root: current, url, branch, commit: /^[a-f0-9]{40}$/u.test(String(commit || "")) ? commit : null };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
