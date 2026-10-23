import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJobRegistry, openScript, runStreaming, terminalScript } from "./agent-update-run.mjs";
import { npmPrefixOf, updateStepsFor } from "./agent-update-steps.mjs";
import { applicationDirectoriesFor, parseYamlSafe, readAppBundle } from "./config-files.mjs";
import { compactHomeInText, compactHomePath, exists, homeVariants, object, readBoundedJson, readBoundedText, scrubTokens, text } from "./fs-safe.mjs";
import { CodedError, createPlanStore } from "./plan-store.mjs";
import { defaultSearchDirectories } from "./path-lookup.mjs";
import { remedyForVersion } from "./remedies.mjs";

/**
 * Installed vs latest versions of Agent products. Installed versions are read from files
 * only (app bundles' Info.plist, npm packages' package.json found by resolving the command
 * on known PATH folders, Claude Code's native versions folder, Hermes' pyproject.toml);
 * nothing is executed. Latest versions come from official sources only: the npm registry
 * for CLI packages, the app's own update feed (electron-updater app-update.yml → latest-mac
 * .yml, Sparkle SUFeedURL appcast), GitHub releases only where the product's own update
 * config (git remote, electron-updater github provider) points there. No feed: "unknown".
 *
 * Requests carry no identifiers, time out after 10 s, run at most 4 at a time and are
 * capped in size; SKILL_MANAGER_UPDATES_OFFLINE turns them off. Results are cached in
 * ~/.agent-skill-manager/agent-versions.json and refreshed every 24 hours.
 */

export const VERSION_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const PARALLEL = 4;
const MAX_BYTES = 2 * 1024 * 1024;
const CACHE_VERSION = 1;
const NPM_REGISTRY = "registry.npmjs.org";
const GITHUB_API = "api.github.com";
const PACKAGE_NAME = /^(?:@[a-z0-9][\w.-]{0,100}\/)?[a-z0-9][\w.-]{0,100}$/u;
const VERSION = /^v?\d{1,6}(?:\.\d{1,9}){0,3}(?:[-+][\w.-]{1,60})?$/u;
const PLACEHOLDER_HOST = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost|local)$/u;

/** Products whose versions are checked; rows appear only when installed. */
export const VERSION_TARGETS = [
  { id: "codex-cli", agentId: "codex", name: "Codex CLI", kind: "npm", command: "codex", npmPackage: "@openai/codex" },
  { id: "codex-app", agentId: "codex", name: "Codex 桌面应用", kind: "app", apps: ["Codex.app"], bundleIds: ["com.openai.codex"] },
  { id: "claude-cli", agentId: "claude", name: "Claude Code", kind: "claude", command: "claude", npmPackage: "@anthropic-ai/claude-code" },
  { id: "claude-app", agentId: "claude", name: "Claude 桌面应用", kind: "app", apps: ["Claude.app"], bundleIds: ["com.anthropic.claudefordesktop"], downloadUrl: "https://claude.com/download" },
  { id: "gemini-cli", agentId: "gemini", name: "Gemini CLI", kind: "npm", command: "gemini", npmPackage: "@google/gemini-cli" },
  { id: "openclaw-cli", agentId: "openclaw", name: "OpenClaw", kind: "npm", command: "openclaw", npmPackage: "openclaw" },
  { id: "hermes-cli", agentId: "hermes", name: "Hermes Agent", kind: "hermes" },
  { id: "hermes-app", agentId: "hermes", name: "Hermes 桌面应用", kind: "app", apps: ["Hermes.app"], bundleIds: ["com.nousresearch.hermes"] },
  { id: "workbuddy-app", agentId: "workbuddy", name: "WorkBuddy", kind: "app", apps: ["WorkBuddy.app"], bundleIds: ["com.tencent.workbuddy.mac", "com.tencent.workbuddy"] },
  { id: "cursor-app", agentId: "cursor", name: "Cursor", kind: "app", apps: ["Cursor.app"], bundleIds: ["com.todesktop.230313mzl4w4u92"] },
  { id: "trae-app", agentId: "trae", name: "Trae", kind: "app", apps: ["Trae CN.app", "Trae.app", "TRAE SOLO.app"], bundleIds: ["cn.trae.app", "com.trae.app", "com.trae.solo.app"] },
  { id: "kiro-app", agentId: "kiro", name: "Kiro", kind: "app", apps: ["Kiro.app"], bundleIds: [] },
  { id: "windsurf-app", agentId: "windsurf", name: "Windsurf", kind: "app", apps: ["Windsurf.app"], bundleIds: ["com.exafunction.windsurf"] },
  { id: "qclaw-app", agentId: "qclaw", name: "QClaw", kind: "app", apps: ["QClaw.app"], bundleIds: ["com.tencent.qclaw"] },
  { id: "office-raccoon-app", agentId: "office-raccoon", name: "办公小浣熊", kind: "app", apps: ["办公小浣熊.app"], bundleIds: ["com.sensetime.desktop.raccoon"] },
  { id: "smartorder-app", agentId: "smartorder", name: "订单来了", kind: "app", apps: ["订单来了.app"], bundleIds: ["com.ddll.ddlldesk"] },
  { id: "lumiclaw-app", agentId: "lumiclaw", name: "LumiClaw", kind: "app", apps: ["LumiClaw.app"], bundleIds: ["com.lumiclaw.app"] },
  { id: "lark-cli", agentId: "lark-cli", name: "飞书 CLI（lark-cli）", kind: "npm", command: "lark-cli", npmPackage: "@larksuite/cli" },
  { id: "lark-cli-hermes", agentId: "lark-cli", name: "飞书 CLI（Hermes 自带）", kind: "bundled", file: [".hermes", "node", "bin", "lark-cli"], npmPackage: "@larksuite/cli", bundledWith: "Hermes" },
];

// ---------------------------------------------------------------------------
// Versions

const cleanVersion = (value) => (typeof value === "string" && VERSION.test(value.trim()) ? value.trim().replace(/^v/u, "") : null);

/** -1 / 0 / 1; numeric parts first, a pre-release sorts before its release. */
export function compareVersions(left, right) {
  const parse = (value) => {
    const [main, pre = ""] = String(value).replace(/^v/u, "").split("+")[0].split(/-(.*)/su);
    return { parts: main.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.parts.length, b.parts.length); index += 1) {
    const difference = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (difference) return Math.sign(difference);
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre.localeCompare(b.pre, "en", { numeric: true }) > 0 ? 1 : -1;
}

// ---------------------------------------------------------------------------
// Installed (files only)

async function resolveCommand(command, searchDirectories) {
  return (await resolveAll(command, searchDirectories))[0] || null;
}

/** Every copy of a command on the search path, in PATH order (the first one is what runs). */
async function resolveAll(command, searchDirectories) {
  const found = [];
  const seen = new Set();
  for (const { directory } of searchDirectories) {
    const candidate = path.join(directory, command);
    const info = await stat(candidate).catch(() => null);
    if (!info?.isFile()) continue;
    const real = await realpath(candidate).catch(() => candidate);
    if (seen.has(real)) continue;
    seen.add(real);
    found.push({ file: candidate, real });
  }
  return found;
}

/** Walks up from a resolved binary to the package.json of `npmPackage`. */
async function packageOf(realFile, npmPackage) {
  let current = path.dirname(realFile);
  for (let depth = 0; depth < 6; depth += 1) {
    const pkg = await readBoundedJson(path.join(current, "package.json"), 256_000);
    if (pkg.status === "ok" && object(pkg.value).name === npmPackage) return { root: current, version: cleanVersion(pkg.value.version) };
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** The npm executable of the prefix a global package lives in (…/lib/node_modules/…). */
async function npmFor(packageRoot) {
  const prefix = npmPrefixOf(packageRoot);
  if (!prefix) return null;
  const npm = path.join(prefix, "bin", "npm");
  return (await exists(npm)) ? npm : null;
}

async function appBundle(target, applicationDirectories) {
  for (const directory of applicationDirectories) {
    for (const name of target.apps) {
      const appPath = path.join(directory, name);
      const bundle = await readAppBundle(appPath).catch(() => null);
      if (!bundle || (target.bundleIds.length && !target.bundleIds.includes(bundle.bundleId))) continue;
      return { appPath, bundle };
    }
  }
  return null;
}

/** The app's own update feed: electron-updater app-update.yml or a Sparkle SUFeedURL. */
async function appFeed(appPath, bundle) {
  if (bundle.feedUrl) return feedFromUrl(bundle.feedUrl, "sparkle");
  const read = await readBoundedText(path.join(appPath, "Contents", "Resources", "app-update.yml"), 64_000);
  if (read.status !== "ok") return { kind: "none", reason: "应用没有公开的更新源配置，请在应用里检查更新。" };
  const config = object(parseYamlSafe(read.text));
  if (config.provider === "github" && typeof config.owner === "string" && typeof config.repo === "string") {
    return /^[\w.-]{1,100}$/u.test(config.owner) && /^[\w.-]{1,100}$/u.test(config.repo)
      ? { kind: "github", owner: config.owner, repo: config.repo }
      : { kind: "none", reason: "应用的更新配置无法识别。" };
  }
  if (config.provider === "generic" && typeof config.url === "string") {
    const channel = typeof config.channel === "string" && /^[\w-]{1,40}$/u.test(config.channel) ? config.channel : "latest";
    return feedFromUrl(`${config.url.replace(/\/+$/u, "")}/${channel}-mac.yml`, "electron");
  }
  return { kind: "none", reason: "应用使用自定义的更新方式，请在应用里检查更新。" };
}

/** A feed URL from the app's own config, if it is a real public https address. */
function feedFromUrl(value, kind) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return { kind: "none", reason: "应用的更新地址无效。" };
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !host.includes(".") || PLACEHOLDER_HOST.test(host) || /^[\d.]+$/u.test(host) || host.includes(":") || url.username || url.password) {
    return { kind: "none", reason: "应用配置的更新地址是占位地址或不安全，请在应用里检查更新。" };
  }
  return { kind, url: url.toString(), host };
}

/** git remote of the Hermes checkout → GitHub owner / repo (its own `hermes update` source). */
async function hermesRemote(checkout) {
  const read = await readBoundedText(path.join(checkout, ".git", "config"), 64_000);
  if (read.status !== "ok") return null;
  const block = read.text.match(/\[remote "origin"\]([\s\S]*?)(?:\n\[|$)/u)?.[1] || "";
  const url = block.match(/^\s*url\s*=\s*(\S+)\s*$/mu)?.[1] || "";
  const match = url.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]{1,100})\/([\w.-]{1,100}?)(?:\.git)?\/?$/u);
  return match ? { owner: match[1], repo: match[2] } : null;
}

async function installedRow(target, context) {
  const { homeDirectory, homes, searchDirectories, applicationDirectories } = context;
  const display = (value) => compactHomePath(value, homes);
  switch (target.kind) {
    case "npm": {
      const found = await resolveCommand(target.command, searchDirectories);
      const pkg = found ? await packageOf(found.real, target.npmPackage) : null;
      if (!pkg?.version) return null;
      const npm = await npmFor(pkg.root);
      return {
        installed: { version: pkg.version, source: "npm", path: display(pkg.root) },
        feed: { kind: "npm", package: target.npmPackage },
        internal: { npm: npm ? display(npm) : null, npmAbs: npm, prefix: display(npmPrefixOf(pkg.root)), program: found.file, packageRoot: pkg.root },
      };
    }
    case "claude": {
      // Every copy (native installer, npm, …); the first on the PATH is the one that runs.
      const rows = [];
      for (const found of await resolveAll(target.command, searchDirectories)) {
        const pkg = await packageOf(found.real, target.npmPackage);
        if (pkg?.version) {
          const npm = await npmFor(pkg.root);
          rows.push({ installed: { version: pkg.version, source: "npm", path: display(pkg.root) }, feed: { kind: "npm", package: target.npmPackage }, internal: { npm: npm ? display(npm) : null, npmAbs: npm, prefix: display(npmPrefixOf(pkg.root)), packageRoot: pkg.root } });
          continue;
        }
        // Native installer: ~/.local/bin/claude → ~/.local/share/claude/versions/<version>.
        const version = path.basename(path.dirname(found.real)) === "versions" ? cleanVersion(path.basename(found.real)) : null;
        if (version) rows.push({ installed: { version, source: "cli", path: display(found.real) }, feed: { kind: "npm", package: target.npmPackage }, internal: { native: true, program: found.file } });
      }
      return rows.length ? rows : null;
    }
    case "hermes": {
      // Hermes has two version schemes: install-stamp.json's baseVersion (0.21.x, what its
      // GitHub release tags use since v0.22) and __release_date__ in hermes_cli/__init__.py
      // (calendar, what older tags used). Both are kept; the one in the latest tag's scheme
      // is compared and shown (see publicRow).
      const checkout = path.join(homeDirectory, ".hermes", "hermes-agent");
      if (!(await exists(path.join(checkout, "pyproject.toml")))) return null;
      const stamp = await readBoundedJson(path.join(checkout, "install-stamp.json"), 64_000);
      const init = await readBoundedText(path.join(checkout, "hermes_cli", "__init__.py"), 64_000);
      const pyproject = await readBoundedText(path.join(checkout, "pyproject.toml"), 256_000);
      const candidates = [
        object(stamp.value).baseVersion,
        init.status === "ok" ? init.text.match(/^__release_date__\s*=\s*"([^"]{1,40})"/mu)?.[1] : null,
        pyproject.status === "ok" ? pyproject.text.match(/^version\s*=\s*"([^"]{1,40})"/mu)?.[1] : null,
      ];
      const versions = [...new Set(candidates.map((value) => cleanVersion(String(value || ""))).filter((value) => value && value !== "0.0.0"))];
      const version = versions[0] || null;
      const remote = await hermesRemote(checkout);
      return {
        installed: { version, source: "cli", path: display(checkout) },
        feed: remote ? { kind: "github", owner: remote.owner, repo: remote.repo } : { kind: "none", reason: "Hermes 的 git 远端不是 GitHub，无法查询最新版本；可运行 hermes update。" },
        internal: { versions },
      };
    }
    case "bundled": {
      const file = path.join(homeDirectory, ...target.file);
      const real = await realpath(file).catch(() => null);
      const pkg = real ? await packageOf(real, target.npmPackage) : null;
      if (!pkg?.version) return null;
      const npm = await npmFor(pkg.root);
      return {
        installed: { version: pkg.version, source: "bundled", path: display(pkg.root) },
        feed: { kind: "npm", package: target.npmPackage },
        internal: { bundledWith: target.bundledWith, npm: npm ? display(npm) : null, npmAbs: npm, prefix: display(npmPrefixOf(pkg.root)), packageRoot: pkg.root },
      };
    }
    case "app": {
      const app = await appBundle(target, applicationDirectories);
      const version = cleanVersion(app?.bundle.version || "");
      if (!app || !version) return null;
      return { installed: { version, source: "app", path: display(app.appPath) }, feed: await appFeed(app.appPath, app.bundle), internal: { bundleId: app.bundle.bundleId, downloadUrl: target.downloadUrl || null } };
    }
    default:
      return null;
  }
}

/** Every installed product with its version and update feed (no network). */
export async function detectInstalledVersions(context) {
  const rows = [];
  for (const target of VERSION_TARGETS) {
    const found = await installedRow(target, context).catch(() => null);
    const list = Array.isArray(found) ? found : found ? [found] : [];
    list.forEach((item, index) =>
      rows.push({
        id: index ? `${target.id}-${index + 1}` : target.id,
        agentId: target.agentId,
        name: list.length > 1 ? `${target.name}（${item.installed.source === "npm" ? "npm" : "原生安装"}）` : target.name,
        kind: target.kind,
        // With several copies, the first on the PATH is the one that runs.
        active: index === 0,
        ...item,
      }),
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Latest (official sources only)

async function readCapped(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return Buffer.from(await response.arrayBuffer()).subarray(0, MAX_BYTES).toString("utf8");
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("响应超过大小上限。");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createHttp(fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS) {
  return async function get(url, allowedHost, accept) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== allowedHost) throw new Error("不在允许访问的地址范围内。");
    let response;
    try {
      // No cookies, tokens or device identifiers: a fixed user agent and an Accept header only.
      response = await fetchImpl(parsed.toString(), {
        headers: { accept, "user-agent": "skill-control-version-check" },
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(error?.name === "TimeoutError" ? "请求超时。" : "网络不可用。");
    }
    if (response.status === 404) throw new Error("更新源里没有这个条目。");
    if (!response.ok) throw new Error(`更新源返回 ${response.status}。`);
    return readCapped(response);
  };
}

function latestFromAppcast(xml, url) {
  let best = null;
  for (const item of xml.split(/<item[\s>]/u).slice(1, 200)) {
    const version =
      cleanVersion(item.match(/sparkle:shortVersionString="([^"]{1,60})"/u)?.[1] || "") ||
      cleanVersion(item.match(/<sparkle:shortVersionString>([^<]{1,60})<\/sparkle:shortVersionString>/u)?.[1] || "") ||
      cleanVersion(item.match(/sparkle:version="([^"]{1,60})"/u)?.[1] || "");
    if (!version || (best && compareVersions(version, best.version) <= 0)) continue;
    const pubDate = Date.parse(item.match(/<pubDate>([^<]{1,80})<\/pubDate>/u)?.[1] || "");
    const notes = item.match(/<sparkle:releaseNotesLink>(https:\/\/[^<\s]{1,400})<\/sparkle:releaseNotesLink>/u)?.[1] || null;
    best = { version, source: "sparkle", url, ...(Number.isFinite(pubDate) ? { releasedAt: new Date(pubDate).toISOString() } : {}), ...(notes ? { notesUrl: notes } : {}) };
  }
  if (!best) throw new Error("更新源里没有版本信息。");
  return best;
}

async function fetchLatest(feed, get) {
  switch (feed.kind) {
    case "npm": {
      if (!PACKAGE_NAME.test(feed.package)) throw new Error("包名无效。");
      const body = JSON.parse(await get(`https://${NPM_REGISTRY}/${feed.package.replace("/", "%2F")}/latest`, NPM_REGISTRY, "application/json"));
      const version = cleanVersion(object(body).version || "");
      if (!version) throw new Error("npm 没有返回版本号。");
      return { version, source: "npm", url: `https://www.npmjs.com/package/${feed.package}` };
    }
    case "github": {
      const body = object(JSON.parse(await get(`https://${GITHUB_API}/repos/${feed.owner}/${feed.repo}/releases/latest`, GITHUB_API, "application/vnd.github+json")));
      const version = cleanVersion(body.tag_name || "");
      if (!version) throw new Error("GitHub 没有返回版本号。");
      const notes = typeof body.html_url === "string" && body.html_url.startsWith("https://github.com/") ? body.html_url : null;
      return { version, source: "github", url: `https://github.com/${feed.owner}/${feed.repo}/releases`, ...(body.published_at ? { releasedAt: new Date(body.published_at).toISOString() } : {}), ...(notes ? { notesUrl: notes } : {}) };
    }
    case "electron": {
      const value = object(parseYamlSafe(await get(feed.url, feed.host, "text/yaml, */*")));
      const version = cleanVersion(String(value.version || ""));
      if (!version) throw new Error("更新源里没有版本信息。");
      const released = Date.parse(String(value.releaseDate || ""));
      return { version, source: "electron-updater", url: feed.url, ...(Number.isFinite(released) ? { releasedAt: new Date(released).toISOString() } : {}) };
    }
    case "sparkle":
      return latestFromAppcast(await get(feed.url, feed.host, "application/rss+xml, application/xml, */*"), feed.url);
    default:
      throw new Error(feed.reason || "没有更新源。");
  }
}

/** Runs `tasks` with at most `limit` in flight. */
async function inParallel(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const feedKey = (feed) => (feed.kind === "npm" ? `npm:${feed.package}` : feed.kind === "github" ? `github:${feed.owner}/${feed.repo}` : feed.url ? `${feed.kind}:${feed.url}` : `none`);

/** Calendar (2026.9.24) or semantic (0.22.5) version. */
const versionScheme = (value) => (Number.parseInt(String(value), 10) >= 2000 ? "calendar" : "semver");

/** With several installed versions in different schemes, the one in the latest version's scheme. */
function withComparableVersion(row, latest) {
  const versions = row.internal?.versions;
  if (!latest || !Array.isArray(versions) || versions.length < 2) return row;
  const match = versions.find((value) => versionScheme(value) === versionScheme(latest.version));
  return match && match !== row.installed.version ? { ...row, installed: { ...row.installed, version: match } } : row;
}

// ---------------------------------------------------------------------------
// One-click updates: only official, verified commands (agent-update-steps.mjs), run without a shell

export { npmPrefixOf, updateStepsFor };

const STEP_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_LIMIT = 4 * 1024;
const JOB_OUTPUT_LIMIT = 2 * 1024;
const PLAN_TTL_MS = 10 * 60_000;

const inside = (directory, file) => {
  const relative = path.relative(directory, file);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
};

function pinnedCommandDirectories(env = process.env) {
  return String(env.SKILL_MANAGER_COMMAND_DIRS || "")
    .split(path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry));
}

// ---------------------------------------------------------------------------
// Service

export function createAgentVersionService({
  homeDirectory,
  homes = [homeDirectory],
  stateDirectory,
  applicationDirectories = applicationDirectoriesFor(homeDirectory),
  searchDirectories = null,
  fetchImpl = globalThis.fetch,
  offline = process.env.SKILL_MANAGER_UPDATES_OFFLINE === "1",
  now = () => Date.now(),
  intervalMs = VERSION_CHECK_INTERVAL_MS,
  timeoutMs = REQUEST_TIMEOUT_MS,
  historyFile = path.join(stateDirectory, "history.jsonl"),
  run = runStreaming,
  launch = null,
  openFile = null,
  tempRoot = tmpdir(),
  platform = process.platform,
  pinnedDirectories = pinnedCommandDirectories(),
}) {
  const plans = createPlanStore({ ttlMs: PLAN_TTL_MS, now, label: "更新计划" });
  const jobs = createJobRegistry({ now });
  const cacheFile = path.join(stateDirectory, "agent-versions.json");
  const get = createHttp(fetchImpl, timeoutMs);
  let running = null;
  let timer = null;

  // Resolved paths can be /private/var/… for a /var/… home: compact every variant.
  const allHomes = homeVariants(homeDirectory).then((variants) => [...new Set([...homes, ...variants])]);
  const context = async () => ({
    homeDirectory,
    homes: await allHomes,
    applicationDirectories,
    searchDirectories: searchDirectories || (await defaultSearchDirectories({ homeDirectory })),
  });

  async function loadCache() {
    try {
      const value = JSON.parse(await readFile(cacheFile, "utf8"));
      return value?.version === CACHE_VERSION && value.results && typeof value.results === "object" ? value : { version: CACHE_VERSION, checkedAt: null, results: {} };
    } catch {
      return { version: CACHE_VERSION, checkedAt: null, results: {} };
    }
  }

  async function saveCache(cache) {
    await mkdir(stateDirectory, { recursive: true });
    const temporary = `${cacheFile}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(cache)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, cacheFile);
  }

  function publicRow(source, cached) {
    const sameFeed = cached && cached.feed === feedKey(source.feed);
    const latest = sameFeed ? cached.latest || null : null;
    const error = sameFeed ? cached.error || null : null;
    const row = withComparableVersion(source, latest);
    let status = "unknown";
    if (row.feed.kind === "none") status = "unknown";
    else if (error) status = "error";
    else if (latest && row.installed.version) status = compareVersions(row.installed.version, latest.version) >= 0 ? "up-to-date" : "update-available";
    const result = {
      agentId: row.agentId,
      id: row.id,
      name: row.name,
      active: row.active !== false,
      installed: row.installed,
      latest,
      status,
      ...(error ? { error } : {}),
      ...(row.feed.kind === "none"
        ? { reason: row.feed.reason }
        : !row.installed.version
          ? { reason: "读不到本机安装的版本号。" }
          : !latest && !error
            ? { reason: "还没有检查过。" }
            : {}),
    };
    const oneClick = status === "update-available" && Boolean(updateStepsFor(row));
    const remedy = remedyForVersion({ ...result, feed: row.feed, internal: row.internal || {} }, { homes: displayHomes });
    return {
      ...result,
      ...(row.kind === "app" && row.internal?.bundleId ? { openApp: { bundleId: row.internal.bundleId }, ...(row.internal.downloadUrl ? { downloadUrl: row.internal.downloadUrl } : {}) } : {}),
      ...(remedy ? { remedy: oneClick ? { ...remedy, action: { kind: "agent-update", id: row.id } } : remedy } : {}),
    };
  }

  let displayHomes = homes;
  async function view() {
    displayHomes = await allHomes;
    const [rows, cache] = await Promise.all([detectInstalledVersions(await context()), loadCache()]);
    const checkedAt = cache.checkedAt || null;
    return {
      checkedAt,
      nextCheckAt: checkedAt ? new Date(Date.parse(checkedAt) + intervalMs).toISOString() : null,
      offline,
      agents: rows.map((row) => publicRow(row, cache.results[row.id])),
    };
  }

  async function runCheck() {
    if (offline) return view();
    const rows = await detectInstalledVersions(await context());
    // One request per distinct feed (two rows can share an npm package).
    const feeds = new Map();
    for (const row of rows) if (row.feed.kind !== "none") feeds.set(feedKey(row.feed), row.feed);
    const fetched = new Map();
    const keys = [...feeds.keys()];
    const outcomes = await inParallel(keys, PARALLEL, async (key) => {
      try {
        return { latest: await fetchLatest(feeds.get(key), get) };
      } catch (error) {
        return { error: text(error?.message || "检查失败。", 200) };
      }
    });
    keys.forEach((key, index) => fetched.set(key, outcomes[index]));
    const checkedAt = new Date(now()).toISOString();
    const results = {};
    for (const row of rows) {
      const key = feedKey(row.feed);
      if (fetched.has(key)) results[row.id] = { feed: key, checkedAt, ...fetched.get(key) };
    }
    await saveCache({ version: CACHE_VERSION, checkedAt, results });
    return view();
  }

  /** POST /api/agent-versions/check (one check at a time). */
  function check() {
    running ||= runCheck().finally(() => {
      running = null;
    });
    return running;
  }

  /** Checks now when the cache is older than the interval, then every interval while running. */
  async function start() {
    if (timer || offline) return;
    const cache = await loadCache();
    const age = cache.checkedAt ? now() - Date.parse(cache.checkedAt) : Number.POSITIVE_INFINITY;
    if (!(age < intervalMs)) check().catch(() => {});
    timer = setInterval(() => check().catch(() => {}), intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  const display = (value) => compactHomePath(value, displayHomes);

  /** The program must still be the resolved one, and inside the pinned folders when commands are pinned. */
  async function assertRunnable(program) {
    const info = await stat(program).catch(() => null);
    if (!info?.isFile()) throw new CodedError(409, "更新命令已不存在，请重新检查版本。", "stale-plan");
    const pinned = pinnedDirectories;
    if (pinned.length) {
      const real = await realpath(program).catch(() => program);
      if (!pinned.some((directory) => inside(directory, program) || inside(directory, real))) throw new CodedError(403, "这个命令不在允许执行的目录中，已拒绝执行。", "command-not-allowed");
    }
  }

  async function findRow(id) {
    displayHomes = await allHomes;
    const [rows, cache] = await Promise.all([detectInstalledVersions(await context()), loadCache()]);
    const row = rows.find((item) => item.id === id);
    if (!row) throw new CodedError(404, "没有找到这个已安装的产品。", "not-found");
    return { row, view: publicRow(row, cache.results[row.id]) };
  }

  /** POST /api/agent-versions/plan { id } */
  async function plan({ id } = {}) {
    if (typeof id !== "string" || !/^[\w-]{1,60}$/u.test(id)) throw new CodedError(400, "缺少产品 id。", "invalid-request");
    const { row, view: current } = await findRow(id);
    if (current.status === "up-to-date") throw new CodedError(409, "已经是最新版本。", "up-to-date");
    if (current.status !== "update-available") throw new CodedError(409, "请先检查版本，确认有新版本后再更新。", "check-required");
    const spec = updateStepsFor(row, display);
    if (!spec) throw new CodedError(409, "这个产品没有已核实的一键更新命令，请用 AI 指令或在应用里更新。", "refused");
    for (const step of spec.steps) await assertRunnable(step.program);
    const shown = (arg) => (path.isAbsolute(arg) ? display(arg) : arg);
    const steps = spec.steps.map((step) => ({ display: [step.program, ...step.args].map(shown).join(" "), program: step.program, args: step.args }));
    const title = `把 ${row.name} 从 ${row.installed.version} 更新到 ${current.latest.version}`;
    const planId = plans.remember({ id, agentId: row.agentId, title, steps, before: row.installed.version, latest: current.latest.version });
    return {
      planId,
      expiresAt: new Date(now() + PLAN_TTL_MS).toISOString(),
      title,
      steps: steps.map((step) => ({ display: step.display })),
      effects: spec.effects,
      afterCheck: { kind: "version", id },
    };
  }

  /** No shell, no inherited secrets: PATH holds the program's own folder (npm needs its node). */
  async function pathFor(program) {
    return [...new Set([path.dirname(program), path.dirname(await realpath(program).catch(() => program)), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])];
  }

  const clean = (value) => scrubTokens(compactHomeInText(value, displayHomes));

  /** Runs the plan's steps in order, stopping at the first failure. */
  async function runSteps(stored, { onStep = () => {}, onOutput = () => {} } = {}) {
    const results = [];
    let ok = true;
    for (const [index, step] of stored.steps.entries()) {
      await assertRunnable(step.program);
      onStep(index);
      const env = { PATH: (await pathFor(step.program)).join(path.delimiter), HOME: homeDirectory, LANG: "en_US.UTF-8" };
      const outcome = await run(step.program, step.args, { cwd: homeDirectory, timeoutMs: STEP_TIMEOUT_MS, env, onOutput });
      const output = clean(`${outcome.stdout || ""}${outcome.stderr ? `\n${outcome.stderr}` : ""}`).trim();
      results.push({ display: step.display, exitCode: outcome.exitCode, output: output.length > OUTPUT_LIMIT ? `…${output.slice(-OUTPUT_LIMIT)}` : output });
      if (outcome.exitCode !== 0) {
        ok = false;
        break;
      }
    }
    return { ok, results };
  }

  /** The version after the update (read from files) and the history record. */
  async function record(stored, { ok, steps, mode }) {
    const after = mode === "terminal" ? null : (await detectInstalledVersions(await context()).catch(() => [])).find((item) => item.id === stored.id)?.installed.version || null;
    const entry = {
      id: createHash("sha1").update(`${now()}:agent-update:${stored.id}:${mode}`).digest("hex").slice(0, 12),
      type: "agent-update",
      mode,
      title: stored.title,
      productId: stored.id,
      agentId: stored.agentId,
      ok,
      steps,
      version: { before: stored.before, after },
      restorable: false,
      createdAt: new Date(now()).toISOString(),
    };
    await mkdir(path.dirname(historyFile), { recursive: true });
    await appendFile(historyFile, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  }

  function confirmed({ confirm }) {
    if (confirm !== true) throw new CodedError(400, "需要明确确认后才能执行更新。", "confirm-required");
    if (offline) throw new CodedError(409, "离线模式下不执行会联网的更新命令。", "updates-offline");
  }

  function notRunning(planId) {
    const pending = plans.peek(planId);
    if (pending && jobs.running(pending.id)) throw new CodedError(409, "这个产品正在后台更新，请等它完成。", "job-running");
  }

  /**
   * POST /api/agent-versions/apply { planId, confirm: true, background? } (confirm header checked by
   * the route). In the app it returns when done; with `background` it returns { jobId } at once.
   */
  async function apply({ planId, confirm, background = false } = {}) {
    confirmed({ confirm });
    notRunning(planId);
    const stored = plans.take(planId);
    if (!background) {
      const { ok, results } = await runSteps(stored);
      const historyEntry = await record(stored, { ok, steps: results.map(({ display: shown, exitCode }) => ({ display: shown, exitCode })), mode: "in-app" });
      return { ok, steps: results, version: historyEntry.version, historyEntry };
    }
    for (const step of stored.steps) await assertRunnable(step.program);
    const job = jobs.create(stored.id, stored.steps);
    let tail = "";
    const update = (chunk) => {
      tail = `${tail}${chunk}`.slice(-8 * JOB_OUTPUT_LIMIT);
      const shown = clean(tail);
      job.outputTail = shown.length > JOB_OUTPUT_LIMIT ? shown.slice(-JOB_OUTPUT_LIMIT) : shown;
    };
    (async () => {
      try {
        const { ok, results } = await runSteps(stored, { onStep: (index) => (job.step = index + 1), onOutput: update });
        results.forEach((result, index) => (job.steps[index] = { display: result.display, exitCode: result.exitCode }));
        if (!tail && results.length) update(results.map((result) => result.output).join("\n"));
        const entry = await record(stored, { ok, steps: job.steps.filter((step) => "exitCode" in step), mode: "background" });
        Object.assign(job, { status: ok ? "done" : "error", version: entry.version, historyId: entry.id });
      } catch (error) {
        Object.assign(job, { status: "error", error: text(clean(String(error?.message || "更新失败。")), 300) });
      } finally {
        job.finishedAt = new Date(now()).toISOString();
      }
    })();
    return { jobId: job.jobId, status: "running", afterCheck: { kind: "version", id: stored.id } };
  }

  /** GET /api/agent-versions/jobs/:id */
  function job(jobId) {
    const found = jobs.get(jobId);
    if (!found) throw new CodedError(404, "没有找到这个后台任务（任务结束 1 小时后不再保留）。", "job-not-found");
    return {
      jobId: found.jobId,
      productId: found.productId,
      status: found.status,
      step: found.step,
      steps: found.steps.map((step) => ({ ...step })),
      outputTail: found.outputTail,
      startedAt: found.startedAt,
      finishedAt: found.finishedAt,
      ...(found.version ? { version: found.version } : {}),
      ...(found.error ? { error: found.error } : {}),
    };
  }

  /**
   * POST /api/agent-versions/terminal { planId, confirm: true }: writes the plan's exact commands
   * into a one-off script in a private temp folder (0700) and opens it with the default handler
   * (Terminal or iTerm on macOS, `start` on Windows). The UI re-checks versions afterwards.
   */
  async function terminal({ planId, confirm } = {}) {
    confirmed({ confirm });
    // Sandboxes and tests pin commands: nothing is opened unless an opener is injected.
    if (!openFile && pinnedDirectories.length) throw new CodedError(403, "当前环境限制了可执行的命令，未打开终端。", "command-not-allowed");
    notRunning(planId);
    const stored = plans.take(planId);
    for (const step of stored.steps) await assertRunnable(step.program);
    const script = terminalScript({ title: stored.title, steps: stored.steps, pathEntries: await pathFor(stored.steps[0].program), platform });
    const directory = await mkdtemp(path.join(tempRoot, "skill-control-update-"));
    await chmod(directory, 0o700);
    const file = path.join(directory, script.name);
    await writeFile(file, script.content, { encoding: "utf8", mode: 0o700 });
    await chmod(file, 0o700);
    await (openFile || openScript)(file, platform);
    const historyEntry = await record(stored, { ok: null, steps: stored.steps.map((step) => ({ display: step.display })), mode: "terminal" });
    return { opened: true, afterCheck: { kind: "version", id: stored.id }, historyEntry };
  }

  /** POST /api/agent-versions/open { id }: `open -b <bundle id>` so the app can check for updates itself. */
  async function openApp({ id } = {}) {
    const { row } = await findRow(String(id || ""));
    if (row.kind !== "app" || !row.internal?.bundleId || !/^[\w.-]{1,200}$/u.test(row.internal.bundleId)) throw new CodedError(409, "这个产品不是桌面应用。", "refused");
    if (platform !== "darwin") throw new CodedError(409, "只在 macOS 上支持打开应用。", "unsupported");
    // Sandboxes and tests pin commands: the real `open` runs only when nothing is pinned.
    if (!launch && pinnedDirectories.length) throw new CodedError(403, "当前环境限制了可执行的命令，未打开应用。", "command-not-allowed");
    await (launch || launchApp)(row.internal.bundleId);
    return { opened: true, bundleId: row.internal.bundleId };
  }

  return { view, check, start, stop, cacheFile, plan, apply, terminal, job, openApp };
}

/** Starts an app by bundle id (macOS `open -b`, detached, no shell). */
function launchApp(bundleId) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", ["-b", bundleId], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
