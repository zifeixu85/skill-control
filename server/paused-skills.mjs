import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isWithin } from "./fs-safe.mjs";
import { assertSafeWrite } from "./home-guard.mjs";
import { withStateLock } from "./state-lock.mjs";

/**
 * Paused library skills (暂停此技能). A pause turns one skill off in every Agent that can
 * see it, each in its own way, and remembers how, so 恢复 can turn exactly those back on:
 *
 *   { version: 1, skills: { "<skill>": { pausedAt, agents: { "<agentId>": how } } } }
 *
 * `how` is { method: "switch" } (the Agent's own config switch), { method: "unlink", path }
 * (a link-tier Agent's link to the library, removed) or { method: "stash", path, stash } (an
 * Agent's own copy, moved under the state folder). Paths are relative to the home.
 * The record is a memory, not the truth: an Agent counts as paused only while what the pause
 * did is still in place (`pausedNow`), so an undo from history or a manual change ends it.
 */

export const PAUSED_FILE = "paused-skills.json";
export const PAUSED_FOLDER = "paused";
const METHODS = new Set(["switch", "unlink", "stash"]);

const exists = async (target) => Boolean(await lstat(target).catch(() => null));
const relativePath = (value) => typeof value === "string" && value && !path.isAbsolute(value) && !value.split(/[\\/]/u).includes("..");

function normalizeHow(value) {
  if (!value || typeof value !== "object" || !METHODS.has(value.method)) return null;
  if (value.method === "switch") return { method: "switch" };
  if (!relativePath(value.path)) return null;
  if (value.method === "unlink") return { method: "unlink", path: value.path };
  return relativePath(value.stash) ? { method: "stash", path: value.path, stash: value.stash } : null;
}

/** The record, normalized (missing or broken files read as empty). */
export async function readPausedSkills(stateDirectory) {
  let value;
  try {
    value = JSON.parse(await readFile(path.join(stateDirectory, PAUSED_FILE), "utf8"));
  } catch {
    return { version: 1, skills: {} };
  }
  const skills = {};
  for (const [name, item] of Object.entries(value?.skills && typeof value.skills === "object" ? value.skills : {})) {
    const agents = Object.fromEntries(
      Object.entries(item?.agents && typeof item.agents === "object" ? item.agents : {})
        .map(([agentId, how]) => [agentId, normalizeHow(how)])
        .filter(([, how]) => how),
    );
    if (Object.keys(agents).length) skills[name] = { pausedAt: typeof item.pausedAt === "string" ? item.pausedAt : null, agents };
  }
  return { version: 1, skills };
}

async function writePausedSkills(stateDirectory, homeDirectory, value) {
  const file = path.join(stateDirectory, PAUSED_FILE);
  await assertSafeWrite(file, homeDirectory);
  await mkdir(stateDirectory, { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

/** Absolute path of a recorded home-relative path, or null when it would leave the home. */
export function expandRecorded(homeDirectory, value) {
  if (!relativePath(value)) return null;
  const absolute = path.join(homeDirectory, value);
  return isWithin(homeDirectory, absolute) ? absolute : null;
}

/**
 * Whether what the pause did for one Agent is still in place. `agent` and `entry` are the
 * library's internal shapes (switches, fanout).
 */
async function stillPaused(how, { name, agent, entry, homeDirectory }) {
  if (how.method === "switch") return Boolean(agent.switches?.disabled?.has(name));
  if (how.method === "unlink") return entry.fanout?.[agent.agentId]?.state === "missing";
  const stash = expandRecorded(homeDirectory, how.stash);
  return Boolean(stash) && (await exists(stash));
}

/**
 * Skills paused right now: name → { since, agents (still paused), record (every recorded Agent) }.
 * `library`: the library's internal `{ entries, agents }`.
 */
export async function pausedNow(stateDirectory, library, homeDirectory) {
  const record = await readPausedSkills(stateDirectory);
  const result = new Map();
  for (const [name, item] of Object.entries(record.skills)) {
    const entry = library.entries.find((candidate) => candidate.name === name);
    if (!entry) continue;
    const agents = [];
    for (const [agentId, how] of Object.entries(item.agents)) {
      const agent = library.agents.find((candidate) => candidate.agentId === agentId);
      if (agent && (await stillPaused(how, { name, agent, entry, homeDirectory }))) agents.push(agentId);
    }
    if (agents.length) result.set(name, { since: item.pausedAt, agents, record: item.agents });
  }
  return result;
}

const addAgent = (skills, skill, agentId, how, at) => {
  const current = skills[skill] || { pausedAt: at, agents: {} };
  return { ...skills, [skill]: { ...current, agents: { ...current.agents, [agentId]: how } } };
};

const dropAgent = (skills, skill, agentId) => {
  const current = skills[skill];
  if (!current?.agents[agentId]) return skills;
  const agents = Object.fromEntries(Object.entries(current.agents).filter(([id]) => id !== agentId));
  const next = { ...skills };
  if (Object.keys(agents).length) next[skill] = { ...current, agents };
  else delete next[skill];
  return next;
};

/**
 * Keeps the record in step with what happened: a pause adds the Agents it turned off, a
 * resume removes the ones it turned back on, an undo from history does the opposite. After
 * every library run the record also drops Agents that are not off any more (turned back on
 * by hand, or already on when 恢复 ran), so a later manual 停用 is never taken for a pause.
 */
export function createPausedStore({ stateDirectory, homeDirectory, readOnly = false, now = () => Date.now() }) {
  async function save(before, skills) {
    if (JSON.stringify(before.skills) !== JSON.stringify(skills)) await writePausedSkills(stateDirectory, homeDirectory, { version: 1, skills });
  }

  /** Agents of a skill still in the library whose pause is no longer in place. */
  async function prune(skills, library) {
    let next = skills;
    for (const [name, item] of Object.entries(skills)) {
      const entry = library.entries.find((candidate) => candidate.name === name);
      if (!entry) continue;
      for (const [agentId, how] of Object.entries(item.agents)) {
        const agent = library.agents.find((candidate) => candidate.agentId === agentId);
        if (agent && !(await stillPaused(how, { name, agent, entry, homeDirectory }))) next = dropAgent(next, name, agentId);
      }
    }
    return next;
  }

  /** Library-plan hook (runs inside the state lock); `library` is the snapshot after the run. */
  async function onApplied({ action, items = [], library = null }) {
    if (readOnly) return;
    const before = await readPausedSkills(stateDirectory);
    if (action !== "pause" && action !== "resume" && !Object.keys(before.skills).length) return;
    const at = new Date(now()).toISOString();
    let skills = before.skills;
    for (const item of items) {
      const agentId = item.agents?.[0];
      if (!agentId || !item.skill) continue;
      const how = normalizeHow(item.pause);
      if (action === "pause" && item.kind === "pause" && how) skills = addAgent(skills, item.skill, agentId, how, at);
      if (action === "resume" && item.kind === "resume") skills = dropAgent(skills, item.skill, agentId);
    }
    if (library) skills = await prune(skills, library);
    await save(before, skills);
  }

  /** Undo from history: an undone pause step is no pause; an undone resume step is one again. */
  async function onRestored({ unpaused = [], repaused = [] } = {}) {
    if (readOnly || (!unpaused.length && !repaused.length)) return;
    await withStateLock(stateDirectory, async () => {
      const before = await readPausedSkills(stateDirectory);
      let skills = before.skills;
      for (const { agentId, skill } of unpaused) skills = dropAgent(skills, skill, agentId);
      const at = new Date(now()).toISOString();
      for (const { agentId, skill, how } of repaused) {
        const normalized = normalizeHow(how);
        if (normalized) skills = addAgent(skills, skill, agentId, normalized, at);
      }
      await save(before, skills);
    });
  }

  return { onApplied, onRestored, read: () => readPausedSkills(stateDirectory) };
}
