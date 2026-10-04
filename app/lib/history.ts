import { asArray, asOptionalString, asRecord, asString, asStringList } from "./parse";

/** Shapes from docs/ARCHITECTURE.md · 历史、恢复与卸载. */

export interface HistoryBackup {
  agentId: string;
  path: string;
  target: string;
  restorable: boolean;
  reason: string | null;
}

export interface HistoryItem {
  id: string;
  at: string | null;
  action: string;
  skill: string | null;
  agents: string[];
  mode: string | null;
  backups: HistoryBackup[];
  trashId: string | null;
  /** Undo units of library applies and CLI fixes (one per item / file). */
  units: { id: string; title: string }[];
  restorable: boolean;
  reason: string | null;
}

export interface RestoreStep {
  type: string;
  agentId: string | null;
  target: string;
  from: string | null;
  precondition: string | null;
  trashId: string | null;
}

export interface RestoreUnit {
  id: string;
  title: string;
  selected: boolean;
  /** Changed since that write (or the place is taken); off by default, the user may opt in. */
  conflict: string | null;
  /** Can't be put back (backup gone, trash emptied); never selectable. */
  unrestorable: string | null;
  steps: { type: string; path: string; from: string | null }[];
}

export interface RestorePlan {
  /** Null when the service answered without a plan; such a plan can never be confirmed. */
  planId: string | null;
  historyId: string;
  steps: RestoreStep[];
  /** Present for per-unit undo (library applies, CLI fixes); empty for installs. */
  units: RestoreUnit[];
  warnings: string[];
  message: string | null;
  expiresAt: string | null;
}

export interface UninstallPlan {
  planId: string | null;
  kind: "link" | "real";
  steps: { type: string; path: string; to: string | null; description: string | null }[];
  alsoAffects: string[];
  warning: string | null;
  expiresAt: string | null;
}

export interface TrashEntry {
  trashId: string;
  name: string;
  source: string;
  agentId: string | null;
  kind: string;
  originalPath: string;
  removedAt: string | null;
  links: string[];
}

export const HISTORY_ACTION_LABELS: Record<string, string> = {
  sync: "安装",
  import: "导入",
  update: "更新",
  restore: "撤销",
  uninstall: "移除",
  library: "整理技能库",
  "cli-fix": "修复命令行工具",
};

export const RESTORE_STEP_LABELS: Record<string, string> = {
  "restore-backup": "放回备份",
  "trash-created": "移到回收站",
  "restore-trash": "从回收站恢复",
  move: "移回原位",
  stash: "移走（可恢复）",
  unlink: "删除链接",
  link: "重建链接",
  write: "恢复文件",
  restoreFile: "恢复文件",
};

export const TRASH_SOURCE_LABELS: Record<string, string> = {
  library: "移出技能库",
  uninstall: "从 Agent 移除",
  restore: "撤销时移走",
};

export function normalizeHistory(raw: unknown): HistoryItem[] {
  return asArray(asRecord(raw).entries).map((value, index) => {
    const entry = asRecord(value);
    return {
      id: asString(entry.id, `history-${index}`),
      at: asOptionalString(entry.at),
      action: asString(entry.action),
      skill: asOptionalString(entry.skill),
      agents: asStringList(entry.agents),
      mode: asOptionalString(entry.mode),
      backups: asArray(entry.backups).map((item) => {
        const backup = asRecord(item);
        return {
          agentId: asString(backup.agentId),
          path: asString(backup.path),
          target: asString(backup.target),
          restorable: backup.restorable === true,
          reason: asOptionalString(backup.reason),
        };
      }),
      trashId: asOptionalString(entry.trashId),
      units: asArray(entry.units)
        .map((item) => ({ id: asString(asRecord(item).id), title: asString(asRecord(item).title) }))
        .filter((unit) => unit.id),
      restorable: entry.restorable === true,
      reason: asOptionalString(entry.reason),
    };
  });
}

export function normalizeRestorePlan(raw: unknown): RestorePlan {
  const record = asRecord(raw);
  return {
    planId: asOptionalString(record.planId),
    historyId: asString(record.historyId),
    steps: asArray(record.steps).map((item) => {
      const step = asRecord(item);
      return {
        type: asString(step.type),
        agentId: asOptionalString(step.agentId),
        target: asString(step.target),
        from: asOptionalString(step.from),
        precondition: asOptionalString(step.precondition),
        trashId: asOptionalString(step.trashId),
      };
    }),
    units: asArray(record.units)
      .map((item) => {
        const unit = asRecord(item);
        const unrestorable = asOptionalString(unit.unrestorable);
        return {
          id: asString(unit.id),
          title: asString(unit.title, asString(unit.id)),
          selected: unit.selected === true && !unrestorable,
          conflict: asOptionalString(unit.conflict),
          unrestorable,
          steps: asArray(unit.steps).map((value) => {
            const step = asRecord(value);
            return { type: asString(step.type), path: asString(step.path), from: asOptionalString(step.from) };
          }),
        };
      })
      .filter((unit) => unit.id),
    warnings: asStringList(record.warnings),
    message: asOptionalString(record.message),
    expiresAt: asOptionalString(record.expiresAt),
  };
}

/** The `select` list after toggling one unit, starting from what the service selected. */
export function toggleUnit(units: RestoreUnit[], id: string, on: boolean): string[] {
  return units
    .filter((unit) => !unit.unrestorable && (unit.id === id ? on : unit.selected))
    .map((unit) => unit.id);
}

export function normalizeUninstallPlan(raw: unknown): UninstallPlan {
  const record = asRecord(raw);
  return {
    planId: asOptionalString(record.planId),
    kind: asString(record.kind) === "link" ? "link" : "real",
    steps: asArray(record.steps).map((item) => {
      const step = asRecord(item);
      return {
        type: asString(step.type),
        path: asString(step.path),
        to: asOptionalString(step.to),
        description: asOptionalString(step.description),
      };
    }),
    alsoAffects: asStringList(record.alsoAffects),
    warning: asOptionalString(record.warning),
    expiresAt: asOptionalString(record.expiresAt),
  };
}

export function normalizeTrash(raw: unknown): TrashEntry[] {
  return asArray(asRecord(raw).items)
    .map((value) => {
      const item = asRecord(value);
      return {
        trashId: asString(item.trashId),
        name: asString(item.name),
        source: asString(item.source),
        agentId: asOptionalString(item.agentId),
        kind: asString(item.kind, "real"),
        originalPath: asString(item.originalPath),
        removedAt: asOptionalString(item.removedAt),
        links: asStringList(item.links),
      };
    })
    .filter((item) => item.trashId)
    .sort((left, right) => String(right.removedAt || "").localeCompare(String(left.removedAt || "")));
}

/**
 * History id carried by a write result, when the service says it can be undone. Entries
 * without an id (older services) or marked `restorable: false` offer no 撤销.
 */
export function historyIdOf(result: unknown): string | null {
  const entry = asRecord(asRecord(result).historyEntry);
  return entry.restorable === false ? null : asOptionalString(entry.id);
}
