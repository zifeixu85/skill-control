import { readFileSync } from "node:fs";
import { scrubTokens } from "./redact.mjs";
import { CACHE_RATE_RULE } from "./usage-rules.mjs";

/**
 * Official API prices (server/pricing/model-prices.json, USD per 1M tokens) and the pure
 * rules that turn token counts into an estimated cost. The usage index stores tokens per
 * model, day and bucket; costs are computed at query time, so a price update never needs a
 * re-index. Only the bucket rules below (prompt-size thresholds, off-peak and fast flags)
 * are baked into the index.
 */

/** Prompt-size buckets: the prompt (uncached input + cache reads + cache writes) is above `floor`. */
export const SIZE_BUCKETS = [
  { id: "s", floor: 0 },
  { id: "l200", floor: 200_000 },
  { id: "l272", floor: 272_000 },
  { id: "l512", floor: 512_000 },
];
const FLOORS = new Map(SIZE_BUCKETS.map((bucket) => [bucket.id, bucket.floor]));
const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"];
/** Token rows in the index: [input, output, cacheRead, cacheWrite (5 min), cacheWrite1h, requests]. */
export const ROW_FIELDS = [...PRICE_FIELDS, "requests"];
export const MODEL_ID = /^[\w.:@/<>-]{1,80}$/u;
const IGNORED = new Set(["<synthetic>"]);
const DATE_SUFFIX = /(?:[-@]\d{8}|-\d{4}-\d{2}-\d{2})$/u;
const PRICE_FILE = new URL("./pricing/model-prices.json", import.meta.url);
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const DAY_MS = 86_400_000;

export const emptyRow = () => [0, 0, 0, 0, 0, 0];

/** A model id safe to store and show, "unknown" otherwise (never a credential-shaped value). */
export function modelKey(value) {
  if (typeof value !== "string") return "unknown";
  const id = value.trim();
  if (!MODEL_ID.test(id) || scrubTokens(id) !== id) return "unknown";
  return id;
}

export const isIgnoredModel = (id) => IGNORED.has(String(id || "").trim());

/** Lower case, no `provider/` prefix (`moonshot/kimi-k3`, `models/gemini-…`). */
export function normalize(id) {
  const value = String(id || "").trim().toLowerCase();
  return value.slice(value.lastIndexOf("/") + 1);
}

export const stripDate = (id) => id.replace(DATE_SUFFIX, "");

export function promptBucket(promptTokens) {
  let id = "s";
  for (const bucket of SIZE_BUCKETS) if (promptTokens > bucket.floor) id = bucket.id;
  return id;
}

export function parseBucket(bucket) {
  const [size, ...flags] = String(bucket || "s").split(":");
  return { size: FLOORS.has(size) ? size : "s", off: flags.includes("off"), fast: flags.includes("fast") };
}

// ---------------------------------------------------------------------------
// Price table

const isPrice = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

function pickPrices(source) {
  const result = {};
  for (const field of PRICE_FIELDS) if (isPrice(source?.[field])) result[field] = source[field];
  return result;
}

function fail(message) {
  throw new Error(`价格表格式错误：${message}`);
}

/** Validates the raw JSON and builds the lookup maps. Throws on a malformed table. */
export function compileTable(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.models)) fail("缺少 models。");
  const byId = new Map();
  const schedules = raw.schedules && typeof raw.schedules === "object" ? raw.schedules : {};
  for (const model of raw.models) {
    if (typeof model?.id !== "string" || !MODEL_ID.test(model.id)) fail(`模型 id 无效：${String(model?.id).slice(0, 40)}`);
    if (!isPrice(model.input) || !isPrice(model.output)) fail(`${model.id} 缺少输入或输出价格。`);
    if (model.long && !(model.long.above > 0 && [...FLOORS.values()].includes(model.long.above))) {
      fail(`${model.id} 的长上下文阈值 ${model.long.above} 不在索引分档内。`);
    }
    if (model.offPeak && !schedules[model.offPeak.schedule]) fail(`${model.id} 引用了不存在的时段 ${model.offPeak.schedule}。`);
    for (const change of model.changes || []) if (!DATE.test(change?.from || "")) fail(`${model.id} 的换价日期无效。`);
    if (model.reviewBy !== undefined && !DATE.test(model.reviewBy)) fail(`${model.id} 的 reviewBy 日期无效。`);
    for (const id of [model.id, ...(model.aliases || [])]) {
      const key = normalize(id);
      if (byId.has(key)) fail(`重复的模型 id 或别名：${key}`);
      byId.set(key, model);
    }
  }
  const estimates = new Map();
  for (const estimate of raw.estimates || []) {
    if (estimate.priceAs !== "@agent-average" && !byId.has(normalize(estimate.priceAs))) fail(`估算 ${estimate.id} 指向不存在的模型。`);
    if (estimate.fallback !== undefined && !byId.has(normalize(estimate.fallback))) fail(`估算 ${estimate.id} 的 fallback 指向不存在的模型。`);
    estimates.set(normalize(estimate.id), estimate);
  }
  const families = (raw.families || []).map((family) => {
    if (!byId.has(normalize(family.priceAs))) fail(`系列 ${family.id} 指向不存在的模型。`);
    return { ...family, regex: new RegExp(family.match, "u") };
  });
  if (raw.reviewAfterDays !== undefined && !(Number.isInteger(raw.reviewAfterDays) && raw.reviewAfterDays > 0)) fail("reviewAfterDays 必须是正整数。");
  if (raw.checkedAt !== undefined && !DATE.test(raw.checkedAt)) fail("checkedAt 日期无效。");
  return { raw, byId, estimates, families, schedules, memo: new Map() };
}

let bundled = null;
/** The bundled table, loaded once. */
export function priceTable() {
  bundled ||= compileTable(JSON.parse(readFileSync(PRICE_FILE, "utf8")));
  return bundled;
}

// ---------------------------------------------------------------------------
// Resolution: exact id → alias → estimate → family → unpriced.

function lookup(table, ids) {
  for (const id of ids) {
    const entry = table.byId.get(id);
    if (entry) return entry;
  }
  return null;
}

function resolveUncached(raw, table, agentId) {
  if (!raw || raw === "unknown") return { basis: "unpriced" };
  if (IGNORED.has(raw)) return { basis: "ignored" };
  const id = normalize(raw);
  const ids = [...new Set([id, stripDate(id)])];
  const exact = lookup(table, ids);
  if (exact) return { basis: "official", entry: exact, priceRef: { section: "models", id: exact.id } };
  for (const candidate of ids) {
    const estimate = table.estimates.get(candidate);
    if (!estimate || (estimate.agent && estimate.agent !== agentId)) continue;
    const ref = { section: "estimates", id: estimate.id };
    if (estimate.priceAs === "@agent-average") {
      // `fallback` prices the tokens when the agent has nothing else to average.
      const fallback = estimate.fallback ? table.byId.get(normalize(estimate.fallback)) : null;
      return { basis: "estimate", average: true, priceAs: "@agent-average", fallback, reason: estimate.reason, priceRef: ref };
    }
    const entry = table.byId.get(normalize(estimate.priceAs));
    return { basis: "estimate", entry, priceAs: entry.id, reason: estimate.reason, priceRef: ref };
  }
  return resolveFamily(id, table);
}

/** Family fallback for an unknown id (also used when an agent average has nothing to average). */
export function resolveFamily(id, table = priceTable()) {
  const family = table.families.find((item) => item.regex.test(normalize(id)));
  if (!family) return { basis: "unpriced" };
  const entry = table.byId.get(normalize(family.priceAs));
  return { basis: "family", entry, priceAs: entry.id, family: family.id, priceRef: { section: "families", id: family.id } };
}

/** How a model id is priced: { basis, entry?, priceAs?, average?, priceRef? }. */
export function resolve(model, table = priceTable(), { agentId = null } = {}) {
  const raw = typeof model === "string" ? model.trim() : "";
  const key = `${agentId || ""}|${raw}`;
  if (!table.memo.has(key)) {
    if (table.memo.size > 5_000) table.memo.clear();
    table.memo.set(key, resolveUncached(raw, table, agentId));
  }
  return table.memo.get(key);
}

// ---------------------------------------------------------------------------
// Prices and costs

/**
 * Effective unit prices of one table entry on `day` (YYYY-MM-DD) for one index bucket:
 * dated changes, then the long-context tier (the whole request), then the off-peak tier,
 * then the fallbacks (cacheRead / cacheWrite → input, cacheWrite1h → cacheWrite), then the
 * fast-mode multiplier.
 */
export function priceFor(entry, day, bucket) {
  const { size, off, fast } = parseBucket(bucket);
  let price = pickPrices(entry);
  const changes = [...(entry.changes || [])].sort((left, right) => left.from.localeCompare(right.from));
  for (const change of changes) if (typeof day === "string" && day >= change.from) price = { ...price, ...pickPrices(change) };
  const long = Boolean(entry.long) && FLOORS.get(size) >= entry.long.above;
  if (long) price = { ...price, ...pickPrices(entry.long) };
  const offPeak = off && Boolean(entry.offPeak);
  if (offPeak) price = { ...price, ...pickPrices(entry.offPeak) };
  price.cacheRead ??= price.input;
  price.cacheWrite ??= price.input;
  price.cacheWrite1h ??= price.cacheWrite;
  const multiplier = fast && isPrice(entry.fast) && entry.fast > 0 ? entry.fast : 1;
  const result = Object.fromEntries(PRICE_FIELDS.map((field) => [field, price[field] * multiplier]));
  return { ...result, long, offPeak, fast: multiplier };
}

/** USD per token type for a row or { input, output, cacheRead, cacheWrite, cacheWrite1h }. */
export function costParts(tokens, price) {
  return PRICE_FIELDS.map((field, index) => ((Array.isArray(tokens) ? tokens[index] : tokens?.[field]) || 0) * price[field] / 1_000_000);
}

export const costOf = (tokens, price) => costParts(tokens, price).reduce((sum, value) => sum + value, 0);

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map();

function weekdayHour(ms, timeZone) {
  const date = new Date(ms);
  if (!timeZone || timeZone === "UTC") return [date.getUTCDay() || 7, date.getUTCHours()];
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", hourCycle: "h23" }));
  }
  const parts = Object.fromEntries(formatters.get(timeZone).formatToParts(date).map((part) => [part.type, part.value]));
  return [WEEKDAYS[parts.weekday] || 0, Number(parts.hour)];
}

/** True outside the schedule's peak hours (end hour exclusive). Unknown times count as peak. */
export function isOffPeak(schedule, timestamp) {
  const ms = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (!schedule || !Number.isFinite(ms) || ms <= 0) return false;
  const [weekday, hour] = weekdayHour(ms, schedule.timezone);
  const peak = (schedule.weekdays || []).includes(weekday) && (schedule.hours || []).some(([start, end]) => hour >= start && hour < end);
  return !peak;
}

/** The index bucket of one request: prompt size, plus :off / :fast when they can change its price. */
export function bucketFor({ model, promptTokens = 0, timestamp = null, fast = false, agentId = null }, table = priceTable()) {
  let bucket = promptBucket(promptTokens);
  const entry = resolve(model, table, { agentId }).entry;
  if (entry?.offPeak && isOffPeak(table.schedules[entry.offPeak.schedule], timestamp)) bucket += ":off";
  if (fast) bucket += ":fast";
  return bucket;
}

/** Local calendar day (YYYY-MM-DD) of a time in ms. */
const localDay = (ms) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/**
 * How current the table is on `now`: its age against `reviewAfterDays`, and the entries
 * whose `reviewBy` date (promotions, previews) has passed — "价格可能已变，请核对".
 */
export function pricingFreshness(table = priceTable(), now = Date.now()) {
  const { raw } = table;
  const today = localDay(now);
  const checked = DATE.test(raw.checkedAt || "") ? Date.parse(`${raw.checkedAt}T00:00:00`) : null;
  const ageDays = checked === null ? null : Math.max(0, Math.floor((Date.parse(`${today}T00:00:00`) - checked) / DAY_MS));
  const reviewAfterDays = raw.reviewAfterDays ?? null;
  const overdue = raw.models.filter((model) => model.reviewBy && today > model.reviewBy).sort((left, right) => left.reviewBy.localeCompare(right.reviewBy));
  return {
    table: { checkedAt: raw.checkedAt || null, ageDays, reviewAfterDays, stale: ageDays !== null && reviewAfterDays !== null && ageDays > reviewAfterDays },
    pricingStale: overdue.length ? { ids: overdue.map((model) => model.id), since: overdue[0].reviewBy } : null,
  };
}

/** The table for GET /api/usage/pricing (data only, no compiled regexes). */
export function publicPriceTable(table = priceTable(), now = Date.now()) {
  const { raw } = table;
  const freshness = pricingFreshness(table, now);
  return {
    schema: raw.schema,
    checkedAt: raw.checkedAt,
    reviewAfterDays: raw.reviewAfterDays ?? null,
    checkedAgeDays: freshness.table.ageDays,
    tableStale: freshness.table.stale,
    pricingStale: freshness.pricingStale,
    currency: raw.currency,
    unit: raw.unit,
    vendors: raw.vendors,
    schedules: raw.schedules,
    fx: raw.fx,
    buckets: SIZE_BUCKETS,
    models: raw.models,
    estimates: raw.estimates,
    families: raw.families,
    // How derived figures are computed, for the UI's "怎么算的".
    rules: { cacheRate: CACHE_RATE_RULE },
  };
}
