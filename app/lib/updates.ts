import {
  asArray,
  asNumber,
  asOptionalNumber,
  asOptionalString,
  asRecord,
  asString,
  asStringList,
} from "./parse";

/** Shapes from docs/ARCHITECTURE.md · 更新检测与执行, parsed tolerantly. */

export type UpdateStatus =
  | "update-available"
  | "locally-modified"
  | "conflict"
  | "managed-by-host"
  | "unknown-source"
  | "check-failed"
  | "unchecked"
  | "up-to-date";

export type ActionKind = "self" | "delegate" | "guide" | "none";
export type ConflictChoice = "keep-local" | "overwrite" | "save-as";

export interface UpdateUnit {
  unitKey: string;
  title: string;
  sourceType: string;
  sourceLabel: string;
  owner: string;
  confidence: string;
  instances: { agentId: string; path: string }[];
  status: UpdateStatus;
  current: string | null;
  latest: string | null;
  changes: { title: string }[];
  lockDrift: boolean;
  localModified: boolean;
  stale: boolean;
  reason: string | null;
  checkedAt: string | null;
  error: { kind: string; message: string; resetAt: string | null } | null;
  action: { kind: ActionKind; label: string; command: string | null };
  binaries: { path: string; version: string; hermes: boolean }[];
  possibleSource: string | null;
}

export interface CheckJob {
  state: "idle" | "running" | "done" | "error";
  startedAt: string | null;
  finishedAt: string | null;
  done: number;
  total: number;
  requests: number;
  hosts: string[];
  error: string | null;
}

export interface UpdatesData {
  checkedAt: string | null;
  hosts: string[];
  allowedHosts: string[];
  github: { remaining: number | null; resetAt: string | null } | null;
  counts: Record<string, number>;
  units: UpdateUnit[];
  job: CheckJob;
}

export interface PlanStep {
  type: string;
  description: string | null;
  path: string | null;
  backup: string | null;
  agentId: string | null;
  alsoVisibleTo: string[];
  command: string | null;
}

export type UpdatePlan =
  | { kind: "choice"; unitKey: string; status: string; choices: ConflictChoice[]; message: string }
  | {
      kind: "plan";
      planId: string;
      unitKey: string;
      action: "self" | "delegate" | "none";
      expiresAt: string | null;
      steps: PlanStep[];
      changes: { added: string[]; modified: string[]; removed: string[] } | null;
      notes: string[];
    }
  | { kind: "guide"; unitKey: string; instructions: string; command: string | null }
  /** A self/delegate answer without a plan id: never confirmable, never shown as a guide. */
  | { kind: "incomplete"; unitKey: string; message: string };

export interface ApplyResult {
  kind: "self" | "delegate" | "none";
  ok: boolean;
  changed: { agentId: string; path: string; backup: string | null }[];
  lockBackup: string | null;
  savedAs: string | null;
  commands: { command: string; exitCode: number | null; stdout: string; stderr: string }[];
  historyId: string | null;
}

export interface UnitChanges {
  source: string;
  changes: { sha: string | null; title: string; date: string | null }[];
  error: string | null;
}

export const STATUS_ORDER: UpdateStatus[] = [
  "update-available",
  "conflict",
  "locally-modified",
  "check-failed",
  "unchecked",
  "unknown-source",
  "managed-by-host",
  "up-to-date",
];

export const STATUS_LABELS: Record<UpdateStatus, string> = {
  "update-available": "有新版本",
  "locally-modified": "本地改过",
  conflict: "两边都改过",
  "managed-by-host": "由宿主管理",
  "unknown-source": "来源未知",
  "check-failed": "检查失败",
  unchecked: "未检查",
  "up-to-date": "已是最新",
};

export const STATUS_HINTS: Record<UpdateStatus, string> = {
  "update-available": "上游有新内容，本地没有改过，可以直接更新。",
  "locally-modified": "你在本地改过，上游没有变化。更新会覆盖你的修改，所以默认不动。",
  conflict: "上游有新内容，你在本地也改过。更新前需要选择怎么处理本地修改。",
  "managed-by-host": "由安装它的产品负责更新（如 Codex、Hermes、QClaw），这里只显示。",
  "unknown-source": "找不到来源记录，无法判断是否有新版本；只能看出本地是否被改过。",
  "check-failed": "这次检查没能拿到上游信息，可以稍后重试。",
  unchecked: "还没有检查过。",
  "up-to-date": "和上游一致。",
};

export const STATUS_TONES: Record<UpdateStatus, "ok" | "warn" | "danger" | "info" | "mute"> = {
  "update-available": "info",
  "locally-modified": "warn",
  conflict: "danger",
  "managed-by-host": "mute",
  "unknown-source": "mute",
  "check-failed": "danger",
  unchecked: "mute",
  "up-to-date": "ok",
};

export const CHOICE_TEXT: Record<ConflictChoice, { title: string; detail: string }> = {
  "keep-local": { title: "保留本地版本", detail: "不改动任何文件，下次检查时仍会提示。" },
  overwrite: { title: "用上游覆盖", detail: "先把本地版本备份到 ~/.agent-skill-manager/backups，再替换成上游内容。" },
  "save-as": { title: "另存本地版本再更新", detail: "先把本地版本复制为同级的「名称@local」，再更新成上游内容，两份都保留。" },
};

export const STEP_LABELS: Record<string, string> = {
  download: "下载",
  "save-as": "另存本地版本",
  replace: "替换",
  lock: "更新锁文件",
  "keep-local": "保留本地",
  command: "运行命令",
};

const STATUSES = new Set<string>(STATUS_ORDER);

export function normalizeCheckJob(value: unknown): CheckJob {
  const job = asRecord(value);
  const state = asString(job.state, "idle");
  return {
    state: (["idle", "running", "done", "error"].includes(state) ? state : "idle") as CheckJob["state"],
    startedAt: asOptionalString(job.startedAt),
    finishedAt: asOptionalString(job.finishedAt),
    done: asNumber(job.done),
    total: asNumber(job.total),
    requests: asNumber(job.requests),
    hosts: asStringList(job.hosts),
    error: asOptionalString(job.error),
  };
}


function normalizeUnit(value: unknown): UpdateUnit | null {
  const unit = asRecord(value);
  const unitKey = asString(unit.unitKey);
  if (!unitKey) return null;
  const status = asString(unit.status, "unchecked");
  const action = asRecord(unit.action);
  const actionKind = asString(action.kind, "none");
  const error = asRecord(unit.error);
  return {
    unitKey,
    title: asString(unit.title, unitKey),
    sourceType: asString(unit.sourceType, "unknown"),
    sourceLabel: asString(unit.sourceLabel),
    owner: asString(unit.owner, "unknown"),
    confidence: asString(unit.confidence, "none"),
    instances: asArray(unit.instances)
      .map((item) => ({ agentId: asString(asRecord(item).agentId), path: asString(asRecord(item).path) }))
      .filter((item) => item.path),
    status: (STATUSES.has(status) ? status : "unchecked") as UpdateStatus,
    current: asOptionalString(unit.current),
    latest: asOptionalString(unit.latest),
    changes: asArray(unit.changes)
      .map((item) => ({ title: asString(asRecord(item).title) }))
      .filter((item) => item.title),
    lockDrift: unit.lockDrift === true,
    localModified: unit.localModified === true,
    stale: unit.stale === true,
    reason: asOptionalString(unit.reason),
    checkedAt: asOptionalString(unit.checkedAt),
    error: Object.keys(error).length
      ? { kind: asString(error.kind), message: asString(error.message, "检查失败。"), resetAt: asOptionalString(error.resetAt) }
      : null,
    action: {
      kind: (["self", "delegate", "guide"].includes(actionKind) ? actionKind : "none") as ActionKind,
      label: asString(action.label),
      command: asOptionalString(action.command),
    },
    binaries: asArray(unit.binaries).map((item) => {
      const binary = asRecord(item);
      return { path: asString(binary.path), version: asString(binary.version), hermes: binary.hermes === true };
    }),
    possibleSource: asOptionalString(unit.possibleSource),
  };
}

export function normalizeUpdates(raw: unknown): UpdatesData {
  const record = asRecord(raw);
  const github = asRecord(record.github);
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(asRecord(record.counts))) counts[key] = asNumber(value);
  return {
    checkedAt: asOptionalString(record.checkedAt),
    hosts: asStringList(record.hosts),
    allowedHosts: asStringList(record.allowedHosts),
    github: Object.keys(github).length
      ? { remaining: asOptionalNumber(github.remaining), resetAt: asOptionalString(github.resetAt) }
      : null,
    counts,
    units: asArray(record.units)
      .map(normalizeUnit)
      .filter((unit): unit is UpdateUnit => Boolean(unit)),
    job: normalizeCheckJob(record.job),
  };
}

export function normalizePlan(raw: unknown): UpdatePlan {
  const record = asRecord(raw);
  const unitKey = asString(record.unitKey);
  if (record.requiresChoice === true) {
    const choices = asStringList(record.choices).filter((choice): choice is ConflictChoice =>
      ["keep-local", "overwrite", "save-as"].includes(choice),
    );
    return {
      kind: "choice",
      unitKey,
      status: asString(record.status),
      choices: choices.length ? choices : ["keep-local", "overwrite", "save-as"],
      message: asString(record.message),
    };
  }
  const planId = asOptionalString(record.planId);
  const kind = asString(record.kind, "none");
  if (!planId && (kind === "self" || kind === "delegate")) {
    return { kind: "incomplete", unitKey, message: "服务返回的计划不完整（缺少计划编号），不能执行。请重新生成计划。" };
  }
  if (!planId) {
    return { kind: "guide", unitKey, instructions: asString(record.instructions), command: asOptionalString(record.command) };
  }
  const changes = asRecord(record.changes);
  return {
    kind: "plan",
    planId,
    unitKey,
    action: (["self", "delegate"].includes(kind) ? kind : "none") as "self" | "delegate" | "none",
    expiresAt: asOptionalString(record.expiresAt),
    steps: asArray(record.steps).map((item) => {
      const step = asRecord(item);
      return {
        type: asString(step.type),
        description: asOptionalString(step.description),
        path: asOptionalString(step.path),
        backup: asOptionalString(step.backup),
        agentId: asOptionalString(step.agentId),
        alsoVisibleTo: asStringList(step.alsoVisibleTo),
        command: asOptionalString(step.command),
      };
    }),
    changes: Object.keys(changes).length
      ? { added: asStringList(changes.added), modified: asStringList(changes.modified), removed: asStringList(changes.removed) }
      : null,
    notes: asStringList(record.notes),
  };
}

export function normalizeApply(raw: unknown): ApplyResult {
  const record = asRecord(raw);
  const kind = asString(record.kind, "none");
  const commands = asArray(record.commands).map((item) => {
    const command = asRecord(item);
    return {
      command: asString(command.command),
      exitCode: asOptionalNumber(command.exitCode),
      stdout: asString(command.stdout),
      stderr: asString(command.stderr),
    };
  });
  return {
    kind: (["self", "delegate"].includes(kind) ? kind : "none") as ApplyResult["kind"],
    ok: typeof record.ok === "boolean" ? record.ok : commands.every((command) => command.exitCode === 0),
    changed: asArray(record.changed).map((item) => {
      const change = asRecord(item);
      return { agentId: asString(change.agentId), path: asString(change.path), backup: asOptionalString(change.backup) };
    }),
    lockBackup: asOptionalString(record.lockBackup),
    savedAs: asOptionalString(record.savedAs),
    commands,
    historyId: asOptionalString(asRecord(record.historyEntry).id),
  };
}

export function normalizeChanges(raw: unknown): UnitChanges {
  const record = asRecord(raw);
  return {
    source: asString(record.source),
    changes: asArray(record.changes).map((item) => {
      const change = asRecord(item);
      return { sha: asOptionalString(change.sha), title: asString(change.title), date: asOptionalString(change.date) };
    }),
    error: asOptionalString(asRecord(record.error).message) || asOptionalString(record.error),
  };
}

export function groupUnits(units: UpdateUnit[]): { status: UpdateStatus; units: UpdateUnit[] }[] {
  return STATUS_ORDER.map((status) => ({
    status,
    units: units
      .filter((unit) => unit.status === status)
      .sort((left, right) => left.title.localeCompare(right.title, "zh-Hans-CN")),
  })).filter((group) => group.units.length > 0);
}

/** Badge for the 更新 nav item: things the user can act on. */
export function actionableCount(data: UpdatesData | undefined): number {
  if (!data) return 0;
  return data.units.filter((unit) => unit.status === "update-available" || unit.status === "conflict").length;
}

/** The update unit that holds any of these skill instance paths. */
export function unitForPaths(units: UpdateUnit[], paths: string[]): UpdateUnit | null {
  const wanted = new Set(paths);
  return units.find((unit) => unit.instances.some((instance) => wanted.has(instance.path))) || null;
}

export const shortRevision = (value: string | null) =>
  value && /^[a-f0-9]{12,}$/i.test(value) ? value.slice(0, 7) : value;
