export const MAIN_PAGES = [
  "home",
  "skills",
  "plugins",
  "experts",
  "connectors",
  "updates",
  "usage",
  "health",
  "settings",
] as const;

export type MainPage = (typeof MAIN_PAGES)[number];
export type PageId = MainPage | "agent";

export interface Route {
  page: PageId;
  agentId: string | null;
}

export const PAGE_TITLES: Record<PageId, string> = {
  home: "概览",
  skills: "技能",
  plugins: "插件",
  experts: "专家与 Agent",
  connectors: "连接器与 MCP",
  updates: "更新",
  usage: "数据",
  health: "体检",
  settings: "设置",
  agent: "Agent",
};

const AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Serialized as "skills" or "agent:codex" for localStorage. */
export function parseRoute(value: string | null | undefined): Route {
  const text = String(value || "");
  if (text.startsWith("agent:") && AGENT_ID.test(text.slice(6))) {
    return { page: "agent", agentId: text.slice(6) };
  }
  return { page: (MAIN_PAGES as readonly string[]).includes(text) ? (text as MainPage) : "home", agentId: null };
}

export function serializeRoute(route: Route): string {
  return route.page === "agent" && route.agentId ? `agent:${route.agentId}` : route.page;
}

export function isValidRoute(value: string): boolean {
  return serializeRoute(parseRoute(value)) === value;
}

export type DrawerTarget =
  | { kind: "plugin"; id: string }
  | { kind: "expert"; id: string }
  | { kind: "mcp"; id: string }
  | { kind: "update"; id: string };
