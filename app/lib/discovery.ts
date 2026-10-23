import { asArray, asNumber, asOptionalString, asRecord, asString } from "./parse";
import type { AgentConfig, ManagerConfig, ScanAgent } from "./types";

/**
 * New Agents: ones the scan marks isNew (detected but not in knownAgentIds), and folders that
 * look like an Agent nobody knows yet (GET /api/agents/discover).
 */

export interface DiscoveryCandidate {
  id: string;
  guessName: string;
  /** ~/ path of the folder that holds skills/. */
  path: string;
  skillCount: number;
  appPath: string | null;
  reason: string;
}

export function normalizeDiscovery(raw: unknown): DiscoveryCandidate[] {
  return asArray(asRecord(raw).candidates)
    .map((value) => {
      const record = asRecord(value);
      return {
        id: asString(record.id),
        guessName: asString(record.guessName, asString(record.id)),
        path: asString(record.path),
        skillCount: asNumber(record.skillCount),
        appPath: asOptionalString(record.appPath),
        reason: asString(record.reason),
      };
    })
    .filter((candidate) => candidate.id && candidate.path);
}

/** Detected Agents the user hasn't seen yet. */
export function newAgents(agents: ScanAgent[]): ScanAgent[] {
  return agents.filter((agent) => agent.available && agent.isNew === true);
}

/** Candidates not already added or ignored. */
export function openCandidates(candidates: DiscoveryCandidate[], config: ManagerConfig | undefined): DiscoveryCandidate[] {
  const ignored = new Set(config?.ignoredDiscoveries || []);
  const known = new Set((config?.agents || []).map((agent) => agent.id));
  const paths = new Set((config?.agents || []).flatMap((agent) => agent.paths));
  return candidates.filter((candidate) => !ignored.has(candidate.id) && !ignored.has(candidate.path) && !known.has(candidate.id) && !paths.has(candidate.path));
}

const PALETTE = ["#6b7cf0", "#3c9d74", "#d9824a", "#b05fd0", "#3f8fc9", "#c9573f"];

/** A config entry for "添加为自定义 Agent"; the skills folder is the candidate's skills/. */
export function customAgentFrom(candidate: DiscoveryCandidate, existing: AgentConfig[]): AgentConfig {
  // Same id rules as the service: a–z, 0–9 and "-", at most 32 characters.
  const base = candidate.id.toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 28) || "custom";
  const taken = new Set(existing.map((agent) => agent.id));
  let id = base;
  for (let index = 2; taken.has(id); index += 1) id = `${base}-${index}`;
  const name = candidate.guessName.trim() || id;
  const skillsPath = /\/skills\/?$/u.test(candidate.path) ? candidate.path.replace(/\/$/u, "") : `${candidate.path.replace(/\/$/u, "")}/skills`;
  const hash = [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return { id, name, shortName: name.slice(0, 1).toUpperCase(), color: PALETTE[hash % PALETTE.length], paths: [skillsPath] };
}

/** Folders with the most skills first, then by name. */
export function sortCandidates(candidates: DiscoveryCandidate[]): DiscoveryCandidate[] {
  return [...candidates].sort((left, right) => right.skillCount - left.skillCount || left.guessName.localeCompare(right.guessName, "zh-Hans-CN"));
}

/** Ids of what is new right now: `agent:<id>` and `folder:<~/path>`. */
export function discoveryKeys(fresh: ScanAgent[], candidates: DiscoveryCandidate[]): string[] {
  return [...fresh.map((agent) => `agent:${agent.id}`), ...candidates.map((candidate) => `folder:${candidate.path}`)];
}

export function parseDismissed(text: string): Set<string> {
  try {
    const list = JSON.parse(text || "[]");
    return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function serializeDismissed(keys: Set<string>): string {
  // The newest keys win when the list gets long.
  return JSON.stringify([...keys].slice(-300));
}

/** The 首页 card stays hidden while everything new was already dismissed. */
export function allDismissed(keys: string[], dismissed: Set<string>): boolean {
  return keys.length > 0 && keys.every((key) => dismissed.has(key));
}
