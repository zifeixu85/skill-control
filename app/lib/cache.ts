import { asNumber, asOptionalNumber, asRecord, pick } from "./parse";

/**
 * 缓存命中率 = 缓存读取 ÷（未缓存输入 + 缓存读取 + 缓存写入）: the share of input tokens served
 * from the prompt cache. Higher is cheaper and faster.
 */

export const CACHE_HIT_HINT = "缓存命中率 = 缓存读取 ÷（未缓存输入 + 缓存读取 + 缓存写入），即输入 tokens 里由缓存提供的比例。越高越省钱、越快。";

/** Below this a conversation counts as "低命中". */
export const LOW_HIT = 0.5;

interface InputTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}

/** A 0–1 rate from the service (0–100 accepted), else computed from the token split; null when there is no input. */
export function cacheHitRate(raw: unknown, tokens?: InputTokens | null): number | null {
  const given = asOptionalNumber(raw);
  if (given !== null && given >= 0) return Math.min(1, given > 1 ? given / 100 : given);
  if (!tokens) return null;
  const denominator = tokens.input + tokens.cacheRead + tokens.cacheWrite + (tokens.cacheWrite1h || 0);
  return denominator > 0 ? Math.min(1, tokens.cacheRead / denominator) : null;
}

/** "96%", "<1%", ">99%" (never rounds a partial value to 0 or 100), or "—". */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  if (rate > 0 && rate < 0.01) return "<1%";
  if (rate < 1 && rate > 0.99) return ">99%";
  return `${Math.round(rate * 100)}%`;
}

export const rateTone = (rate: number | null): "ok" | "warn" | "bad" | "mute" =>
  rate === null ? "mute" : rate >= 0.8 ? "ok" : rate >= LOW_HIT ? "warn" : "bad";

/** Per-conversation spread of the hit rate for one Agent. */
export interface CacheDistribution {
  sessions: number;
  median: number;
  p10: number;
  p90: number;
  /** Conversations below 50%. */
  lowSessions: number;
  /** Conversations left out (too small to judge, no input split). */
  excluded: number;
}

const rate01 = (value: unknown) => {
  const number = asOptionalNumber(value);
  if (number === null) return null;
  return Math.max(0, Math.min(1, number > 1 ? number / 100 : number));
};

export function normalizeCacheDistribution(value: unknown): CacheDistribution | null {
  const record = asRecord(value);
  const median = rate01(record.median);
  const sessions = asNumber(record.sessions);
  if (median === null || sessions <= 0) return null;
  const p10 = rate01(record.p10) ?? median;
  const p90 = rate01(record.p90) ?? median;
  return {
    sessions,
    median,
    p10: Math.min(p10, median),
    p90: Math.max(p90, median),
    lowSessions: asNumber(record.lowSessions),
    excluded: asNumber(pick(record, "excludedSessions", "excluded")),
  };
}

/** The distribution wherever the service puts it. */
export function cacheDistributionOf(record: Record<string, unknown>): CacheDistribution | null {
  const nested = asRecord(record.cache);
  return normalizeCacheDistribution(pick(record, "cacheBySession", "cacheDistribution", "cacheHitDistribution") ?? nested.distribution ?? nested.conversations);
}
