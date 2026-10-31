import { historyIdOf } from "./history";
import { normalizeLibraryApply, normalizeLibraryPlan, type LibraryPlanItem, type Tier } from "./library";
import { asArray, asOptionalString, asRecord, asString, asStringList } from "./parse";
import type { SyncAction } from "./types";

/**
 * POST /api/install/plan and /apply: one install flow for every entry point (v0.3 §3).
 * The service decides the mode: "library" (into ~/.agents/skills, then connected by tier)
 * unless the scope is one Agent only or 设置 says 各装一份 ("per-agent", a copy each).
 */

export type InstallScopeName = "primary" | "agents" | "agent-only";
export type InstallSourceRef = { importId: string } | { instanceId: string } | { library: string };

export interface InstallTarget {
  agentId: string;
  name: string;
  tier: Tier;
  /** native | link | copy | config | conflict | replace-copy | already | unsupported */
  outcome: string;
}

export interface InstallPlan {
  planId: string | null;
  mode: "library" | "per-agent";
  scope: string;
  skillName: string;
  label: string;
  libraryRoot: string;
  expiresAt: string | null;
  message: string | null;
  needsChoice: number;
  targets: InstallTarget[];
  /** Native readers that will see it without being chosen. */
  alsoVisibleTo: string[];
  /** Library mode: the library plan's items (add / link / copy / config / conflicts). */
  items: LibraryPlanItem[];
  /** Per-agent mode: one copy per Agent. */
  actions: SyncAction[];
  warnings: string[];
}

const TIERS: Tier[] = ["native", "config", "link", "copy", "none"];
const tierOf = (value: unknown): Tier => (TIERS.includes(asString(value) as Tier) ? (asString(value) as Tier) : "none");

export function normalizeInstallPlan(raw: unknown): InstallPlan {
  const record = asRecord(raw);
  const mode = asString(record.mode) === "per-agent" ? "per-agent" : "library";
  const library = normalizeLibraryPlan(record);
  return {
    planId: asOptionalString(record.planId),
    mode,
    scope: asString(record.scope),
    skillName: asString(record.skillName),
    label: asString(record.label, asString(record.displayName, asString(record.skillName))),
    libraryRoot: asString(record.library, "~/.agents/skills"),
    expiresAt: asOptionalString(record.expiresAt),
    message: asOptionalString(record.message),
    needsChoice: library.needsChoice,
    targets: asArray(record.targets)
      .map((value) => {
        const target = asRecord(value);
        return { agentId: asString(target.agentId), name: asString(target.name, asString(target.agentId)), tier: tierOf(target.tier), outcome: asString(target.outcome) };
      })
      .filter((target) => target.agentId),
    alsoVisibleTo: asStringList(record.alsoVisibleTo),
    items: mode === "library" ? library.items : [],
    actions: mode === "per-agent" ? (asArray(record.actions) as SyncAction[]).filter((action) => action && typeof action.agentId === "string") : [],
    warnings: asStringList(record.warnings),
  };
}

/** What a target Agent gets, in the words of its 接入方式. */
export const OUTCOME_TEXT: Record<string, string> = {
  native: "会自动读取技能库，进库就能看到",
  link: "建一个指向库的软链接",
  copy: "复制一份（它不跟随软链接）",
  config: "在它的配置里加一次技能库目录",
  conflict: "它自己有一份不同的同名技能，需要你选",
  "replace-copy": "它有一份相同的副本，换成接入库里的",
  already: "已经能用，不用改动",
  unsupported: "它不读取技能库",
};

/** Items that will run (never local choices: the plan is the service's). */
export const runningItems = (plan: InstallPlan): number =>
  plan.mode === "library" ? plan.items.filter((item) => item.choice !== "skip" && item.steps.length > 0).length : plan.actions.filter((action) => action.action !== "noop").length;

export interface InstallResult {
  mode: "library" | "per-agent";
  historyId: string | null;
  /** Ids of library items that ran (library mode). */
  applied: string[];
  failed: number;
  actions: SyncAction[];
}

export function normalizeInstallResult(raw: unknown): InstallResult {
  const record = asRecord(raw);
  if (asString(record.mode) === "per-agent") {
    const actions = (asArray(record.actions) as SyncAction[]).filter((action) => action && typeof action.agentId === "string");
    return { mode: "per-agent", historyId: historyIdOf(record), applied: [], failed: 0, actions };
  }
  const library = normalizeLibraryApply(record);
  return {
    mode: "library",
    historyId: library.historyId,
    applied: library.results.filter((item) => item.status === "applied").map((item) => item.id),
    failed: library.results.filter((item) => item.status !== "applied").length,
    actions: [],
  };
}

/** Whether the library got the skill and which Agents were connected, for the toast. */
export function installDone(plan: InstallPlan, result: InstallResult): { library: boolean; agents: string[] } {
  if (result.mode === "per-agent") {
    const done = result.actions.filter((action) => (action.result ? action.result === "completed" : action.action !== "noop"));
    return { library: false, agents: [...new Set(done.map((action) => action.agentId))] };
  }
  const ran = plan.items.filter((item) => result.applied.includes(item.id));
  return {
    library: ran.some((item) => item.kind === "add" || item.id.startsWith("replace:")),
    agents: [...new Set(ran.filter((item) => item.agentId).map((item) => item.agentId as string))],
  };
}
