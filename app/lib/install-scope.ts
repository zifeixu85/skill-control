import type { InstallScopeName } from "./install-plan";
import type { ManagerConfig, SyncMode } from "./types";

/**
 * One scope choice for every install entry point (import, Agent → Agent, the switches in a
 * skill's detail): 所有常用 Agent（推荐）/ 选择 Agent / 只装到某个 Agent. With the 统一技能库
 * method the first two put the skill in ~/.agents/skills and connect (接入) the Agents; the
 * third always copies into one Agent's own folder.
 */

export type ScopeOption = "primary" | "choose" | "single";

/** 安装方式 in 设置: 统一技能库 ("library") or 各装一份 ("per-agent"). */
export type InstallMethod = "library" | "per-agent";

/**
 * The install method from the config: `library.installMode` (v0.3), else the pre-0.3
 * `syncMode` ("copy" → 各装一份; the old default, so only a v0.3 service can say otherwise).
 */
export function installMethod(config: Pick<ManagerConfig, "library" | "syncMode"> | null | undefined): InstallMethod {
  const mode = config?.library?.installMode;
  if (mode === "per-agent" || mode === "library") return mode;
  return legacyMethod(config?.syncMode);
}
export const legacyMethod = (mode: SyncMode | null | undefined): InstallMethod => (mode === "copy" ? "per-agent" : "library");

export interface ScopeInput {
  option: ScopeOption;
  primary: string[];
  chosen: string[];
  single: string | null;
  /** Agents that can't take it (refuse installs), already are the source, or see it anyway. */
  exclude: string[];
}

export interface ScopeRequest {
  scope: InstallScopeName;
  /** The Agents the plan is about (for 所有常用 Agent the service uses its own list). */
  agentIds: string[];
}

export function scopeRequest(input: ScopeInput): ScopeRequest {
  const allowed = (id: string) => !input.exclude.includes(id);
  if (input.option === "single") return { scope: "agent-only", agentIds: input.single && allowed(input.single) ? [input.single] : [] };
  if (input.option === "primary") return { scope: "primary", agentIds: input.primary.filter(allowed) };
  return { scope: "agents", agentIds: [...new Set(input.chosen.filter(allowed))] };
}

/** The body of POST /api/install/plan for this choice. */
export function installBody(source: Record<string, string>, request: ScopeRequest, choices: Record<string, string>) {
  return {
    source,
    scope: request.scope,
    ...(request.scope === "primary" ? {} : { agentIds: request.agentIds }),
    ...(Object.keys(choices).length ? { choices } : {}),
  };
}

export interface ScopeOptionText {
  id: ScopeOption;
  title: string;
  detail: string;
}

/** "A、B、C 等 5 个 Agent" — long lists stay one short phrase. */
export function shortNames(names: string[], limit = 3): string {
  if (names.length <= limit) return names.join("、");
  return `${names.slice(0, limit).join("、")} 等 ${names.length} 个 Agent`;
}

/** What each option does, in plain words; names are the primary Agents and the native readers. */
export function scopeOptionTexts(method: InstallMethod, primaryNames: string[], nativeNames: string[]): ScopeOptionText[] {
  const who = primaryNames.length ? shortNames(primaryNames, 4) : "常用 Agent";
  const native = nativeNames.length ? `${shortNames(nativeNames)} 会自动读取技能库，进库后也能看到它。` : "";
  return method === "library"
    ? [
        { id: "primary", title: "所有常用 Agent（推荐）", detail: `放进技能库，再接入 ${who}。以后在库里更新一次就行。` },
        { id: "choose", title: "选择 Agent", detail: `放进技能库，只接入你勾选的 Agent。${native}` },
        { id: "single", title: "只装到某个 Agent", detail: "复制到这个 Agent 自己的技能目录，不进技能库，其他 Agent 看不到。" },
      ]
    : [
        { id: "primary", title: "所有常用 Agent（推荐）", detail: `给 ${who} 各复制一份（设置里选的是“各装一份”）。` },
        { id: "choose", title: "选择 Agent", detail: "给你勾选的 Agent 各复制一份。" },
        { id: "single", title: "只装到某个 Agent", detail: "只复制到这个 Agent 自己的技能目录。" },
      ];
}

/** The option to start with: the one Agent the user clicked, else the recommendation. */
export const initialOption = (agentId: string | null | undefined): ScopeOption => (agentId ? "choose" : "primary");

/** "已把 X 放进技能库，并接入 A、B" / "已装到 A、B：X". */
export function installMessage(title: string, done: { library: boolean; agents: string[] }, perAgent: boolean, name: (id: string) => string): string {
  const agents = shortNames(done.agents.map(name));
  if (perAgent) return done.agents.length ? `已装到 ${agents}：${title}` : `${title} 已经装好了，没有改动`;
  if (!done.library) return done.agents.length ? `已把 ${title} 接入 ${agents}` : `${title} 已经在技能库里，没有改动`;
  return done.agents.length ? `已把 ${title} 放进技能库，并接入 ${agents}` : `已把 ${title} 放进技能库`;
}
