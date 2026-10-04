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

export const MAX_PRIMARY_AGENTS = 4;
