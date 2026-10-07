import { agentMeta } from "./agents";
import { baseName } from "./format";
import type { Plugin, ScanAgent, Skill, SkillInstance } from "./types";
import type { TopSkill } from "./usage";

export type SlotKind = "installed" | "missing" | "readonly" | "plugin" | "refused";

export interface SlotState {
  agentId: string;
  kind: SlotKind;
  /** Distinct real directories holding a writable copy in this Agent. */
  copies: number;
  label: string;
  reason: string | null;
}

export interface SkillView {
  skill: Skill;
  id: string;
  title: string;
  techName: string;
  showTech: boolean;
  summary: string;
  writable: Record<string, SkillInstance[]>;
  readonly: Record<string, SkillInstance[]>;
  slots: Record<string, SlotState>;
  multi: boolean;
  differs: boolean;
  usage: Record<string, number>;
  usageTotal: number;
  otherAgents: string[];
}

export interface ModelContext {
  primary: string[];
  agents: Map<string, ScanAgent>;
  /** agentId → lowercase skill name → providing plugin display name (enabled plugins only). */
  pluginSkills: Map<string, Map<string, string>>;
  /** lowercase skill name → agentId → uses. */
  usage: Map<string, Record<string, number>>;
}

/** Product-managed sources the service will not overwrite, with a plain explanation. */
const READ_ONLY_REASONS: Record<string, string> = {
  "codex-system": "Codex 自带的系统技能，Codex 更新时会重写",
  "codex-plugin-cache": "Codex 插件自带，随插件一起更新",
  "smartorder-plugin": "订单来了的插件技能，由订单来了管理",
  "smartorder-system": "订单来了自带的系统技能",
  "hermes-hub": "来自 Hermes Skills Hub，由 Hermes 管理",
  "hermes-bundled": "Hermes 内置技能，由 Hermes 自己更新",
  "hermes-org": "组织同步的技能，由 Hermes 管理",
  "hermes-archived": "Hermes 已归档，不再加载",
  clawhub: "来自 ClawHub，由 OpenClaw 管理",
  "openclaw-bundled": "OpenClaw 运行时自带",
  "qclaw-remote": "由 QClaw 远程同步管理",
  "qclaw-config": "由 QClaw 管理",
  skillhub: "来自 QClaw SkillHub，由 QClaw 管理",
  "office-raccoon-bundled": "办公小浣熊内置技能，随应用更新",
};

export function isReadOnlyInstance(instance: SkillInstance): boolean {
  return instance.readOnly === true || Boolean(instance.source && READ_ONLY_REASONS[instance.source]);
}

export function readOnlyReason(instance: SkillInstance): string {
  if (instance.source && READ_ONLY_REASONS[instance.source]) return READ_ONLY_REASONS[instance.source];
  return `${instance.sourceLabel || "产品自带"}，只读`;
}

function groupByAgent(instances: SkillInstance[]) {
  const writable: Record<string, SkillInstance[]> = {};
  const readonly: Record<string, SkillInstance[]> = {};
  for (const instance of instances) {
    const target = isReadOnlyInstance(instance) ? readonly : writable;
    (target[instance.agentId] ||= []).push(instance);
  }
  return { writable, readonly };
}

export function distinctCopies(instances: SkillInstance[] | undefined): number {
  return new Set((instances || []).map((instance) => instance.realPathId || instance.path)).size;
}

export function buildPluginSkillIndex(plugins: Plugin[]): Map<string, Map<string, string>> {
  const index = new Map<string, Map<string, string>>();
  for (const plugin of plugins) {
    if (plugin.enabled !== true) continue;
    const byName = index.get(plugin.agentId) || new Map<string, string>();
    for (const skillPath of Array.isArray(plugin.components?.skills) ? plugin.components.skills : []) {
      const name = baseName(skillPath).toLowerCase();
      if (name && name !== "skills" && !byName.has(name)) {
        byName.set(name, plugin.displayName || plugin.name);
      }
    }
    index.set(plugin.agentId, byName);
  }
  return index;
}

/** Merges summary top-skills and per-instance product counters (Hermes, OpenClaw). */
export function buildUsageIndex(skills: Skill[], topSkills: TopSkill[]): Map<string, Record<string, number>> {
  const index = new Map<string, Record<string, number>>();
  const add = (name: string, agentId: string, count: number) => {
    if (!name || !agentId || !(count > 0)) return;
    const key = name.toLowerCase();
    const entry = index.get(key) || {};
    entry[agentId] = Math.max(entry[agentId] || 0, count);
    index.set(key, entry);
  };
  for (const top of topSkills) {
    // Plugin skills are reported as "plugin:skill"; index both forms.
    const short = top.name.includes(":") ? top.name.split(":").pop() || "" : "";
    for (const [agentId, count] of Object.entries(top.byAgent)) {
      add(top.name, agentId, count);
      if (short) add(short, agentId, count);
    }
  }
  for (const skill of skills) {
    for (const instance of skill.instances) {
      add(skill.name, instance.agentId, Number(instance.usage?.count) || 0);
    }
  }
  return index;
}

function slotFor(
  agentId: string,
  view: Pick<SkillView, "writable" | "readonly" | "skill">,
  context: ModelContext,
): SlotState {
  const name = agentMeta(agentId, context.agents.get(agentId)).name;
  const own = view.writable[agentId];
  if (own?.length) {
    const declared = view.skill.duplicates?.find((item) => item.agentId === agentId)?.count || 0;
    const copies = Math.max(distinctCopies(own), declared);
    return {
      agentId,
      kind: "installed",
      copies,
      label: `${name}：已安装${copies > 1 ? `，存了 ${copies} 份` : ""}`,
      reason: null,
    };
  }
  const locked = view.readonly[agentId];
  if (locked?.length) {
    const reason = readOnlyReason(locked[0]);
    return { agentId, kind: "readonly", copies: 0, label: `${name}：${reason}`, reason };
  }
  const plugin = context.pluginSkills.get(agentId)?.get(view.skill.name.toLowerCase());
  if (plugin) {
    const reason = `由插件 ${plugin} 自带，随插件更新`;
    return { agentId, kind: "plugin", copies: 0, label: `${name}：${reason}`, reason };
  }
  const refused = context.agents.get(agentId)?.refuseInstall;
  if (refused) return { agentId, kind: "refused", copies: 0, label: refused, reason: refused };
  return { agentId, kind: "missing", copies: 0, label: `装到 ${name}`, reason: null };
}

export function buildSkillView(skill: Skill, context: ModelContext): SkillView {
  const { writable, readonly } = groupByAgent(skill.instances);
  const title = skill.displayName || skill.name;
  const base = { skill, writable, readonly };
  const slots: Record<string, SlotState> = {};
  for (const agentId of context.primary) slots[agentId] = slotFor(agentId, base, context);
  const usage = context.usage.get(skill.name.toLowerCase()) || {};
  const agentsWithCopies = new Set(skill.instances.map((instance) => instance.agentId));
  return {
    ...base,
    id: skill.id,
    title,
    techName: skill.name,
    showTech: title !== skill.name,
    summary: skill.descriptionZh || skill.description || "",
    slots,
    multi: (skill.duplicates || []).some(
      (item) => context.primary.includes(item.agentId) && item.count > 1,
    ),
    differs: skill.primaryStatus === "differs",
    usage,
    usageTotal: Object.values(usage).reduce((sum, count) => sum + count, 0),
    otherAgents: [...agentsWithCopies].filter((agentId) => !context.primary.includes(agentId)),
  };
}

export const hasSkill = (view: SkillView, agentId: string) =>
  ["installed", "readonly", "plugin"].includes(view.slots[agentId]?.kind || "missing");

export type SkillFilter = string;

export interface FilterChip {
  id: SkillFilter;
  label: string;
  count: number;
  agentId?: string;
}

function inAll(view: SkillView, primary: string[]) {
  return primary.every((agentId) => hasSkill(view, agentId));
}
function inNone(view: SkillView, primary: string[]) {
  return primary.every((agentId) => !hasSkill(view, agentId));
}
function onlyIn(view: SkillView, agentId: string, primary: string[]) {
  return hasSkill(view, agentId) && primary.every((other) => other === agentId || !hasSkill(view, other));
}

export function matchesFilter(view: SkillView, filter: SkillFilter, primary: string[]): boolean {
  if (filter === "both") return inAll(view, primary);
  if (filter === "none") return inNone(view, primary);
  if (filter === "multi") return view.multi;
  if (filter === "differs") return view.differs && !view.multi;
  if (filter.startsWith("only:")) return onlyIn(view, filter.slice(5), primary);
  if (filter.startsWith("agent:")) return Boolean(view.skill.instances.some((item) => item.agentId === filter.slice(6)));
  return true;
}

export function matchesQuery(view: SkillView, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const { skill } = view;
  return [skill.name, skill.displayName, skill.description, skill.descriptionZh || "", ...(skill.tags || [])]
    .some((value) => value.toLowerCase().includes(needle));
}

export function filterChips(views: SkillView[], primary: string[], names: Record<string, string>): FilterChip[] {
  const count = (filter: string) => views.filter((view) => matchesFilter(view, filter, primary)).length;
  const chips: FilterChip[] = [{ id: "all", label: "全部", count: views.length }];
  if (primary.length > 1) {
    chips.push({ id: "both", label: primary.length > 2 ? "都装了" : "两边都有", count: count("both") });
  }
  for (const agentId of primary) {
    chips.push({ id: `only:${agentId}`, label: `只在 ${names[agentId] || agentId}`, count: count(`only:${agentId}`), agentId });
  }
  chips.push({ id: "none", label: "常用里都没有", count: count("none") });
  chips.push({ id: "multi", label: "存了多份", count: count("multi") });
  chips.push({ id: "differs", label: "版本不同", count: count("differs") });
  return chips;
}

export function sortViews(views: SkillView[]): SkillView[] {
  return [...views].sort(
    (left, right) =>
      right.usageTotal - left.usageTotal || left.title.localeCompare(right.title, "zh-Hans-CN"),
  );
}

/** Best copy to install from: the newest copy, else the latest writable copy in a primary Agent. */
export function pickSourceInstance(view: SkillView, targetAgentId: string, primary: string[]): SkillInstance | null {
  const candidates = view.skill.instances.filter((instance) => instance.agentId !== targetAgentId);
  const newest = view.skill.newest?.instanceId;
  const byNewest = candidates.find((instance) => instance.id === newest);
  if (byNewest) return byNewest;
  const score = (instance: SkillInstance) =>
    (isReadOnlyInstance(instance) ? 0 : 2) + (primary.includes(instance.agentId) ? 1 : 0);
  return (
    [...candidates].sort(
      (left, right) =>
        score(right) - score(left) ||
        String(right.modifiedAt || "").localeCompare(String(left.modifiedAt || "")),
    )[0] || null
  );
}

export interface CopyGroup {
  key: string;
  path: string;
  agentIds: string[];
  modifiedAt: string | null;
  instances: SkillInstance[];
  readOnly: boolean;
  managed: boolean;
  label: string | null;
}

/** Physical copies (deduplicated by real directory) seen by the given Agents. */
export function groupCopies(view: SkillView, agentIds: string[]): CopyGroup[] {
  const groups = new Map<string, CopyGroup>();
  for (const instance of view.skill.instances) {
    if (!agentIds.includes(instance.agentId)) continue;
    const key = instance.realPathId || instance.path;
    const group = groups.get(key) || {
      key,
      path: instance.path,
      agentIds: [],
      modifiedAt: instance.modifiedAt,
      instances: [],
      readOnly: isReadOnlyInstance(instance),
      managed: Boolean(instance.managed),
      label: instance.sourceLabel && instance.source !== "local" ? instance.sourceLabel : null,
    };
    if (!group.agentIds.includes(instance.agentId)) group.agentIds.push(instance.agentId);
    group.instances.push(instance);
    groups.set(key, group);
  }
  return [...groups.values()].sort((left, right) =>
    String(right.modifiedAt || "").localeCompare(String(left.modifiedAt || "")),
  );
}
