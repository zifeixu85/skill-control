import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { compactHomePath, object, scrubTokens, text } from "./fs-safe.mjs";
import { defaultSearchDirectories, findCommand } from "./path-lookup.mjs";
import { resolveUpdateUnits } from "./provenance.mjs";
import { CACHE_VERSION, emptyCache, runUpdateCheck, unitStatus } from "./update-check.mjs";
import { commandLine, createUpdateExecutor, runCommand, UpdateError } from "./update-apply.mjs";
import { createTransport, TransportError, UPDATE_HOSTS } from "./update-transport.mjs";

/**
 * Update detection and execution for the HTTP routes: resolves units from the latest
 * scan, keeps upstream facts in ~/.agent-skill-manager/update-cache.json and first-seen
 * baselines in update-baselines.json, runs manual checks as a background job and plans /
 * applies updates through the executor.
 */

const STATUS_ORDER = ["conflict", "update-available", "locally-modified", "check-failed", "unchecked", "up-to-date", "managed-by-host", "unknown-source"];
const DEFAULT_MAX_REQUESTS = 80;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

const isGstack = (unit) => unit.sourceType === "git" && /garrytan\/gstack/iu.test(unit.check?.url || "");

/** Suggested action for a unit in its current state. */
function actionFor(unit, view, tools, display) {
  const actionable = ["update-available", "conflict"].includes(view.status);
  const none = { kind: "none", label: view.status === "up-to-date" ? "已是最新" : "无需操作" };
  const cmd = (tool, name, args) => commandLine({ file: tool || name, args }, display);
  switch (unit.sourceType) {
    case "skills-cli":
      return actionable ? { kind: "self", label: view.status === "conflict" ? "更新（需选择如何处理本地修改）" : "用 Skill Control 更新" } : none;
    case "lark-cli": {
      const binary = unit.binaries?.find((item) => !item.hermes) || unit.binaries?.[0];
      return actionable ? { kind: "delegate", label: "用 lark-cli 更新", command: cmd(binary?.absolutePath, "lark-cli", ["update", "--json"]) } : none;
    }
    case "claude-plugin": {
      const { plugin, marketplace, scope } = unit.sourceRef;
      const scopeArgs = scope && scope !== "user" ? ["-s", scope] : [];
      return actionable
        ? {
            kind: "delegate",
            label: "用 Claude Code 更新（完成后需重启）",
            command: `${cmd(tools.claude, "claude", ["plugin", "marketplace", "update", marketplace])} && ${cmd(tools.claude, "claude", ["plugin", "update", `${plugin}@${marketplace}`, "--json", ...scopeArgs])}`,
          }
        : none;
    }
    case "codex-marketplace":
      return actionable ? { kind: "delegate", label: "用 Codex 更新插件市场", command: cmd(tools.codex, "codex", ["plugin", "marketplace", "upgrade", unit.sourceRef.marketplace, "--json"]) } : none;
    case "git":
      if (!actionable) return none;
      return isGstack(unit)
        ? { kind: "guide", label: "在 Claude Code 中运行 /gstack-upgrade 更新 gstack。", command: "/gstack-upgrade" }
        : { kind: "delegate", label: "工作区干净时快进更新（git pull --ff-only）", command: cmd(tools.git, "git", ["-C", unit.gitRoot, "pull", "--ff-only"]) };
    case "hermes-hub":
      return { kind: "delegate", label: "用 Hermes 更新这个技能", command: cmd(tools.hermes, "hermes", ["skills", "update", unit.title]) };
    case "host":
      return unit.hostGuide ? { kind: "guide", label: unit.hostGuide } : { kind: "none", label: "由宿主自动管理" };
    case "codex-remote-plugin":
      return actionable ? { kind: "guide", label: "远程插件由 Codex 管理，请在 Codex 的插件页面更新。" } : none;
    case "workbuddy-marketplace":
      return actionable ? { kind: "guide", label: "WorkBuddy 会自动下载新版插件市场，重启 WorkBuddy 即可。" } : none;
    case "workbuddy-skillhub":
      return actionable ? { kind: "guide", label: "请在 WorkBuddy 的技能市场中更新这个技能。" } : none;
    case "clawhub":
      return actionable ? { kind: "guide", label: "请在 OpenClaw 中用 clawhub 更新。", command: `clawhub update ${unit.check.slug}` } : none;
    default:
      return none;
  }
}

export function createUpdateService({
  homeDirectory,
  homes,
  stateDirectory,
  backupDirectory,
  historyFile,
  getScan,
  getAgents,
  getConfig = async () => ({}),
  materialize,
  fetchImpl = globalThis.fetch,
  lsRemoteImpl = null,
  run = runCommand,
  searchDirectories = null,
  restrictCommands = false,
  maxRequests = DEFAULT_MAX_REQUESTS,
  now = () => Date.now(),
}) {
  const cacheFile = path.join(stateDirectory, "update-cache.json");
  const baselinesFile = path.join(stateDirectory, "update-baselines.json");
  const display = (value) => compactHomePath(value, homes);
  let job = { state: "idle", startedAt: null, finishedAt: null, done: 0, total: 0, requests: 0, hosts: [], error: null };
  let jobPromise = Promise.resolve();
  let directories = searchDirectories;

  const dirs = async () => (directories ||= await defaultSearchDirectories({ homeDirectory }));
  const loadCache = async () => {
    const value = await readJson(cacheFile, null);
    return value?.version === CACHE_VERSION ? { ...emptyCache(), ...value } : emptyCache();
  };

  async function resolveUnits() {
    const baselines = await readJson(baselinesFile, { version: 1, units: {} });
    baselines.units ||= {};
    const { units, changed } = await resolveUpdateUnits({
      scan: await getScan(),
      homeDirectory,
      homes,
      searchDirectories: await dirs(),
      baselines,
      now: now(),
    });
    if (changed) await writeJsonAtomic(baselinesFile, baselines);
    return units;
  }

  async function tools() {
    const list = await dirs();
    return Object.fromEntries(await Promise.all(["claude", "codex", "git", "hermes"].map(async (name) => [name, await findCommand(name, list)])));
  }

  function publicUnit(unit, factsEntry, toolPaths) {
    const view = unitStatus(unit, factsEntry);
    const action = actionFor(unit, view, toolPaths, display);
    const changes = [
      ...(view.newSkills || []).map((name) => ({ title: `新增官方技能 ${name}` })),
      ...(view.changelog ? [{ title: scrubTokens(view.changelog) }] : []),
    ];
    return {
      unitKey: unit.unitKey,
      title: unit.title,
      sourceType: unit.sourceType,
      sourceLabel: unit.sourceLabel,
      owner: unit.owner,
      confidence: unit.confidence,
      instances: unit.publicInstances.slice(0, 50),
      instanceCount: unit.publicInstances.length,
      status: view.status,
      current: view.current ?? null,
      latest: view.latest ?? null,
      ...(changes.length ? { changes } : {}),
      ...(view.lockDrift ? { lockDrift: true } : {}),
      ...(view.localModified ? { localModified: true } : {}),
      ...(view.reason ? { reason: view.reason } : {}),
      ...(factsEntry?.error && factsEntry.upstream ? { stale: true } : {}),
      checkedAt: factsEntry?.checkedAt || null,
      ...(factsEntry?.error ? { error: factsEntry.error } : {}),
      action,
      ...(unit.binaries ? { binaries: unit.binaries.map((binary) => ({ path: binary.path, version: binary.version, hermes: binary.hermes })) } : {}),
      ...(unit.pluginPath ? { pluginPath: unit.pluginPath } : {}),
      ...(unit.possibleSource ? { possibleSource: `github.com/${unit.possibleSource}` } : {}),
    };
  }

  async function view() {
    const [units, cache, toolPaths] = await Promise.all([resolveUnits(), loadCache(), tools()]);
    const list = units
      .map((unit) => publicUnit(unit, cache.facts[unit.unitKey], toolPaths))
      .sort((left, right) => STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status) || left.title.localeCompare(right.title));
    const counts = {};
    for (const unit of list) counts[unit.status] = (counts[unit.status] || 0) + 1;
    return {
      checkedAt: cache.checkedAt,
      hosts: cache.hosts,
      allowedHosts: UPDATE_HOSTS,
      github: cache.github?.resetAt ? { remaining: cache.github.remaining ?? null, resetAt: new Date(cache.github.resetAt).toISOString() } : null,
      counts,
      units: list,
      job: { ...job },
    };
  }

  /** `gh auth token`, only when the user enabled it; kept in memory for one check. */
  async function githubToken() {
    const config = await getConfig();
    if (object(config.updates).useGhAuth !== true) return null;
    const gh = await findCommand("gh", await dirs());
    if (!gh) return null;
    const result = await run(gh, ["auth", "token"], { timeoutMs: 5_000, env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "" } });
    const token = String(result.stdout || "").trim();
    return result.exitCode === 0 && /^[\w-]{20,255}$/u.test(token) ? token : null;
  }

  function transportFor(budget, cache, token = null) {
    return createTransport({
      fetchImpl,
      lsRemoteImpl,
      maxRequests: budget,
      githubToken: token,
      rateLimit: cache?.github ? { remaining: cache.github.remaining ?? null, resetAt: cache.github.resetAt ?? null } : {},
    });
  }

  async function check({ unitKeys = null, budget = maxRequests } = {}) {
    const units = (await resolveUnits()).filter((unit) => !unitKeys || unitKeys.includes(unit.unitKey));
    const cache = await loadCache();
    const transport = transportFor(budget, cache, await githubToken().catch(() => null));
    const summary = await runUpdateCheck({
      units,
      transport,
      cache,
      now: now(),
      onProgress: ({ done, total }) => Object.assign(job, { done, total }),
    });
    await writeJsonAtomic(cacheFile, cache);
    return summary;
  }

  function startCheck(options = {}) {
    if (job.state === "running") return { ...job };
    job = { state: "running", startedAt: new Date(now()).toISOString(), finishedAt: null, done: 0, total: 0, requests: 0, hosts: [], error: null };
    jobPromise = check(options)
      .then((summary) => Object.assign(job, { state: "done", requests: summary.requests, hosts: summary.hosts }))
      .catch((error) => Object.assign(job, { state: "error", error: text(String(error?.message || "检查失败。"), 200) }))
      .finally(() => {
        job.finishedAt = new Date(now()).toISOString();
      });
    return publicJob();
  }

  const publicJob = () => ({ ...job });

  async function changes(unitKey) {
    const units = await resolveUnits();
    const unit = units.find((item) => item.unitKey === unitKey);
    if (!unit) throw new UpdateError(404, "找不到这个更新单元。");
    const cache = await loadCache();
    const facts = cache.facts[unit.unitKey]?.upstream || {};
    const transport = transportFor(3, cache);
    const commits = (list) =>
      (Array.isArray(list) ? list : []).slice(0, 20).map((item) => ({
        sha: String(object(item).sha || "").slice(0, 7),
        title: text(scrubTokens(String(object(object(item).commit).message || "").split("\n")[0]), 160),
        date: object(object(object(item).commit).committer).date || object(object(object(item).commit).author).date || null,
      }));
    try {
      if (unit.sourceType === "skills-cli") {
        const since = unit.installed.updatedAt ? `&since=${encodeURIComponent(unit.installed.updatedAt)}` : "";
        const folder = unit.check.folder ? `&path=${encodeURIComponent(unit.check.folder)}` : "";
        const response = await transport.getJson(`https://api.github.com/repos/${unit.check.repo}/commits?per_page=20${folder}${since}`);
        return { unitKey, source: "github", changes: commits(response.json) };
      }
      const repo = unit.sourceType === "claude-plugin" ? facts.commitRepo || unit.check?.repo : /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(unit.check?.url || "")?.[1];
      const from = unit.installed.commit;
      const to = facts.latestCommit;
      if (repo && from && to && from !== to) {
        const response = await transport.getJson(`https://api.github.com/repos/${repo}/compare/${from}...${to}`);
        return { unitKey, source: "github", changes: commits(object(response.json).commits).reverse() };
      }
    } catch (error) {
      if (error instanceof TransportError) return { unitKey, source: "github", changes: [], error: { kind: error.kind, message: error.message } };
      throw error;
    }
    const view = publicUnit(unit, cache.facts[unit.unitKey], {});
    return { unitKey, source: "local", changes: view.changes || [] };
  }

  const executor = createUpdateExecutor({
    homeDirectory,
    homes,
    stateDirectory,
    backupDirectory,
    historyFile,
    findCommand: async (name) => findCommand(name, await dirs()),
    getAgents,
    transportFactory: (budget) => transportFor(budget, null),
    // With a pinned command list, nothing outside it may ever be executed.
    allowedCommandRoots: restrictCommands ? searchDirectories.map((item) => item.directory) : null,
    materialize,
    run,
    now,
  });

  async function plan({ unitKey, choice = null }) {
    const units = await resolveUnits();
    const unit = units.find((item) => item.unitKey === unitKey);
    if (!unit) throw new UpdateError(404, "找不到这个更新单元。");
    const cache = await loadCache();
    const view = publicUnit(unit, cache.facts[unit.unitKey], await tools());
    return executor.plan({ unit, view, facts: cache.facts[unit.unitKey], cache, choice });
  }

  // After an update the unit's local state changes; statuses recompute from the cached
  // upstream facts on the next view, without a new request.
  const apply = (input) => executor.apply(input);

  /** Cached statuses for the health report (no network). */
  async function cachedStatuses() {
    const [units, cache] = await Promise.all([resolveUnits(), loadCache()]);
    return units.map((unit) => ({ ...publicUnit(unit, cache.facts[unit.unitKey], {}), sourceType: unit.sourceType }));
  }

  return { view, startCheck, checkStatus: publicJob, waitForCheck: () => jobPromise, check, changes, plan, apply, cachedStatuses };
}
