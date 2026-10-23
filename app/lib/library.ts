import { historyIdOf } from "./history";
import { asArray, asOptionalString, asRecord, asString, asStringList, type UnknownRecord } from "./parse";

/** Shapes from docs/ARCHITECTURE.md · 统一技能库与 CLI 工具卡片, parsed tolerantly. */

export type Tier = "native" | "config" | "link" | "none";
export type FanoutState = "visible" | "hidden" | "missing" | "duplicate" | "private-copy" | "none";
export type EntryKind = "real" | "link-internal" | "link-external" | "broken";

export interface Fanout {
  tier: Tier;
  state: FanoutState;
  reason: string | null;
  path: string | null;
}

export interface LibraryEntry {
  name: string;
  kind: EntryKind;
  target: string | null;
  hash: string | null;
  externalManaged: string | null;
  source: string | null;
  fanout: Record<string, Fanout>;
  /** When the skill came into the library (v0.2). */
  installedAt: string | null;
}

export interface LibraryAgent {
  agentId: string;
  name: string;
  tier: Tier;
  primary: boolean;
  collapsed: boolean;
  notes: string;
  directories: string[];
}

export interface LibraryIssue {
  id: string;
  severity: string;
  title: string;
  detail: string;
  agentId: string | null;
  names: string[];
}

export interface TrashItem {
  trashId: string;
  name: string;
  removedAt: string | null;
  links: string[];
}

export interface LibraryData {
  root: string;
  realRoot: string | null;
  exists: boolean;
  owner: { realPath: string; manager: string | null; appInstalled: boolean | null } | null;
  entries: LibraryEntry[];
  agents: LibraryAgent[];
  issues: LibraryIssue[];
  trash: TrashItem[];
}

export type LibraryAction = "adopt" | "link" | "unlink" | "disable" | "remove" | "batch";

export interface PlanStepItem {
  type: string;
  path: string | null;
  from: string | null;
  to: string | null;
  target: string | null;
  command: string | null;
  diff: string | null;
}

export interface LibraryPlanItem {
  id: string;
  title: string;
  kind: string;
  skill: string;
  agentId: string | null;
  choices: string[];
  choice: string;
  requiresChoice: boolean;
  steps: PlanStepItem[];
}

export interface LibraryPlan {
  planId: string | null;
  action: string;
  expiresAt: string | null;
  needsChoice: number;
  message: string | null;
  summary: Record<string, number>;
  items: LibraryPlanItem[];
}

export interface LibraryApplyResult {
  results: { id: string; title: string; status: string; error: string | null; trashId: string | null }[];
  backups: string[];
  visibility: Record<string, Record<string, Fanout>>;
  /** Set when the service recorded an entry it can undo. */
  historyId: string | null;
}

export const TIER_LABELS: Record<Tier, string> = {
  native: "原生读取",
  config: "配置额外目录",
  link: "逐个链接",
  none: "复制",
};

export const TIER_HINTS: Record<Tier, string> = {
  native: "直接读取 ~/.agents/skills，不需要链接",
  config: "在配置里把技能库加为额外目录",
  link: "在它自己的技能目录里为每个技能建一个指向库的链接",
  none: "不读取技能库，只用它自己的副本",
};

export const KIND_LABELS: Record<EntryKind, string> = {
  real: "实体",
  "link-internal": "库内链接",
  "link-external": "指向库外",
  broken: "失效",
};

export const STATE_LABELS: Record<FanoutState, string> = {
  visible: "可见",
  hidden: "被隐藏",
  missing: "看不到",
  duplicate: "重复",
  "private-copy": "独立副本",
  none: "不适用",
};

export const ITEM_KIND_LABELS: Record<string, string> = {
  adopt: "收编进技能库",
  dedupe: "Codex 去重",
  link: "改为链接",
  conflict: "冲突",
  external: "外部托管",
  config: "配置额外目录",
  unlink: "取消链接",
  disable: "停用",
  remove: "移到回收站",
  instructions: "需要手动处理",
};

/** Batch review sections, in the order the user should read them. */
export const BATCH_SECTIONS: { title: string; kinds: string[] }[] = [
  { title: "收编反向链接", kinds: ["adopt"] },
  { title: "Codex 去重", kinds: ["dedupe"] },
  { title: "改为链接", kinds: ["link"] },
  { title: "配置额外目录", kinds: ["config"] },
  { title: "冲突", kinds: ["conflict"] },
  { title: "外部托管（不搬动）", kinds: ["external", "instructions"] },
];

export const CHOICE_LABELS: Record<string, { title: string; detail: string }> = {
  "keep-library": { title: "保留库里的版本", detail: "这个 Agent 的副本先备份，再改为链接到库。" },
  "use-this": { title: "用这个 Agent 的版本", detail: "库里的版本先备份，再换成这个 Agent 的内容。" },
  "save-as": { title: "两份都留", detail: "把这个 Agent 的版本另存为「名称@Agent」放进库里。" },
  skip: { title: "先不处理", detail: "什么都不改。" },
  adopt: { title: "收编", detail: "" },
  link: { title: "处理", detail: "" },
};

export const STEP_TYPE_LABELS: Record<string, string> = {
  backup: "备份",
  move: "移动",
  stash: "移走（可恢复）",
  unlink: "删除链接",
  link: "建立链接",
  write: "改写文件",
  command: "运行命令",
};

function fanoutOf(value: unknown): Fanout {
  const record = asRecord(value);
  return {
    tier: (["native", "config", "link"].includes(asString(record.tier)) ? record.tier : "none") as Tier,
    state: (["visible", "hidden", "missing", "duplicate", "private-copy"].includes(asString(record.state))
      ? record.state
      : "none") as FanoutState,
    reason: asOptionalString(record.reason),
    path: asOptionalString(record.path),
  };
}

function fanoutMap(value: unknown): Record<string, Fanout> {
  return Object.fromEntries(Object.entries(asRecord(value)).map(([agentId, item]) => [agentId, fanoutOf(item)]));
}

export function normalizeLibrary(raw: unknown): LibraryData {
  const record = asRecord(raw);
  const owner = asRecord(record.owner);
  return {
    root: asString(record.root, "~/.agents/skills"),
    realRoot: asOptionalString(record.realRoot),
    exists: record.exists !== false,
    owner: Object.keys(owner).length
      ? {
          realPath: asString(owner.realPath),
          manager: asOptionalString(owner.manager),
          appInstalled: typeof owner.appInstalled === "boolean" ? owner.appInstalled : null,
        }
      : null,
    entries: asArray(record.entries)
      .map((value) => {
        const entry = asRecord(value);
        const kind = asString(entry.kind, "real");
        const locks = asRecord(entry.sourceFromLocks);
        return {
          name: asString(entry.name),
          kind: (["real", "link-internal", "link-external", "broken"].includes(kind) ? kind : "real") as EntryKind,
          target: asOptionalString(entry.target),
          hash: asOptionalString(entry.hash),
          externalManaged: asOptionalString(entry.externalManaged),
          source: asOptionalString(locks.source),
          fanout: fanoutMap(entry.fanout),
          installedAt: asOptionalString(entry.installedAt),
        };
      })
      .filter((entry) => entry.name),
    agents: asArray(record.agents)
      .map((value) => {
        const agent = asRecord(value);
        return {
          agentId: asString(agent.agentId),
          name: asString(agent.name, asString(agent.agentId)),
          tier: (["native", "config", "link"].includes(asString(agent.tier)) ? agent.tier : "none") as Tier,
          primary: agent.primary === true,
          collapsed: agent.collapsed === true,
          notes: asString(agent.notes),
          directories: asStringList(agent.directories),
        };
      })
      .filter((agent) => agent.agentId),
    issues: asArray(record.issues).map((value, index) => {
      const issue = asRecord(value);
      return {
        id: asString(issue.id, `issue-${index}`),
        severity: asString(issue.severity, "info"),
        title: asString(issue.title),
        detail: asString(issue.detail),
        agentId: asOptionalString(issue.agentId),
        names: asStringList(issue.names),
      };
    }),
    trash: asArray(record.trash).map((value) => {
      const item = asRecord(value);
      return {
        trashId: asString(item.trashId),
        name: asString(item.name),
        removedAt: asOptionalString(item.removedAt),
        links: asStringList(item.links),
      };
    }),
  };
}

function stepOf(value: unknown): PlanStepItem {
  const step = asRecord(value);
  return {
    type: asString(step.type),
    path: asOptionalString(step.path),
    from: asOptionalString(step.from),
    to: asOptionalString(step.to),
    target: asOptionalString(step.target),
    command: asOptionalString(step.command),
    diff: asOptionalString(step.diff),
  };
}

export function normalizeLibraryPlan(raw: unknown): LibraryPlan {
  const record = asRecord(raw);
  const summary: Record<string, number> = {};
  for (const [key, value] of Object.entries(asRecord(record.summary))) summary[key] = Number(value) || 0;
  return {
    planId: asOptionalString(record.planId),
    action: asString(record.action),
    expiresAt: asOptionalString(record.expiresAt),
    needsChoice: Number(record.needsChoice) || 0,
    message: asOptionalString(record.message),
    summary,
    items: asArray(record.items).map((value, index) => {
      const item: UnknownRecord = asRecord(value);
      return {
        id: asString(item.id, `item-${index}`),
        title: asString(item.title),
        kind: asString(item.kind),
        skill: asString(item.skill),
        agentId: asOptionalString(item.agentId),
        choices: asStringList(item.choices),
        choice: asString(item.choice, "skip"),
        requiresChoice: item.requiresChoice === true,
        steps: asArray(item.steps).map(stepOf),
      };
    }),
  };
}

export function normalizeLibraryApply(raw: unknown): LibraryApplyResult {
  const record = asRecord(raw);
  return {
    results: asArray(record.results).map((value) => {
      const result = asRecord(value);
      return {
        id: asString(result.id),
        title: asString(result.title),
        status: asString(result.status, "failed"),
        error: asOptionalString(result.error),
        trashId: asOptionalString(result.trashId),
      };
    }),
    // The service sends one backup folder as a string; older drafts sent a list.
    backups: typeof record.backups === "string" ? asStringList([record.backups]) : asStringList(record.backups),
    visibility: Object.fromEntries(Object.entries(asRecord(record.visibility)).map(([skill, value]) => [skill, fanoutMap(value)])),
    historyId: historyIdOf(record),
  };
}

/** Per-Agent counts for the strip at the top of the 技能库 page. */
export function agentCounts(data: LibraryData, agentId: string) {
  const counts = { visible: 0, hidden: 0, duplicate: 0, missing: 0, privateCopy: 0 };
  const reasons = new Map<string, number>();
  for (const entry of data.entries) {
    const fanout = entry.fanout[agentId];
    if (!fanout) continue;
    if (fanout.state === "visible") counts.visible += 1;
    else if (fanout.state === "hidden") counts.hidden += 1;
    else if (fanout.state === "duplicate") counts.duplicate += 1;
    else if (fanout.state === "missing") counts.missing += 1;
    else if (fanout.state === "private-copy") counts.privateCopy += 1;
    if (fanout.reason && fanout.state !== "visible") reasons.set(fanout.reason, (reasons.get(fanout.reason) || 0) + 1);
  }
  const topReasons = [...reasons.entries()].sort((left, right) => right[1] - left[1]).slice(0, 2).map(([reason]) => reason);
  return { ...counts, topReasons };
}

/** The value sent back to the planner when an item's checkbox is ticked. */
export function enabledChoice(item: LibraryPlanItem): string {
  return item.choices.find((choice) => choice !== "skip") || item.choice;
}

export const isLibraryPath = (path: string, root = "~/.agents/skills") => path === root || path.startsWith(`${root}/`);
