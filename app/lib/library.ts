import { historyIdOf } from "./history";
import { asArray, asOptionalString, asRecord, asString, asStringList, type UnknownRecord } from "./parse";

/** Shapes from docs/ARCHITECTURE.md · 统一技能库与 CLI 工具卡片, parsed tolerantly. */

/** How an Agent gets library skills (v0.3 adds "copy"; "none" = not supported). */
export type Tier = "native" | "config" | "link" | "copy" | "none";
export type FanoutState = "visible" | "hidden" | "missing" | "duplicate" | "private-copy" | "none";
export type EntryKind = "real" | "link-internal" | "link-external" | "broken";

export interface Fanout {
  tier: Tier;
  state: FanoutState;
  reason: string | null;
  path: string | null;
  /** v0.3: auto-link may connect this pair (false after the user unlinked it, or when the tier needs consent). */
  autoLinkable: boolean | null;
  /** v0.3: the user took this pair out (取消接入 / 撤销); auto-link won't connect it again. */
  skipped: boolean;
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
  /** Config tier (Hermes): whether the library is already in its extra directories; null when unknown. */
  configured: boolean | null;
}

export type AutoLinkScope = "primary" | "all";

/** A config-tier Agent (Hermes) waiting for the user's yes before its config is changed. */
export interface AutoLinkConfirmation {
  agentId: string;
  id: string;
  title: string;
  /** Library skills it can't see until then. */
  missing: number;
}

/** v0.3 自动接入: new library skills are connected to Agents on their own. */
export interface AutoLink {
  enabled: boolean;
  scope: AutoLinkScope;
  /** Gaps that existed when it was turned on are left for 补齐接入. */
  baselineAt: string | null;
  /** Per Agent: library skills it can't see yet that 补齐接入 would connect. */
  pending: Record<string, number>;
  /** Pairs the next run will connect on its own. */
  next: number;
  needsConfirmation: AutoLinkConfirmation[];
  lastRun: {
    at: string | null;
    items: { skill: string; agents: string[]; historyId: string | null }[];
    failed: { skill: string; agentId: string | null; error: string | null }[];
  } | null;
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
  /** Null from services before v0.3. */
  autoLink: AutoLink | null;
  realRoot: string | null;
  exists: boolean;
  owner: { realPath: string; manager: string | null; appInstalled: boolean | null } | null;
  entries: LibraryEntry[];
  agents: LibraryAgent[];
  issues: LibraryIssue[];
  trash: TrashItem[];
}

export type LibraryAction = "adopt" | "link" | "unlink" | "disable" | "remove" | "batch" | "catch-up";

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

/** 接入方式 in plain words: how library skills reach an Agent. 接入 = "let this Agent read the skill". */
export const TIER_LABELS: Record<Tier, string> = {
  native: "会自动读取技能库",
  config: "通过额外目录读取",
  link: "需要逐个接入",
  copy: "需要复制一份",
  none: "不读取技能库",
};

/** What connecting one skill does, in a few words ("Claude Code（建链接）"). */
export const TIER_HOW: Record<Tier, string> = {
  native: "不用改动",
  config: "加一次额外目录",
  link: "建链接",
  copy: "复制一份",
  none: "不支持",
};

export const TIER_HINTS: Record<Tier, string> = {
  native: "它自己就读取 ~/.agents/skills，进库就能看到，不需要做任何事。",
  config: "在它的配置里加一次技能库目录（先征得你同意并备份），之后库里的技能它都能看到。",
  link: "在它自己的技能目录里为每个技能建一个指向库的链接。",
  copy: "它不认链接，只能各复制一份；库里的技能更新后再复制一次。",
  none: "暂时没有办法让它读取技能库里的技能。",
};

/** One line under each Agent card's title. */
export const TIER_SHORT: Record<Tier, string> = {
  native: "放进 ~/.agents/skills 的技能，它直接就能看到",
  config: "在它的配置里加一次技能库目录，之后都能看到",
  link: "每个技能在它的技能目录里建一个指向库的链接",
  copy: "它不认链接，每个技能复制一份",
  none: "暂时没有办法让它读取技能库",
};

export const KIND_LABELS: Record<EntryKind, string> = {
  real: "真实文件夹",
  "link-internal": "链接（库内）",
  "link-external": "链接到库外",
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
  adopt: "放进技能库",
  dedupe: "Codex 去重",
  add: "放进技能库",
  already: "库里已有",
  link: "接入（软链接）",
  copy: "接入（复制一份）",
  conflict: "冲突",
  external: "外部托管",
  config: "加进额外目录",
  unlink: "取消接入",
  disable: "停用",
  remove: "移到回收站",
  instructions: "需要手动处理",
};

/** Batch review sections, in the order the user should read them. */
export const BATCH_SECTIONS: { title: string; kinds: string[] }[] = [
  { title: "放进技能库", kinds: ["adopt"] },
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
  adopt: { title: "放进技能库", detail: "" },
  link: { title: "处理", detail: "" },
  "use-library": { title: "改用库里的版本", detail: "这个 Agent 的副本先备份，再改为接入库里的版本。" },
};

/** Installing a skill whose name the library already has with other content. */
const REPLACE_CHOICES: Record<string, { title: string; detail: string }> = {
  "use-new": { title: "用这次装的版本", detail: "库里的旧版本先备份，再换成新内容。" },
  "keep-library": { title: "保留库里的版本", detail: "不替换，直接用库里已有的那份接入。" },
};

/** The words for one choice of one plan item. */
export function choiceLabel(item: { id: string }, choice: string): { title: string; detail: string } {
  const replace = item.id.startsWith("replace:") ? REPLACE_CHOICES[choice] : undefined;
  return replace || CHOICE_LABELS[choice] || { title: choice, detail: "" };
}

export const STEP_TYPE_LABELS: Record<string, string> = {
  backup: "备份",
  move: "移动",
  stash: "移走（可恢复）",
  unlink: "删除链接",
  link: "建立链接",
  write: "改写文件",
  command: "运行命令",
};

const TIERS: Tier[] = ["native", "config", "link", "copy", "none"];
const tierOf = (value: unknown): Tier => (TIERS.includes(asString(value) as Tier) ? (asString(value) as Tier) : "none");

function fanoutOf(value: unknown): Fanout {
  const record = asRecord(value);
  return {
    tier: tierOf(record.tier),
    autoLinkable: typeof record.autoLinkable === "boolean" ? record.autoLinkable : null,
    skipped: record.skipped === true,
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
    autoLink: normalizeAutoLink(record.autoLink),
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
          tier: tierOf(agent.tier),
          configured: typeof agent.configured === "boolean" ? agent.configured : null,
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
  const counts = { visible: 0, hidden: 0, duplicate: 0, missing: 0, privateCopy: 0, skipped: 0 };
  const reasons = new Map<string, number>();
  // Why it can't see some: only the reasons of 看不到 / 被隐藏 (own copies are another story).
  const gapReasons = new Map<string, number>();
  for (const entry of data.entries) {
    const fanout = entry.fanout[agentId];
    if (!fanout) continue;
    if (fanout.state === "visible") counts.visible += 1;
    else if (fanout.state === "hidden") counts.hidden += 1;
    else if (fanout.state === "duplicate") counts.duplicate += 1;
    else if (fanout.state === "missing") counts.missing += 1;
    else if (fanout.state === "private-copy") counts.privateCopy += 1;
    if (fanout.state === "missing" && fanout.skipped) counts.skipped += 1;
    if (fanout.reason && fanout.state !== "visible") reasons.set(fanout.reason, (reasons.get(fanout.reason) || 0) + 1);
    if (fanout.reason && (fanout.state === "missing" || fanout.state === "hidden")) gapReasons.set(fanout.reason, (gapReasons.get(fanout.reason) || 0) + 1);
  }
  const top = (map: Map<string, number>) => [...map.entries()].sort((left, right) => right[1] - left[1]).slice(0, 2).map(([reason]) => reason);
  return { ...counts, topReasons: top(reasons), gapReasons: top(gapReasons) };
}

/** The value sent back to the planner when an item's checkbox is ticked. */
export function enabledChoice(item: LibraryPlanItem): string {
  return item.choices.find((choice) => choice !== "skip") || item.choice;
}

export const isLibraryPath = (path: string, root = "~/.agents/skills") => path === root || path.startsWith(`${root}/`);

export function normalizeAutoLink(value: unknown): AutoLink | null {
  const record = asRecord(value);
  if (!Object.keys(record).length) return null;
  const pending: Record<string, number> = {};
  for (const [agentId, count] of Object.entries(asRecord(record.pending))) {
    const number = Number(count);
    if (agentId && Number.isFinite(number) && number > 0) pending[agentId] = Math.round(number);
  }
  const lastRun = asRecord(record.lastRun);
  return {
    enabled: record.enabled === true,
    scope: asString(record.scope) === "all" ? "all" : "primary",
    baselineAt: asOptionalString(record.baselineAt),
    pending,
    next: Math.max(0, Math.round(Number(record.next) || 0)),
    needsConfirmation: asArray(record.needsConfirmation)
      .map((value) => {
        const item = asRecord(value);
        return { agentId: asString(item.agentId), id: asString(item.id), title: asString(item.title), missing: Math.max(0, Number(item.missing) || 0) };
      })
      .filter((item) => item.agentId),
    lastRun: Object.keys(lastRun).length
      ? {
          at: asOptionalString(lastRun.at),
          items: asArray(lastRun.items)
            .map((item) => {
              const entry = asRecord(item);
              return { skill: asString(entry.skill), agents: asStringList(entry.agents), historyId: asOptionalString(entry.historyId) };
            })
            .filter((item) => item.skill && item.agents.length),
          failed: asArray(lastRun.failed).map((value) => {
            const item = asRecord(value);
            return { skill: asString(item.skill), agentId: asOptionalString(item.agentId), error: asOptionalString(item.error) };
          }),
        }
      : null,
  };
}

/** What an Agent can't see yet: "看不到" plus "被隐藏" (both mean the library copy doesn't reach it). */
export interface AgentGap {
  agentId: string;
  name: string;
  tier: Tier;
  missing: number;
  /** Library skills it uses its own copy of instead (not counted as missing). */
  ownCopies: number;
  /** Missing ones the user took out on purpose (auto-link leaves them alone). */
  skipped: number;
}

export function libraryGaps(data: LibraryData, agentIds: string[]): AgentGap[] {
  return agentIds
    .map((agentId) => {
      const agent = data.agents.find((item) => item.agentId === agentId);
      let missing = 0;
      let ownCopies = 0;
      let skipped = 0;
      for (const entry of data.entries) {
        const fanout = entry.fanout[agentId];
        if (fanout?.state === "missing" || fanout?.state === "hidden") missing += 1;
        else if (fanout?.state === "private-copy") ownCopies += 1;
        if (fanout?.state === "missing" && fanout.skipped) skipped += 1;
      }
      return { agentId, name: agent?.name || agentId, tier: agent?.tier || "none", missing, ownCopies, skipped };
    })
    .filter((gap) => gap.missing > 0 || gap.ownCopies > 0);
}

/** The Agents the 技能库 page speaks for: the service's 常用 flags, else the app's own list. */
export function primaryLibraryAgents(data: LibraryData, fallback: string[]): string[] {
  const flagged = data.agents.filter((agent) => agent.primary).map((agent) => agent.agentId);
  return flagged.length ? flagged : fallback.filter((id) => data.agents.some((agent) => agent.agentId === id));
}

/**
 * The 技能库 header, true to the data: "常用 Agent 都能用库里的 N 个技能" only when no primary
 * Agent is missing any; otherwise who can't see how many. `note` names own copies, which the
 * Agent can use but which don't follow the library.
 */
export function gapSentence(
  data: LibraryData,
  primary: string[],
  name: (id: string) => string,
): { ok: boolean; text: string; note: string; onlySkipped: boolean } {
  const total = data.entries.length;
  if (!total) return { ok: true, text: "技能库里还没有技能", note: "", onlySkipped: false };
  const gaps = libraryGaps(data, primary.filter((id) => data.agents.some((agent) => agent.agentId === id)));
  const missing = gaps.filter((gap) => gap.missing > 0 && gap.tier !== "none");
  const unsupported = gaps.filter((gap) => gap.missing > 0 && gap.tier === "none");
  const copies = gaps.filter((gap) => gap.ownCopies > 0);
  const skipped = gaps.reduce((sum, gap) => sum + (gap.tier === "none" ? 0 : gap.skipped), 0);
  const note = [
    skipped ? `其中 ${skipped} 个是你取消接入的，不会自动接回；需要时在技能详情里接入。` : "",
    copies.length ? `${copies.map((gap) => `${name(gap.agentId)} 有 ${gap.ownCopies} 个`).join("、")}用的是自己的副本，库里更新后不会跟着变。` : "",
  ].join("");
  if (!missing.length && !unsupported.length) return { ok: true, text: `常用 Agent 都能用库里的 ${total} 个技能`, note, onlySkipped: false };
  const parts = missing.map((gap, index) =>
    index === 0 ? `${name(gap.agentId)} 还看不到库里的 ${gap.missing} 个技能` : `${name(gap.agentId)} 还看不到 ${gap.missing} 个`,
  );
  const none = unsupported.map((gap) => `${name(gap.agentId)} 不读取技能库`);
  // Every gap is one the user made on purpose: true, but nothing to fix.
  const onlySkipped = !unsupported.length && missing.every((gap) => gap.skipped === gap.missing);
  return { ok: false, text: [...parts, ...none].join("，"), note, onlySkipped };
}

/** "已把 pdf-tools 接入 Claude Code、WorkBuddy" for one auto-link batch. */
export function autoLinkMessage(items: { skill: string; agents: string[] }[], name: (id: string) => string): string {
  if (!items.length) return "";
  const agents = [...new Set(items.flatMap((item) => item.agents))].map(name);
  const skills = items.length === 1 ? items[0].skill : `${items[0].skill} 等 ${items.length} 个技能`;
  const who = agents.length > 3 ? `${agents.slice(0, 3).join("、")} 等 ${agents.length} 个 Agent` : agents.join("、");
  return `已把 ${skills} 接入 ${who}`;
}

/** Per-Agent counts of a 补齐接入 plan (items that will run), in the plan's own order. */
export function catchUpCounts(items: LibraryPlanItem[]): { agentId: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.agentId || item.choice === "skip" || !item.steps.length) continue;
    counts.set(item.agentId, (counts.get(item.agentId) || 0) + 1);
  }
  return [...counts.entries()].map(([agentId, count]) => ({ agentId, count }));
}

/** How long an auto-link batch counts as news when this Mac has never seen one before. */
const FRESH_MS = 10 * 60_000;

/**
 * The toast for the latest auto-link batch, once: only when it is newer than the last one
 * shown (`seenAt`), or recent when nothing was ever shown.
 */
export function freshAutoLinkRun(
  autoLink: AutoLink | null,
  seenAt: string | null,
  now: number,
  name: (id: string) => string,
): { at: string; message: string; historyId: string | null } | null {
  const run = autoLink?.lastRun;
  const at = run?.at ? Date.parse(run.at) : Number.NaN;
  if (!run?.at || !run.items.length || !Number.isFinite(at)) return null;
  const seen = seenAt ? Date.parse(seenAt) : Number.NaN;
  if (Number.isFinite(seen) ? at <= seen : now - at > FRESH_MS) return null;
  return { at: run.at, message: autoLinkMessage(run.items, name), historyId: run.items.find((item) => item.historyId)?.historyId || null };
}

/** Pending 补齐接入 counts for the given Agents, in their order (the header's), else biggest first. */
export function pendingRows(autoLink: AutoLink | null, agentIds: string[] | null = null): { agentId: string; count: number }[] {
  if (!autoLink) return [];
  const rows = Object.entries(autoLink.pending)
    .filter(([agentId, count]) => count > 0 && (!agentIds || agentIds.includes(agentId)))
    .map(([agentId, count]) => ({ agentId, count }));
  return agentIds
    ? rows.sort((left, right) => agentIds.indexOf(left.agentId) - agentIds.indexOf(right.agentId))
    : rows.sort((left, right) => right.count - left.count);
}

/**
 * Config-tier Agents (Hermes) that can't see the library until the user agrees to one config
 * change: the service's own list when it sends one, else read from the fanout.
 */
export function needsConsent(data: LibraryData, agentIds: string[]): LibraryAgent[] {
  const listed = data.autoLink ? new Set(data.autoLink.needsConfirmation.map((item) => item.agentId)) : null;
  return data.agents.filter((agent) =>
    listed
      ? listed.has(agent.agentId)
      : agent.tier === "config" &&
        agent.configured !== true &&
        agentIds.includes(agent.agentId) &&
        data.entries.some((entry) => entry.fanout[agent.agentId]?.state === "missing"),
  );
}

/** A 需要注意 item: one primary Agent can't see some library skills, and what fixes it. */
export interface GapIssue {
  agentId: string;
  title: string;
  names: string[];
  detail: string;
  /** catch-up = 补齐接入 for this Agent; consent = Hermes' config change; batch = 一键整理; null = nothing to run. */
  fix: "catch-up" | "consent" | "batch" | null;
}

/**
 * "Claude Code 看不到库里 3 个技能" for each primary Agent with gaps. Pairs the user took out on
 * purpose (取消接入 / 撤销) aren't problems and don't count.
 */
export function gapIssues(data: LibraryData, primary: string[], name: (id: string) => string): GapIssue[] {
  const consent = new Set(needsConsent(data, primary).map((agent) => agent.agentId));
  const issues: GapIssue[] = [];
  for (const agentId of primary) {
    const agent = data.agents.find((item) => item.agentId === agentId);
    if (!agent || agent.tier === "none") continue;
    const unseen = data.entries.filter((entry) => {
      const fanout = entry.fanout[agentId];
      return (fanout?.state === "missing" && !fanout.skipped) || fanout?.state === "hidden";
    });
    if (!unseen.length) continue;
    const hidden = unseen.filter((entry) => entry.fanout[agentId]?.state === "hidden").length;
    const pending = data.autoLink?.pending[agentId] || 0;
    const reasons = [...new Set(unseen.map((entry) => entry.fanout[agentId]?.reason).filter((reason): reason is string => Boolean(reason)))];
    const fix = consent.has(agentId) ? "consent" : pending ? "catch-up" : hidden ? "batch" : agent.tier === "link" || agent.tier === "copy" ? "catch-up" : null;
    issues.push({
      agentId,
      title: `${name(agentId)} 看不到库里 ${unseen.length} 个技能`,
      names: unseen.map((entry) => entry.name),
      detail: reasons.slice(0, 2).join("；"),
      fix,
    });
  }
  return issues;
}
