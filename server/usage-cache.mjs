import { CODEX_DB_REASON } from "./usage-cost.mjs";
import { CACHE_RATE_RULE } from "./usage-rules.mjs";
import { sessionKeyOf } from "./usage-sessions.mjs";

/**
 * Prompt-cache hit rate, as the vendors define it: the share of prompt (input) tokens served
 * from the cache. Anthropic: total input = cache_read_input_tokens + cache_creation_input_tokens
 * + input_tokens; OpenAI: "dividing total cached tokens by total input tokens". So
 * cacheHitRate = cacheRead / (uncached input + cacheRead + cacheWrite) and cacheWriteShare =
 * cacheWrite / the same; output tokens are not part of it. Codex threads estimated from its
 * database (a total split by this machine's mix) and sources that report no cache tokens
 * (办公小浣熊) are left out, because their split says nothing about caching.
 */

export { CACHE_RATE_RULE };

/** Sources whose token counts carry no cache fields. */
const NO_CACHE_TOKENS = new Set(["office-raccoon"]);
export const reportsCache = (agentId) => !NO_CACHE_TOKENS.has(agentId);

const round = (value) => Math.round(value * 10_000) / 10_000;

/** { cacheHitRate, cacheWriteShare } of a token split (null when there are no prompt tokens). */
export function cacheRates({ input = 0, cacheRead = 0, cacheWrite = 0, cacheWrite1h = 0 } = {}) {
  const writes = cacheWrite + cacheWrite1h;
  const prompt = input + cacheRead + writes;
  return prompt > 0 ? { cacheHitRate: round(cacheRead / prompt), cacheWriteShare: round(writes / prompt) } : { cacheHitRate: null, cacheWriteShare: null };
}

const NO_RATES = { cacheHitRate: null, cacheWriteShare: null };
const measured = (row) => row.reason !== CODEX_DB_REASON;

/** Prompt-token split of priced byModel rows, without the Codex database estimates. */
export function promptTokensOf(byModel = []) {
  const sum = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  for (const row of byModel.filter(measured)) {
    for (const field of Object.keys(sum)) sum[field] += row.tokens?.[field] || 0;
  }
  return sum;
}

/** Rates for one agent (or project) from its byModel rows. */
export const ratesOf = (agentId, byModel) => (reportsCache(agentId) ? cacheRates(promptTokensOf(byModel)) : NO_RATES);

/** Rates for a byModel row (null for the Codex database estimates, whose split is synthetic). */
export const rowRates = (row, agentId = null) => (!measured(row) || (agentId && !reportsCache(agentId)) ? NO_RATES : cacheRates(row.tokens));

/** Rates over several agents' byModel rows (Map agentId → byModel). */
export function ratesAcross(byAgent) {
  const sum = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  for (const [agentId, byModel] of byAgent) {
    if (!reportsCache(agentId)) continue;
    const part = promptTokensOf(byModel);
    for (const field of Object.keys(sum)) sum[field] += part[field];
  }
  return cacheRates(sum);
}

const percentile = (sorted, share) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] : null);

/**
 * Per conversation, per agent: each session's own rate within the window (its transcript
 * files, subagent transcripts included, or its database record), then
 * { sessions, median, p10, p90, lowSessions (< 50%), excludedSessions (Codex database estimates) }.
 * Only counts and rates; no session is named.
 */
export function cacheBySession(index, inWindow) {
  const sessions = new Map();
  const excluded = new Map();
  const add = (agentId, key, input, cacheRead, cacheWrite) => {
    if (!reportsCache(agentId)) return;
    const perAgent = sessions.get(agentId) || new Map();
    sessions.set(agentId, perAgent);
    const sum = perAgent.get(key) || [0, 0, 0];
    sum[0] += input;
    sum[1] += cacheRead;
    sum[2] += cacheWrite;
    perAgent.set(key, sum);
  };
  for (const [key, entry] of Object.entries(index.files || {})) {
    const session = sessionKeyOf(key, entry);
    if (!session) continue;
    for (const [day, values] of Object.entries(entry.d || {})) {
      // Day rows: [sessions, input, output, cacheRead, cacheWrite, total].
      if (inWindow(day)) add(entry.a, session, values[1] || 0, values[3] || 0, values[4] || 0);
    }
  }
  for (const [agentId, records] of Object.entries(index.records || {})) {
    for (const [key, record] of Object.entries(records)) {
      if (!inWindow(record.d)) continue;
      if (record.x === "codex-db") {
        excluded.set(agentId, (excluded.get(agentId) || 0) + 1);
        continue;
      }
      const t = record.t || [];
      add(agentId, `record|${key}`, t[0] || 0, t[2] || 0, t[3] || 0);
    }
  }
  const result = new Map();
  for (const agentId of new Set([...sessions.keys(), ...excluded.keys()])) {
    const rates = [...(sessions.get(agentId)?.values() || [])]
      .map(([input, cacheRead, cacheWrite]) => cacheRates({ input, cacheRead, cacheWrite }).cacheHitRate)
      .filter((rate) => rate !== null)
      .sort((left, right) => left - right);
    result.set(agentId, {
      sessions: rates.length,
      median: percentile(rates, 0.5),
      p10: percentile(rates, 0.1),
      p90: percentile(rates, 0.9),
      lowSessions: rates.filter((rate) => rate < 0.5).length,
      excludedSessions: excluded.get(agentId) || 0,
    });
  }
  return result;
}
