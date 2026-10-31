import { formatCompact } from "./format";
import type { ActivityAgent, ScanAgent } from "./types";

export interface AgentMeta {
  id: string;
  name: string;
  color: string;
  letter: string;
}

/** Brand tints for avatars and cards; scan colors are pastel row tints. */
const BRANDS: Record<string, { name: string; color: string; letter?: string }> = {
  codex: { name: "Codex", color: "#1d1d1f" },
  claude: { name: "Claude Code", color: "#d97757" },
  workbuddy: { name: "WorkBuddy", color: "#2f6bff" },
  cursor: { name: "Cursor", color: "#222222" },
  gemini: { name: "Gemini CLI", color: "#4d7cf3" },
  kiro: { name: "Kiro", color: "#7b5cf0" },
  trae: { name: "Trae", color: "#23c06b" },
  smartorder: { name: "订单来了", color: "#e2832b", letter: "订" },
  opencode: { name: "OpenCode", color: "#555555" },
  copilot: { name: "GitHub Copilot", color: "#333333" },
  hermes: { name: "Hermes Agent", color: "#6b5cf0" },
  qclaw: { name: "QClaw", color: "#1f7aff" },
  openclaw: { name: "OpenClaw", color: "#e5533d" },
  "office-raccoon": { name: "办公小浣熊", color: "#f2b56b", letter: "浣" },
};

export function agentMeta(id: string, agent?: Pick<ScanAgent, "name" | "color"> | null): AgentMeta {
  const brand = BRANDS[id];
  const name = agent?.name || brand?.name || id;
  return {
    id,
    name,
    color: brand?.color || agent?.color || "#77787d",
    letter: brand?.letter || (name.trim()[0] || "?").toUpperCase(),
  };
}

/** Readable ink (#1d1d1f or white) for text drawn on a hex background. */
export function inkOn(hex: string | null | undefined): string {
  const value = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return "#ffffff";
  const [red, green, blue] = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16));
  return 0.299 * red + 0.587 * green + 0.114 * blue > 160 ? "#1d1d1f" : "#ffffff";
}

/** Accent for bars and washes: near-black brands follow the ink token so dark mode stays visible. */
export function tintFor(hex: string): string {
  const value = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return hex;
  const [red, green, blue] = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16));
  return 0.299 * red + 0.587 * green + 0.114 * blue < 60 ? "var(--ink)" : hex;
}

/** One line explaining why an agent is (or is not) suggested, from real activity only. */
export function activityReason(activity: ActivityAgent | undefined, suggested: boolean): string {
  if (!activity || activity.status === "unknown" || (!activity.files30d && !activity.tokens30d)) {
    return suggested ? "推荐" : "近 30 天没有记录";
  }
  const parts: string[] = [];
  if (activity.basis === "tokens" && activity.tokens30d) {
    parts.push(
      activity.activeDays30d
        ? `近 30 天 ${activity.activeDays30d} 天在用`
        : `近 30 天 ${formatCompact(activity.tokens30d)} tokens`,
    );
  } else {
    parts.push(`近 30 天 ${activity.files30d} 个会话`);
  }
  if (suggested) parts.push("推荐");
  return parts.join(" · ");
}

/**
 * The one "近 30 天 …" line for an Agent, everywhere (onboarding, 概览, Agent pages). The usage
 * index's count (sessions active in the window, by their own timestamps) wins when it is ready;
 * the activity scan (session files touched in the window) is only the fallback while usage is
 * still being counted, so the same Agent never shows two different session counts at once.
 */
export function activityLine(activity: ActivityAgent | undefined, usage?: { sessions: number; activeDays: number } | null): string {
  if (usage && usage.sessions > 0) return `近 30 天 ${usage.sessions} 个会话 · ${usage.activeDays} 天在用`;
  if (!activity || activity.status === "unknown" || (!activity.files30d && !activity.tokens30d)) {
    return "近 30 天暂无记录";
  }
  if (activity.basis === "tokens") {
    return [activity.activeDays30d ? `近 30 天 ${activity.activeDays30d} 天在用` : "近 30 天", `${formatCompact(activity.tokens30d)} tokens`].join(" · ");
  }
  return `近 30 天 ${activity.files30d} 个会话 · ${activity.activeDays30d} 天在用`;
}

/** Installed on this Mac (v0.3: `installed`; older services: a skills folder was found). */
export const isInstalled = (agent: Pick<ScanAgent, "available" | "installed">): boolean => agent.installed ?? agent.available;

/** Installed, but no skills folder (or no skills) yet: worth offering, with a note. */
export const noSkillsYet = (agent: Pick<ScanAgent, "available" | "installed" | "skillsDir" | "skillCount">): boolean =>
  isInstalled(agent) && (agent.skillsDir === "missing" || agent.skillCount === 0);

/**
 * Agents to offer as 常用: every installed one (including those without skills yet), busiest
 * first. Nothing that isn't installed is ever offered or preselected.
 */
export function pickableAgents<T extends Pick<ScanAgent, "id" | "available" | "installed" | "skillCount">>(agents: T[], weight: (id: string) => number): T[] {
  return agents
    .filter((agent) => isInstalled(agent))
    .sort((left, right) => weight(right.id) - weight(left.id) || right.skillCount - left.skillCount);
}

/** "~/.claude.json、claude 命令": why an Agent counts as installed, for a quiet hint. */
export function detectedHint(evidence: string[] | null | undefined, limit = 2): string {
  const words = (evidence || []).map((item) => {
    const [kind, ...rest] = item.split(":");
    const value = rest.join(":");
    if (!value) return item;
    if (kind === "command") return `${value} 命令`;
    if (kind === "app") return value;
    if (kind === "extension") return `VS Code 扩展 ${value}`;
    return item;
  });
  if (!words.length) return "";
  return `检测依据：${words.slice(0, limit).join("、")}${words.length > limit ? ` 等 ${words.length} 项` : ""}`;
}

/** The first selection in onboarding: suggested Agents that are installed, never placeholders. */
export function initialPrimary(suggested: string[], installed: string[], limit = 4): string[] {
  return suggested.filter((id) => installed.includes(id)).slice(0, limit);
}

export const MAX_PRIMARY_AGENTS = 4;
