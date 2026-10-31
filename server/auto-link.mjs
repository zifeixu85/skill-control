import { watch as fsWatch } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertSafeWrite } from "./home-guard.mjs";
import { tierOf } from "./library-agents.mjs";
import { DEFAULT_LIBRARY_SETTINGS, normalizeLibrarySettings } from "./library-settings.mjs";
import { withStateLock } from "./state-lock.mjs";

/**
 * Auto-link (v0.3 §2): a skill that arrives in the library reaches the chosen Agents on its
 * own — a relative link for link-tier Agents, a copy for Agents that skip links — through
 * the same items, lock and history as everything else (library-plan.mjs `autoLink`).
 *
 * Rules:
 * - Only "missing" pairs (the Agent has nothing with that name) are touched; an Agent's own
 *   copy is never replaced, Hermes' config is never changed without a confirmation, and Agents
 *   of other tiers are left alone.
 * - Baseline: when auto-link is turned on (and on the first run after an upgrade) the names
 *   already in the library are recorded; their gaps are not filled automatically but offered
 *   as the one-off catch-up plan. An Agent that joins the scope later gets its own baseline.
 * - A pair is connected once ("handled"); if it goes missing afterwards (the user removed
 *   the link) it is not reconnected. Removing one in the app, the CLI or by undo writes a
 *   tombstone (`skip`), which manual linking clears again.
 *
 * State: ~/.agent-skill-manager/auto-link.json (0600), written under the library lock:
 * { version, baseline: { at, names, agents }, agentBaselines: { [agentId]: { at, names } },
 *   handled: { "<agent>:<skill>": at }, skip: { "<agent>:<skill>": at }, runs: [...],
 *   effectivePrimaryAgentIds, updatedAt }. The on/off switch and scope live in config.json.
 */

export const AUTO_LINK_STATE_FILE = "auto-link.json";
const RUN_LIMIT = 20;
const SKIP_LIMIT = 5_000;
const NAME = /^[\p{L}\p{N}_.@+ -]{1,128}$/u;
const DEFAULT_DEBOUNCE_MS = 2_000;

export const pairKey = (agentId, skill) => `${agentId}:${skill}`;

const emptyState = () => ({ version: 1, baseline: null, agentBaselines: {}, handled: {}, skip: {}, runs: [], effectivePrimaryAgentIds: null, updatedAt: null });

const stringList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
const stampMap = (value) => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {}).filter(([key, at]) => typeof key === "string" && typeof at === "string"));

/** The state file, normalized (missing or broken files read as empty). */
export async function readAutoLinkState(stateDirectory) {
  let value;
  try {
    value = JSON.parse(await readFile(path.join(stateDirectory, AUTO_LINK_STATE_FILE), "utf8"));
  } catch {
    return emptyState();
  }
  const baseline = value?.baseline && typeof value.baseline === "object" && typeof value.baseline.at === "string"
    ? { at: value.baseline.at, names: stringList(value.baseline.names), agents: stringList(value.baseline.agents) }
    : null;
  const agentBaselines = {};
  for (const [agentId, item] of Object.entries(value?.agentBaselines || {})) {
    if (item && typeof item.at === "string") agentBaselines[agentId] = { at: item.at, names: stringList(item.names) };
  }
  return {
    version: 1,
    baseline,
    agentBaselines,
    handled: stampMap(value?.handled),
    skip: stampMap(value?.skip),
    runs: Array.isArray(value?.runs) ? value.runs.filter((run) => run && typeof run.at === "string").slice(0, RUN_LIMIT) : [],
    effectivePrimaryAgentIds: Array.isArray(value?.effectivePrimaryAgentIds) ? stringList(value.effectivePrimaryAgentIds) : null,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null,
  };
}

async function writeAutoLinkState(stateDirectory, homeDirectory, state) {
  const file = path.join(stateDirectory, AUTO_LINK_STATE_FILE);
  await assertSafeWrite(file, homeDirectory);
  await mkdir(stateDirectory, { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

/** Agents auto-link serves: link / copy / config tiers, primary only unless the scope is "all". */
export const scopeAgents = (agents, scope) =>
  agents.filter((agent) => ["link", "copy", "config"].includes(tierOf(agent.agentId)) && (scope === "all" || agent.primary));

/**
 * One run's decision, without I/O. `entries` / `agents` come from the library view
 * (library.mjs `internal`). Returns the next state (baseline set and pruned), the pairs to
 * connect now, the baseline gaps per Agent (catch-up), Hermes' pending confirmation and
 * per-pair flags for the API.
 */
export function computeAutoLink({ entries, agents, settings, state, now = Date.now() }) {
  const at = new Date(now).toISOString();
  const names = entries.map((entry) => entry.name);
  const present = new Set(names);
  const next = {
    ...state,
    agentBaselines: { ...state.agentBaselines },
    handled: Object.fromEntries(Object.entries(state.handled).filter(([key]) => present.has(key.slice(key.indexOf(":") + 1)))),
    skip: { ...state.skip },
  };
  // While auto-link is off, every gap of the scope is a catch-up candidate and nothing is automatic.
  const inScope = scopeAgents(agents, settings.scope);
  const everything = new Set(names);
  if (settings.enabled) {
    // The first run after turning auto-link on: what is already there is the baseline.
    if (!next.baseline) next.baseline = { at, names: [...names], agents: inScope.map((agent) => agent.agentId) };
    next.baseline = { ...next.baseline, names: next.baseline.names.filter((name) => present.has(name)) };
    for (const agent of inScope) {
      if (next.baseline.agents.includes(agent.agentId)) continue;
      next.agentBaselines[agent.agentId] = next.agentBaselines[agent.agentId]
        ? { ...next.agentBaselines[agent.agentId], names: next.agentBaselines[agent.agentId].names.filter((name) => present.has(name)) }
        : { at, names: [...names] };
    }
  }
  const connect = [];
  const pending = {};
  const flags = new Map();
  const needs = new Map();
  let skipped = 0;
  for (const agent of inScope) {
    const tier = tierOf(agent.agentId);
    const baseline = !settings.enabled ? everything : new Set(next.baseline.agents.includes(agent.agentId) ? next.baseline.names : next.agentBaselines[agent.agentId]?.names || []);
    for (const entry of entries) {
      if (entry.kind === "broken" || !NAME.test(entry.name) || entry.fanout?.[agent.agentId]?.state !== "missing") continue;
      const key = pairKey(agent.agentId, entry.name);
      if (next.skip[key] || next.handled[key]) {
        skipped += 1;
        flags.set(key, { skipped: true });
        continue;
      }
      if (tier === "config") {
        needs.set(agent.agentId, [...(needs.get(agent.agentId) || []), entry.name]);
        continue;
      }
      if (!agent.linkDir) continue;
      if (baseline.has(entry.name)) {
        (pending[agent.agentId] ||= []).push(entry.name);
        flags.set(key, { catchUp: true, autoLinkable: false });
      } else {
        connect.push({ agentId: agent.agentId, skill: entry.name });
        flags.set(key, { autoLinkable: true, next: true });
      }
    }
  }
  const needsConfirmation = [...needs].map(([agentId, missing]) => ({
    agentId,
    kind: "config",
    id: "hermes-external-dirs",
    title: "让 Hermes 读取技能库（skills.external_dirs），需要你确认后修改配置",
    missing: missing.length,
  }));
  return { state: next, connect, pending, needsConfirmation, configMissing: Object.fromEntries(needs), skipped, flags, inScope: inScope.map((agent) => agent.agentId) };
}

/** Run records for the API: the skills connected, by skill, with their history units. */
function runRecord({ at, reason, origin, result }) {
  const bySkill = new Map();
  for (const item of result.results.filter((entry) => entry.status === "applied")) {
    const current = bySkill.get(item.skill) || { skill: item.skill, agents: [], unitIds: [] };
    current.agents.push(item.agentId);
    current.unitIds.push(item.id);
    bySkill.set(item.skill, current);
  }
  const historyId = result.historyEntry?.id || null;
  return {
    at,
    reason,
    origin,
    historyId,
    items: [...bySkill.values()].map((item) => ({ ...item, historyId })),
    failed: result.results.filter((entry) => entry.status !== "applied").map((entry) => ({ skill: entry.skill, agentId: entry.agentId || null, status: entry.status, error: entry.error || null })),
  };
}

/**
 * `context`: { homeDirectory, stateDirectory, manager (library-plan), getConfig() → config with
 * resolved primaryAgentIds and `library`, saveSettings(autoLink) → persists config.library.autoLink,
 * onRun?(record), readOnly, watchImpl, debounceMs, now }.
 */
export function createAutoLinker(context) {
  const now = context.now || (() => Date.now());
  const settingsOf = (config) => normalizeLibrarySettings(config?.library).autoLink || DEFAULT_LIBRARY_SETTINGS.autoLink;
  let running = null;
  let rerun = false;
  let timer = null;
  const watchers = new Map();
  let watching = false;

  const locked = (task) => (context.readOnly ? task() : withStateLock(context.stateDirectory, task, { label: context.label || "Skill Control 自动接入" }));
  const save = (state) => (context.readOnly ? Promise.resolve() : writeAutoLinkState(context.stateDirectory, context.homeDirectory, { ...state, updatedAt: new Date(now()).toISOString() }));

  async function decide(config, { library } = {}) {
    const snapshot = library || (await context.manager.snapshot());
    const state = await readAutoLinkState(context.stateDirectory);
    const settings = settingsOf(config);
    return { snapshot, state, settings, decision: computeAutoLink({ entries: snapshot.entries, agents: snapshot.agents, settings, state, now: now() }) };
  }

  /** One reconcile: baseline bookkeeping, then link / copy the new skills. `dryRun` writes nothing. */
  async function runOnce({ reason = "manual", origin = "auto", dryRun = false } = {}) {
    const config = await context.getConfig();
    const settings = settingsOf(config);
    if (!settings.enabled) return { enabled: false, connected: [], pending: {}, needsConfirmation: [], dryRun };
    const work = async () => {
      const { decision } = await decide(config);
      const summary = { enabled: true, scope: settings.scope, connect: decision.connect, pending: Object.fromEntries(Object.entries(decision.pending).map(([agentId, list]) => [agentId, list.length])), needsConfirmation: decision.needsConfirmation, dryRun };
      if (dryRun || context.readOnly) return { ...summary, connected: [], dryRun: true };
      await save({ ...decision.state, effectivePrimaryAgentIds: config.primaryAgentIds || null });
      if (!decision.connect.length) return { ...summary, connected: [] };
      const result = await context.manager.autoLink(decision.connect, { origin });
      const record = runRecord({ at: new Date(now()).toISOString(), reason, origin, result });
      const latest = await readAutoLinkState(context.stateDirectory);
      // The pairs tried are handled even when they failed: a failing pair is not retried in a loop.
      const handled = { ...latest.handled };
      for (const pair of decision.connect) handled[pairKey(pair.agentId, pair.skill)] ||= record.at;
      await save({ ...latest, handled, runs: [record, ...latest.runs].slice(0, RUN_LIMIT) });
      await context.onRun?.(record);
      return { ...summary, connected: record.items, failed: record.failed, historyId: record.historyId };
    };
    return locked(work);
  }

  /** Runs now, or once more after the current run (never two at a time in this process). */
  function run(options = {}) {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        let result = await runOnce(options);
        while (rerun) {
          rerun = false;
          result = await runOnce({ ...options, reason: "rerun" });
        }
        return result;
      } finally {
        running = null;
        rearm().catch(() => {});
      }
    })();
    return running;
  }

  /** Debounced trigger (scans, file-system events). */
  function schedule(reason = "watch") {
    if (context.disabled) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run({ reason }).catch((error) => context.onError?.(error));
    }, context.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    timer.unref?.();
  }

  /** Watches the library and the in-scope Agents' link folders (first level only). */
  async function rearm() {
    if (!watching) return;
    const config = await context.getConfig();
    const snapshot = await context.manager.snapshot();
    const settings = settingsOf(config);
    const directories = new Set([snapshot.libraryPath, ...(settings.enabled ? scopeAgents(snapshot.agents, settings.scope).map((agent) => agent.linkDir).filter(Boolean) : [])]);
    for (const [directory, watcher] of watchers) {
      if (!directories.has(directory)) {
        watcher.close();
        watchers.delete(directory);
      }
    }
    for (const directory of directories) {
      if (watchers.has(directory) || !(await stat(directory).catch(() => null))?.isDirectory()) continue;
      try {
        const watcher = (context.watchImpl || fsWatch)(directory, { persistent: false }, () => schedule("watch"));
        watcher.on?.("error", () => {
          watcher.close();
          watchers.delete(directory);
        });
        watchers.set(directory, watcher);
      } catch {
        // A folder that cannot be watched is still covered by scans and `skill-control sync`.
      }
    }
  }

  async function start() {
    if (context.disabled) return;
    watching = !context.noWatch;
    await rearm().catch(() => {});
    schedule("startup");
  }

  function stop() {
    watching = false;
    clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  }

  /** The `autoLink` block of GET /api/library, plus per-pair flags for the fanout. */
  async function describe(config, library) {
    const settings = settingsOf(config);
    const { state, decision } = await decide(config, { library });
    const lastRun = state.runs[0] || null;
    return {
      block: {
        enabled: settings.enabled,
        scope: settings.scope,
        // null until the first run after turning auto-link on records the baseline.
        baselineAt: settings.enabled ? state.baseline?.at || null : null,
        pending: Object.fromEntries(Object.entries(decision.pending).map(([agentId, list]) => [agentId, list.length])),
        next: decision.connect.length,
        needsConfirmation: decision.needsConfirmation,
        skipped: Object.keys(state.skip).length,
        lastRun: lastRun ? { at: lastRun.at, reason: lastRun.reason, items: lastRun.items, failed: lastRun.failed || [] } : null,
        watching: watchers.size > 0,
      },
      flags: decision.flags,
    };
  }

  /** POST /api/library/auto-link { enabled, scope }: turning it on records a fresh baseline. */
  async function setSettings({ enabled, scope }) {
    if (context.readOnly) throw Object.assign(new Error("只读模式下不修改设置。"), { statusCode: 409, code: "read-only" });
    const config = await context.getConfig();
    const previous = settingsOf(config);
    const next = { enabled: typeof enabled === "boolean" ? enabled : previous.enabled, scope: ["primary", "all"].includes(scope) ? scope : previous.scope };
    await locked(async () => {
      await context.saveSettings(next);
      if (next.enabled && !previous.enabled) {
        const state = await readAutoLinkState(context.stateDirectory);
        await save({ ...state, baseline: null, agentBaselines: {} });
      }
    });
    if (next.enabled) await run({ reason: "settings" });
    return next;
  }

  /** Tombstones and handled pairs after manual changes (library apply, uninstall, undo). */
  async function record({ connected = [], removed = [] }) {
    if (context.readOnly || (!connected.length && !removed.length)) return;
    await locked(async () => {
      const state = await readAutoLinkState(context.stateDirectory);
      const handled = { ...state.handled };
      const skip = { ...state.skip };
      const at = new Date(now()).toISOString();
      for (const { agentId, skill } of connected) {
        handled[pairKey(agentId, skill)] = at;
        delete skip[pairKey(agentId, skill)];
      }
      for (const { agentId, skill } of removed) skip[pairKey(agentId, skill)] = at;
      const trimmed = Object.fromEntries(Object.entries(skip).sort((left, right) => right[1].localeCompare(left[1])).slice(0, SKIP_LIMIT));
      await save({ ...state, handled, skip: trimmed });
    });
  }

  /**
   * Library-plan hook: links / copies made by hand are handled; removals are tombstones, and
   * so are the Agents an install left unticked (`skip`, from the plan).
   */
  async function onApplied({ action, items, skip = [] }) {
    if (action === "auto-link") return;
    const pairs = (item) => (item.agents || []).map((agentId) => ({ agentId, skill: item.skill }));
    await record({
      connected: items.filter((item) => ["link", "copy", "dedupe", "conflict", "adopt"].includes(item.kind)).flatMap(pairs),
      // "取消接入" and the link-removing "disable" of link-tier Agents are tombstones.
      removed: [...items.filter((item) => item.kind === "unlink" || (item.kind === "disable" && item.ops?.some((op) => op.op === "unlink"))).flatMap(pairs), ...skip],
    });
  }

  /**
   * The Agents auto-link would connect a new library skill to (link / copy tiers in the
   * current scope), minus `keep`. Installing for some Agents only tombstones these, so the
   * skill does not reach them a moment later.
   */
  async function unpickedAgents(keep = [], { snapshot = null } = {}) {
    const config = await context.getConfig();
    const agents = (snapshot || (await context.manager.snapshot())).agents;
    const kept = new Set(keep);
    return scopeAgents(agents, settingsOf(config).scope)
      .filter((agent) => ["link", "copy"].includes(tierOf(agent.agentId)) && !kept.has(agent.agentId))
      .map((agent) => agent.agentId);
  }

  /** Catch-up: the baseline gaps of the Agents asked for (all in scope by default), as a library plan. */
  async function catchUpPlan({ agents = null, choices = {} } = {}) {
    const config = await context.getConfig();
    const { decision } = await decide(config);
    const wanted = Array.isArray(agents) && agents.length ? new Set(agents) : null;
    const pairs = [];
    // Link / copy gaps, and Hermes' gaps (they become its config item, opt-in in the plan).
    for (const [agentId, names] of [...Object.entries(decision.pending), ...Object.entries(decision.configMissing)]) {
      if (!wanted || wanted.has(agentId)) for (const skill of names) pairs.push({ agentId, skill });
    }
    return context.manager.plan({ action: "catch-up", pairs, choices });
  }

  return { run, schedule, start, stop, describe, setSettings, record, onApplied, unpickedAgents, catchUpPlan, locked, readState: () => readAutoLinkState(context.stateDirectory) };
}
