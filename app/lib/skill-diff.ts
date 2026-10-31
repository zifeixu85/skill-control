import { asArray, asOptionalNumber, asOptionalString, asRecord, asString } from "./parse";
import type { SkillInstance } from "./types";
import type { SkillView } from "./skill-model";

/**
 * 版本不同: compare two copies of one skill (GET /api/skill-diff, /api/skill-diff-file) and
 * update the older copies from the newest (/api/sync, copy mode: backup first, undoable).
 */

export type FileChange = "modified" | "left-only" | "right-only" | "type-changed";

export interface SkillDiff {
  summary: { modified: number; leftOnly: number; rightOnly: number; typeChanged: number; total: number };
  entries: { path: string; change: FileChange }[];
  truncated: boolean;
}

export interface DiffLine {
  kind: "context" | "added" | "removed" | "skip";
  text: string;
  leftNumber: number | null;
  rightNumber: number | null;
}

export interface DiffFile {
  path: string;
  previewKind: "text" | "image" | "unavailable";
  lines: DiffLine[];
  truncated: boolean;
  reason: string | null;
}

const CHANGES: FileChange[] = ["modified", "left-only", "right-only", "type-changed"];
const KINDS: DiffLine["kind"][] = ["context", "added", "removed", "skip"];

export function normalizeSkillDiff(raw: unknown): SkillDiff {
  const record = asRecord(raw);
  const summary = asRecord(record.summary);
  const count = (key: string) => Math.max(0, Number(summary[key]) || 0);
  return {
    summary: { modified: count("modified"), leftOnly: count("leftOnly"), rightOnly: count("rightOnly"), typeChanged: count("typeChanged"), total: count("total") },
    entries: asArray(record.entries)
      .map((value) => {
        const entry = asRecord(value);
        const change = asString(entry.change) as FileChange;
        return { path: asString(entry.path), change: CHANGES.includes(change) ? change : "modified" };
      })
      .filter((entry) => entry.path),
    truncated: record.truncated === true,
  };
}

export function normalizeDiffFile(raw: unknown): DiffFile {
  const record = asRecord(raw);
  const kind = asString(record.previewKind);
  return {
    path: asString(record.path),
    previewKind: kind === "text" || kind === "image" ? kind : "unavailable",
    lines: asArray(record.lines).map((value) => {
      const line = asRecord(value);
      const lineKind = asString(line.kind) as DiffLine["kind"];
      return { kind: KINDS.includes(lineKind) ? lineKind : "context", text: asString(line.text), leftNumber: asOptionalNumber(line.leftNumber), rightNumber: asOptionalNumber(line.rightNumber) };
    }),
    truncated: record.truncated === true,
    reason: asOptionalString(record.reason),
  };
}

/** In each run of changed lines, the old lines ("-") come before the new ones ("+"), like a usual diff. */
export function orderChanges(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = () => {
    out.push(...run.filter((line) => line.kind === "removed"), ...run.filter((line) => line.kind === "added"));
    run = [];
  };
  for (const line of lines) {
    if (line.kind === "added" || line.kind === "removed") run.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}

/** Left = the newest copy, right = an older one: "added" lines are what the newest adds. */
export const CHANGE_LABELS: Record<FileChange, string> = {
  modified: "内容不同",
  "left-only": "只在较新的一份里",
  "right-only": "只在较旧的一份里",
  "type-changed": "类型不同",
};

export interface VersionGap {
  newest: SkillInstance;
  /** Older copies that can be overwritten (writable, not the newest's own folder). */
  older: SkillInstance[];
}

/**
 * For a skill whose copies differ: the newest copy and the older writable ones, one per Agent
 * the service lists as behind. Null when there's nothing to compare.
 */
export function versionGap(view: SkillView): VersionGap | null {
  const newestId = view.skill.newest?.instanceId;
  const newest = view.skill.instances.find((instance) => instance.id === newestId) || null;
  if (!view.differs || !newest) return null;
  const older = (view.skill.behind || [])
    .map((agentId) => (view.writable[agentId] || []).find((instance) => instance.hash !== newest.hash) || null)
    .filter((instance): instance is SkillInstance => Boolean(instance));
  return older.length ? { newest, older } : null;
}
