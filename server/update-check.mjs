import { compareVersions } from "./skill-status.mjs";
import { installExclude, treeShaFromListing } from "./git-tree.mjs";
import { object, text } from "./fs-safe.mjs";
import { TransportError } from "./update-transport.mjs";

/**
 * Update checks per source type. Checks only collect upstream facts (latest version,
 * commit or folder hash) into the cache; statuses are derived from the current local
 * state and those facts, so editing a skill after a check is reflected without a new
 * request. Results survive offline runs and rate limits (marked stale with checkedAt).
 */

export const CACHE_VERSION = 1;
const FILE_LIMIT = 1_500;
export const emptyCache = () => ({ version: CACHE_VERSION, checkedAt: null, hosts: [], github: {}, repos: {}, facts: {} });

const short = (value) => (typeof value === "string" ? value.slice(0, 7) : null);
const newer = (latest, current) => Boolean(latest && current && compareVersions(latest, current) > 0);
const semverish = (value) => typeof value === "string" && /^v?\d+\.\d+/u.test(value);

/** One folder's files and hashes from a recursive listing (relative paths). */
function folderFacts(listing, folder) {
  const prefix = folder ? `${folder}/` : "";
  const files = listing
    .filter((entry) => entry.type === "blob" && (!prefix || entry.path.startsWith(prefix)))
    .slice(0, FILE_LIMIT + 1)
    .map((entry) => ({ path: entry.path.slice(prefix.length), mode: entry.mode, sha: entry.sha, size: entry.size ?? null }));
  const unsupported = listing.some((entry) => (!prefix || entry.path.startsWith(prefix)) && (entry.mode === "120000" || entry.type === "commit"));
  return {
    raw: folder ? listing.find((entry) => entry.type === "tree" && entry.path === folder)?.sha || treeShaFromListing(listing, folder) : treeShaFromListing(listing, ""),
    filtered: treeShaFromListing(listing, folder, { exclude: installExclude }),
    files: files.length > FILE_LIMIT ? null : files,
    unsupported,
  };
}

async function githubTree(transport, repo, head, folders) {
  const tree = await transport.getJson(`https://api.github.com/repos/${repo}/git/trees/${head}?recursive=1`);
  const listing = Array.isArray(object(tree.json).tree) ? tree.json.tree : [];
  const result = {};
  for (const folder of folders) {
    if (!object(tree.json).truncated || (folder && listing.some((entry) => entry.path === folder))) {
      result[folder] = folderFacts(listing, folder);
      continue;
    }
    // Truncated listing: fetch the folder's own tree through its parent directory.
    if (!folder) throw new TransportError("truncated", "仓库过大，GitHub 返回的文件列表不完整。");
    const parent = folder.split("/").slice(0, -1).join("/");
    const contents = await transport.getJson(`https://api.github.com/repos/${repo}/contents/${parent}?ref=${head}`);
    const sha = (Array.isArray(contents.json) ? contents.json : []).find((entry) => entry.path === folder && entry.type === "dir")?.sha;
    if (!sha) throw new TransportError("not-found", "上游已没有这个技能目录。");
    const sub = await transport.getJson(`https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`);
    const subListing = (Array.isArray(object(sub.json).tree) ? sub.json.tree : []).map((entry) => ({ ...entry, path: `${folder}/${entry.path}` }));
    result[folder] = { ...folderFacts(subListing, folder), raw: sha };
  }
  return result;
}

async function checkGithubFolders(units, transport, cache, now) {
  const byRepo = new Map();
  for (const unit of units) byRepo.set(unit.check.repo, [...(byRepo.get(unit.check.repo) || []), unit]);
  for (const [repo, repoUnits] of byRepo) {
    try {
      const head = await transport.lsRemote(`https://github.com/${repo}.git`, "HEAD");
      const previous = cache.repos[repo];
      const folders = [...new Set(repoUnits.map((unit) => unit.check.folder))];
      let folderMap = previous?.head === head ? previous.folders || {} : {};
      const missing = folders.filter((folder) => !folderMap[folder]);
      if (missing.length) folderMap = { ...folderMap, ...(await githubTree(transport, repo, head, missing)) };
      cache.repos[repo] = { head, checkedAt: new Date(now).toISOString(), folders: folderMap };
      for (const unit of repoUnits) {
        const facts = folderMap[unit.check.folder];
        cache.facts[unit.unitKey] = facts?.filtered
          ? { checkedAt: new Date(now).toISOString(), upstream: { commit: head, raw: facts.raw, filtered: facts.filtered, unsupported: facts.unsupported } }
          : failure(cache, unit, new TransportError("not-found", "上游已没有这个技能目录。"), now);
      }
    } catch (error) {
      for (const unit of repoUnits) cache.facts[unit.unitKey] = failure(cache, unit, error, now);
    }
  }
}

/** Keeps earlier upstream facts on failure, so offline results stay visible (stale). */
function failure(cache, unit, error, now) {
  const previous = cache.facts[unit.unitKey];
  return {
    ...(previous?.upstream ? { upstream: previous.upstream, checkedAt: previous.checkedAt } : { checkedAt: null }),
    error: { kind: error?.kind || "error", message: text(String(error?.message || "检查失败。"), 200), ...(error?.resetAt ? { resetAt: new Date(error.resetAt).toISOString() } : {}) },
    attemptedAt: new Date(now).toISOString(),
  };
}

const PER_UNIT_CHECKS = {
  async "lark-cli"(unit, transport) {
    const npm = await transport.getJson("https://registry.npmjs.org/@larksuite/cli/latest");
    const latest = text(String(object(npm.json).version || ""), 40) || null;
    let available = null;
    try {
      const index = await transport.getJson("https://open.feishu.cn/.well-known/skills/index.json");
      const list = Array.isArray(index.json) ? index.json : Array.isArray(object(index.json).skills) ? index.json.skills : [];
      available = list.map((entry) => (typeof entry === "string" ? entry : object(entry).name)).filter((name) => typeof name === "string" && /^[\w.-]{1,80}$/u.test(name));
    } catch {
      available = null;
    }
    const installed = new Set(unit.check.installedSkills);
    return { latest, newSkills: available ? available.filter((name) => !installed.has(name)).sort() : [] };
  },
  async "claude-plugin"(unit, transport, memo) {
    const { repo, plugin } = unit.check;
    const marketplace = await memo(`raw:${repo}`, () => transport.getJson(`https://raw.githubusercontent.com/${repo}/HEAD/.claude-plugin/marketplace.json`));
    const plugins = Array.isArray(object(marketplace.json).plugins) ? marketplace.json.plugins : [];
    let entry = plugins.find((item) => object(item).name === plugin);
    let renamedTo = null;
    // Upstream renamed the plugin: the entry at the same source path is the same plugin.
    if (!entry && unit.check.localSource) {
      const sameSource = plugins.filter((item) => object(item).source === unit.check.localSource);
      if (sameSource.length === 1) [entry, renamedTo] = [sameSource[0], text(String(sameSource[0].name), 80)];
    }
    if (!entry) throw new TransportError("not-found", "插件市场中已没有这个插件。");
    let version = typeof entry.version === "string" ? entry.version : null;
    const source = entry.source;
    if (!version && typeof source === "string" && /^\.?\/?[\w./-]{0,200}$/u.test(source) && !source.includes("..")) {
      const base = source.replace(/^\.\//u, "").replace(/\/+$/u, "");
      const manifest = await transport.getJson(`https://raw.githubusercontent.com/${repo}/HEAD/${base ? `${base}/` : ""}.claude-plugin/plugin.json`).catch(() => null);
      version = typeof object(manifest?.json).version === "string" ? manifest.json.version : null;
    }
    if (version) return { latestVersion: text(version, 64), ...(renamedTo ? { renamedTo } : {}) };
    // A pinned commit in the marketplace entry needs no further request.
    const pinned = object(source).sha;
    const external = object(source).source === "github" ? object(source).repo : object(source).source === "url" ? (/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(String(object(source).url || ""))?.[1] ?? null) : null;
    if (/^[a-f0-9]{40}$/u.test(String(pinned || ""))) return { latestCommit: pinned, commitRepo: external || repo, ...(renamedTo ? { renamedTo } : {}) };
    const target = /^[\w.-]+\/[\w.-]+$/u.test(String(external || "")) ? external : repo;
    return { latestCommit: await memo(`ls:${target}`, () => transport.lsRemote(`https://github.com/${target}.git`, "HEAD")), commitRepo: target, ...(renamedTo ? { renamedTo } : {}) };
  },
  async git(unit, transport, memo) {
    return { latestCommit: await memo(`ls:${unit.check.url}:${unit.check.ref}`, () => transport.lsRemote(unit.check.url, unit.check.ref)) };
  },
  async "http-etag"(unit, transport) {
    const response = await transport.head(unit.check.url, { headers: { "if-none-match": unit.check.etag } });
    return { notModified: response.status === 304, etag: response.etag ? response.etag.slice(0, 200) : null };
  },
  async skillhub(unit, transport) {
    const response = await transport.getJson(`https://api.skillhub.cn/api/v1/skills/${encodeURIComponent(unit.check.slug)}`);
    const latest = object(object(response.json).latestVersion);
    return { latestVersion: text(String(latest.version || ""), 40) || null, changelog: text(String(latest.changelog || ""), 600) };
  },
  async clawhub(unit, transport) {
    let host;
    try {
      host = new URL(unit.check.registry).hostname;
    } catch {
      host = null;
    }
    // Never fall back across registries: the same slug can be a different skill.
    const api = host === "clawhub.ai" || host === "www.clawhub.ai" ? "https://clawhub.ai" : host === "skillhub.cn" || host === "api.skillhub.cn" ? "https://api.skillhub.cn" : null;
    if (!api) throw new TransportError("unsupported", "这个注册表不在支持列表中。");
    const response = await transport.getJson(`${api}/api/v1/skills/${encodeURIComponent(unit.check.slug)}`);
    if (object(response.json).code === "AMBIGUOUS_SKILL_SLUG") throw new TransportError("ambiguous", "注册表中有多个同名技能，无法确定是哪一个。");
    const latest = object(object(response.json).latestVersion);
    return { latestVersion: text(String(latest.version || ""), 40) || null, changelog: text(String(latest.changelog || ""), 600) };
  },
};

/**
 * Runs one check over `units` (only those with a network check). `cache` is updated in
 * place. Requests stop when the transport budget runs out; remaining units keep their
 * previous facts and report why they were not checked.
 */
export async function runUpdateCheck({ units, transport, cache, now = Date.now(), onProgress = () => {} }) {
  const checkable = units.filter((unit) => unit.check && unit.check.type !== "codex-remote");
  const memoStore = new Map();
  const memo = (key, factory) => {
    if (!memoStore.has(key)) memoStore.set(key, factory());
    return memoStore.get(key);
  };
  let done = 0;
  const total = checkable.length;
  // Cheap, high-value sources first: one request answers many units.
  const order = ["github-folder", "lark-cli", "git", "claude-plugin", "http-etag", "clawhub", "skillhub"];
  const github = checkable.filter((unit) => unit.check.type === "github-folder");
  await checkGithubFolders(github, transport, cache, now);
  done += github.length;
  onProgress({ done, total });
  for (const type of order.slice(1)) {
    for (const unit of checkable.filter((item) => item.check.type === type)) {
      try {
        const upstream = await PER_UNIT_CHECKS[type](unit, transport, memo);
        cache.facts[unit.unitKey] = { checkedAt: new Date(now).toISOString(), upstream };
      } catch (error) {
        cache.facts[unit.unitKey] = failure(cache, unit, error, now);
      }
      done += 1;
      onProgress({ done, total });
    }
  }
  const stats = transport.stats();
  cache.checkedAt = new Date(now).toISOString();
  cache.hosts = stats.hosts;
  cache.github = stats.github;
  return { total, requests: stats.requests, hosts: stats.hosts };
}

/** Three-way state for folder-hash sources: local ↔ baseline ↔ upstream. */
function threeWay(local, baseline, upstream) {
  if (!local) return { status: "check-failed", reason: "无法读取本地内容。" };
  const matchesUpstream = local === upstream.filtered || local === upstream.raw;
  if (matchesUpstream) return { status: "up-to-date", lockDrift: Boolean(baseline && baseline !== upstream.raw && baseline !== upstream.filtered) };
  if (!baseline) return { status: "update-available", reason: "没有安装时的基线，无法判断本地是否修改过。" };
  if (local === baseline) return { status: "update-available" };
  if (baseline === upstream.raw || baseline === upstream.filtered) return { status: "locally-modified" };
  return { status: "conflict", reason: "本地修改过，上游也有更新。" };
}

const localModified = (unit) => Boolean(unit.baseline && unit.local && unit.baseline.hash !== unit.local.hash);

/** Status, versions and reason of one unit from local state plus cached facts. */
export function unitStatus(unit, factsEntry) {
  const upstream = factsEntry?.upstream || null;
  const error = factsEntry?.error || null;
  const base = { current: null, latest: null, lockDrift: false, reason: unit.reason || null };
  const notChecked = () => (error ? { status: "check-failed", reason: error.message } : { status: "unchecked" });
  switch (unit.sourceType) {
    case "skills-cli": {
      const current = short(unit.local?.hash);
      if (!upstream) return { ...base, current, ...notChecked(), localModified: localModified(unit) };
      return { ...base, current, latest: short(upstream.commit), ...threeWay(unit.local?.hash, unit.baseline?.hash, upstream) };
    }
    case "lark-cli": {
      const current = unit.installed.version;
      const latest = upstream?.latest || unit.cachedLatest || null;
      const newSkills = upstream?.newSkills || [];
      if (!latest) return { ...base, current, ...notChecked() };
      const outdated = newer(latest, current) || newSkills.length > 0;
      const modified = unit.modified?.length ? `本地改过：${unit.modified.slice(0, 10).join("、")}` : null;
      const status = outdated ? (modified ? "conflict" : "update-available") : modified ? "locally-modified" : "up-to-date";
      const onlyNewSkills = newSkills.length > 0 && !newer(latest, current);
      const reason = [onlyNewSkills ? `有 ${newSkills.length} 个新的官方技能可安装` : null, modified, upstream ? null : "最新版本来自 lark-cli 上次自检"];
      return { ...base, current, latest, status, reason: reason.filter(Boolean).join("；") || null, newSkills };
    }
    case "claude-plugin": {
      const current = unit.installed.version || short(unit.installed.commit);
      if (!upstream) return { ...base, current, ...notChecked() };
      if (upstream.renamedTo) base.reason = `插件在市场中已改名为 ${upstream.renamedTo}。`;
      if (upstream.latestVersion && semverish(upstream.latestVersion) && semverish(unit.installed.version)) {
        return { ...base, current, latest: upstream.latestVersion, status: newer(upstream.latestVersion, unit.installed.version) ? "update-available" : "up-to-date" };
      }
      if (upstream.latestCommit) {
        const same = unit.installed.commit && upstream.latestCommit.startsWith(unit.installed.commit.slice(0, 12));
        return { ...base, current, latest: short(upstream.latestCommit), status: same ? "up-to-date" : "update-available", reason: same ? null : "插件来源有新提交（按提交比较）。" };
      }
      return { ...base, current, latest: upstream.latestVersion || null, status: upstream.latestVersion === unit.installed.version ? "up-to-date" : "update-available" };
    }
    case "git":
    case "codex-marketplace": {
      const current = short(unit.installed.commit);
      if (!upstream) return { ...base, current, ...notChecked() };
      const same = upstream.latestCommit === unit.installed.commit;
      return { ...base, current, latest: short(upstream.latestCommit), status: same ? "up-to-date" : "update-available", reason: same ? null : "远端有新提交（本地可能落后或已分叉）。" };
    }
    case "codex-remote-plugin": {
      const { latest, inCatalog } = unit.check;
      if (!inCatalog || !latest) return { ...base, current: unit.installed.version, status: "managed-by-host", reason: "Codex 的远程目录中没有这个插件的版本信息。" };
      return { ...base, current: unit.installed.version, latest, status: newer(latest, unit.installed.version) ? "update-available" : "up-to-date", reason: "版本来自 Codex 本地缓存的远程目录。" };
    }
    case "workbuddy-marketplace": {
      if (!unit.check) return { ...base, current: unit.installed.version, status: "managed-by-host", reason: "WorkBuddy 自动更新这个市场。" };
      if (!upstream) return { ...base, current: unit.installed.version, ...notChecked() };
      return { ...base, current: unit.installed.version, status: upstream.notModified ? "up-to-date" : "update-available", reason: upstream.notModified ? null : "市场包已更新，WorkBuddy 会自动下载。" };
    }
    case "workbuddy-skillhub":
    case "clawhub": {
      const current = unit.installed.version;
      if (!upstream) return { ...base, current, ...notChecked(), localModified: localModified(unit) };
      const outdated = newer(upstream.latestVersion, current);
      const modified = localModified(unit);
      return {
        ...base,
        current,
        latest: upstream.latestVersion,
        status: outdated ? (modified ? "conflict" : "update-available") : modified ? "locally-modified" : "up-to-date",
        changelog: upstream.changelog || null,
      };
    }
    case "hermes-hub":
    case "host":
      return { ...base, status: "managed-by-host" };
    case "well-known":
      return { ...base, status: "unknown-source" };
    default:
      return {
        ...base,
        status: localModified(unit) ? "locally-modified" : "unknown-source",
        reason: unit.possibleSource ? `可能来源：github.com/${unit.possibleSource}（需确认后才会绑定）` : localModified(unit) ? "自 Skill Control 首次记录后内容有变化。" : null,
      };
  }
}
