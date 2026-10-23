import { cacheHitRate } from "./cache";
import { asArray, asNumber, asOptionalNumber, asOptionalString, asRecord, asString } from "./parse";

/** GET /api/usage/totals: every window at once, all Agents combined plus each Agent's share. */

export type TotalsWindowId = "today" | "7" | "30" | "90" | "all";

export interface TotalsTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface TotalsWindow {
  id: TotalsWindowId;
  label: string;
  tokens: TotalsTokens;
  costUsd: number | null;
  sessions: number;
  activeDays: number;
  /** 0–1, see lib/cache. */
  cacheHitRate: number | null;
  cacheWriteShare: number | null;
  byAgent: { agentId: string; tokens: number; costUsd: number | null; cacheHitRate: number | null }[];
}

export interface UsageTotals {
  generatedAt: string | null;
  windows: TotalsWindow[];
}

const IDS: TotalsWindowId[] = ["today", "7", "30", "90", "all"];

export const TOTALS_LABELS: Record<TotalsWindowId, string> = {
  today: "今天",
  "7": "近 7 天",
  "30": "近 30 天",
  "90": "近 90 天",
  all: "全部",
};

function normalizeTokens(value: unknown): TotalsTokens {
  const record = asRecord(value);
  const input = asNumber(record.input);
  const output = asNumber(record.output);
  const cacheRead = asNumber(record.cacheRead);
  const cacheWrite = asNumber(record.cacheWrite);
  return { input, output, cacheRead, cacheWrite, total: asNumber(record.total, input + output + cacheRead + cacheWrite) };
}

export function normalizeTotals(raw: unknown): UsageTotals {
  const record = asRecord(raw);
  const windows = asArray(record.windows)
    .map((value): TotalsWindow | null => {
      const window = asRecord(value);
      const id = asString(window.id) as TotalsWindowId;
      if (!IDS.includes(id)) return null;
      return {
        id,
        label: asString(window.label) || TOTALS_LABELS[id],
        tokens: normalizeTokens(window.tokens),
        costUsd: asOptionalNumber(window.costUsd),
        sessions: asNumber(window.sessions),
        activeDays: asNumber(window.activeDays),
        cacheHitRate: cacheHitRate(window.cacheHitRate, normalizeTokens(window.tokens)),
        cacheWriteShare: asOptionalNumber(window.cacheWriteShare),
        byAgent: asArray(window.byAgent)
          .map((item) => {
            const agent = asRecord(item);
            const tokens = agent.tokens;
            return {
              agentId: asString(agent.agentId),
              tokens: typeof tokens === "object" ? normalizeTokens(tokens).total : asNumber(tokens),
              costUsd: asOptionalNumber(agent.costUsd),
              cacheHitRate: cacheHitRate(agent.cacheHitRate, typeof tokens === "object" && tokens ? normalizeTokens(tokens) : null),
            };
          })
          .filter((agent) => agent.agentId)
          .sort((left, right) => (right.costUsd ?? 0) - (left.costUsd ?? 0) || right.tokens - left.tokens),
      };
    })
    .filter((window): window is TotalsWindow => Boolean(window))
    .sort((left, right) => IDS.indexOf(left.id) - IDS.indexOf(right.id));
  return { generatedAt: asOptionalString(record.generatedAt), windows };
}

/** The window matching 数据's selection ("7" | "30" | "90" | "all"). */
export function totalsFor(totals: UsageTotals | undefined, id: TotalsWindowId): TotalsWindow | null {
  return totals?.windows.find((window) => window.id === id) || null;
}

/** 首页 strip: 今天 / 近 7 天 / 近 30 天 / 全部. */
export const HOME_WINDOWS: TotalsWindowId[] = ["today", "7", "30", "all"];
