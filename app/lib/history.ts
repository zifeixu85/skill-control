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

export interface RestorePlan {
  planId: string;
  historyId: string;
  steps: RestoreStep[];
  warnings: string[];
}

export interface UninstallPlan {
  planId: string;
  kind: "link" | "real";
  steps: { type: string; path: string; to: string | null; description: string | null }[];
  alsoAffects: string[];
  warning: string | null;
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
      restorable: entry.restorable === true,
      reason: asOptionalString(entry.reason),
    };
  });
}

export function normalizeRestorePlan(raw: unknown): RestorePlan {
  const record = asRecord(raw);
  return {
    planId: asString(record.planId),
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
    warnings: asStringList(record.warnings),
  };
}

export function normalizeUninstallPlan(raw: unknown): UninstallPlan {
  const record = asRecord(raw);
  return {
    planId: asString(record.planId),
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

/** History id carried by write results (sync / import / update / uninstall). */
export function historyIdOf(result: unknown): string | null {
  const entry = asRecord(asRecord(result).historyEntry);
  return asOptionalString(entry.id);
}
