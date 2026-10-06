import type { ModelRow } from "./cost";
import { asArray, asNumber, asOptionalNumber, asOptionalString, asRecord, asString, asStringList } from "./parse";

/** GET /api/usage/pricing — the official price table behind 预估费用 (USD per 1M tokens). */

export const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const;
export type PriceField = (typeof PRICE_FIELDS)[number];
export type PriceSet = Record<PriceField, number | null>;

export interface PriceModel {
  id: string;
  aliases: string[];
  vendor: string;
  name: string;
  prices: PriceSet;
  long: { above: number; prices: PriceSet } | null;
  offPeak: { schedule: string; prices: PriceSet } | null;
  changes: { from: string; prices: PriceSet }[];
  fast: number | null;
  status: "promo" | "preview" | null;
  reviewBy: string | null;
  source: string | null;
  note: string | null;
}

export interface PriceEstimate {
  id: string;
  agent: string | null;
  priceAs: string;
  fallback: string | null;
  reason: string;
}

export interface PriceFamily {
  id: string;
  name: string;
  match: string;
  priceAs: string;
}

export interface PricingTable {
  checkedAt: string | null;
  reviewAfterDays: number | null;
  checkedAgeDays: number | null;
  tableStale: boolean;
  pricingStale: { ids: string[]; since: string | null } | null;
  unit: string;
  currency: string;
  vendors: Record<string, { name: string; pricingUrl: string | null }>;
  schedules: Record<string, { note: string }>;
  fx: { currency: string; perUsd: number; note: string }[];
  models: PriceModel[];
  estimates: PriceEstimate[];
  families: PriceFamily[];
}

function priceSet(record: Record<string, unknown>): PriceSet {
  return {
    input: asOptionalNumber(record.input),
    output: asOptionalNumber(record.output),
    cacheRead: asOptionalNumber(record.cacheRead),
    cacheWrite: asOptionalNumber(record.cacheWrite),
    cacheWrite1h: asOptionalNumber(record.cacheWrite1h),
  };
}

function priceModel(value: unknown): PriceModel | null {
  const record = asRecord(value);
  const id = asString(record.id);
  if (!id) return null;
  const long = asRecord(record.long);
  const offPeak = asRecord(record.offPeak);
  const status = asString(record.status);
  return {
    id,
    aliases: asStringList(record.aliases),
    vendor: asString(record.vendor, "other"),
    name: asString(record.name, id),
    prices: priceSet(record),
    long: asOptionalNumber(long.above) !== null ? { above: asNumber(long.above), prices: priceSet(long) } : null,
    offPeak: asString(offPeak.schedule) ? { schedule: asString(offPeak.schedule), prices: priceSet(offPeak) } : null,
    changes: asArray(record.changes)
      .map((item) => ({ from: asString(asRecord(item).from), prices: priceSet(asRecord(item)) }))
      .filter((change) => change.from),
    fast: asOptionalNumber(record.fast),
    status: status === "promo" || status === "preview" ? status : null,
    reviewBy: asOptionalString(record.reviewBy),
    source: /^https:\/\//u.test(asString(record.source)) ? asString(record.source) : null,
    note: asOptionalString(record.note),
  };
}

export function normalizePricing(raw: unknown): PricingTable {
  const record = asRecord(raw);
  const stale = asRecord(record.pricingStale);
  const vendors: PricingTable["vendors"] = {};
  for (const [id, value] of Object.entries(asRecord(record.vendors))) {
    const vendor = asRecord(value);
    const url = asString(vendor.pricingUrl);
    vendors[id] = { name: asString(vendor.name, id), pricingUrl: /^https:\/\//u.test(url) ? url : null };
  }
  const schedules: PricingTable["schedules"] = {};
  for (const [id, value] of Object.entries(asRecord(record.schedules))) schedules[id] = { note: asString(asRecord(value).note) };
  return {
    checkedAt: asOptionalString(record.checkedAt),
    reviewAfterDays: asOptionalNumber(record.reviewAfterDays),
    checkedAgeDays: asOptionalNumber(record.checkedAgeDays),
    tableStale: record.tableStale === true,
    pricingStale: asStringList(stale.ids).length ? { ids: asStringList(stale.ids), since: asOptionalString(stale.since) } : null,
    unit: asString(record.unit, "per 1M tokens"),
    currency: asString(record.currency, "USD"),
    vendors,
    schedules,
    fx: Object.entries(asRecord(record.fx)).map(([currency, value]) => ({
      currency,
      perUsd: asNumber(asRecord(value).perUsd),
      note: asString(asRecord(value).note),
    })),
    models: asArray(record.models).map(priceModel).filter((model): model is PriceModel => Boolean(model)),
    estimates: asArray(record.estimates)
      .map((item) => {
        const estimate = asRecord(item);
        return {
          id: asString(estimate.id),
          agent: asOptionalString(estimate.agent),
          priceAs: asString(estimate.priceAs),
          fallback: asOptionalString(estimate.fallback),
          reason: asString(estimate.reason),
        };
      })
      .filter((estimate) => estimate.id),
    families: asArray(record.families)
      .map((item) => {
        const family = asRecord(item);
        return { id: asString(family.id), name: asString(family.name, asString(family.id)), match: asString(family.match), priceAs: asString(family.priceAs) };
      })
      .filter((family) => family.id),
  };
}

/** "$10", "$0.5", "$0.003625": exact table values, no rounding, no trailing zeros. */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `$${Number(value.toFixed(6)).toString()}`;
}

/** 272000 → "272K", 1000000 → "1M". */
export function formatThreshold(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

const FIELD_LABELS: Record<PriceField, string> = {
  input: "输入",
  output: "输出",
  cacheRead: "缓存读",
  cacheWrite: "缓存写",
  cacheWrite1h: "1 小时缓存写",
};

/** "输入 $20 · 输出 $75" for the fields a variant sets. */
export function priceSummary(prices: PriceSet, fields: readonly PriceField[] = PRICE_FIELDS): string {
  return fields
    .filter((field) => prices[field] !== null)
    .map((field) => `${FIELD_LABELS[field]} ${formatPrice(prices[field])}`)
    .join(" · ");
}

/** ">272K 输入 $20 · 输出 $75" — input and output are enough for the table cell. */
export function longLabel(model: PriceModel): string | null {
  if (!model.long) return null;
  return `>${formatThreshold(model.long.above)} ${priceSummary(model.long.prices, ["input", "output"])}`;
}

/**
 * The price a field is billed at, and whether it was filled in: a missing cache read or
 * write is billed at the input price, a missing 1-hour write at the cache-write price.
 */
export function effectivePrice(prices: PriceSet, field: PriceField): { value: number | null; inherited: boolean } {
  if (prices[field] !== null) return { value: prices[field], inherited: false };
  if (field === "cacheRead" || field === "cacheWrite") return { value: prices.input, inherited: prices.input !== null };
  if (field === "cacheWrite1h") {
    const write = effectivePrice(prices, "cacheWrite");
    return { value: write.value, inherited: write.value !== null };
  }
  return { value: null, inherited: false };
}

export const INHERITED_HINTS: Partial<Record<PriceField, string>> = {
  cacheRead: "官方没有缓存折扣，按输入价计",
  cacheWrite: "官方没有单列缓存写入价，按输入价计",
  cacheWrite1h: "没有单列 1 小时缓存写入价，按缓存写入价计",
};

/** Price-table ids this machine used: the rows models were priced by, and their targets. */
export function usedPriceIds(rows: ModelRow[]): Set<string> {
  const used = new Set<string>();
  for (const row of rows) {
    if (row.basis === "unpriced" || row.basis === "reported") continue;
    if (row.priceRef) used.add(`${row.priceRef.section}:${row.priceRef.id}`);
    if (row.priceAs && !row.priceAs.startsWith("@")) used.add(`models:${row.priceAs}`);
  }
  return used;
}

export interface VendorGroup {
  id: string;
  name: string;
  pricingUrl: string | null;
  models: PriceModel[];
  usedCount: number;
}

/** Models grouped by vendor in table order; within a vendor, models used here come first. */
export function groupByVendor(table: PricingTable, used: Set<string>): VendorGroup[] {
  const groups = new Map<string, PriceModel[]>();
  for (const model of table.models) groups.set(model.vendor, [...(groups.get(model.vendor) || []), model]);
  return [...groups.entries()].map(([id, models]) => {
    const isUsed = (model: PriceModel) => used.has(`models:${model.id}`);
    const ordered = [...models.filter(isUsed), ...models.filter((model) => !isUsed(model))];
    return {
      id,
      name: table.vendors[id]?.name || id,
      pricingUrl: table.vendors[id]?.pricingUrl || null,
      models: ordered,
      usedCount: ordered.filter(isUsed).length,
    };
  });
}

/** DOM id of a price-table row, e.g. "price-models-gpt-5.5". */
export const priceRowId = (target: string) => `price-${target.replace(":", "-").replace(/[^\w.-]/gu, "_")}`;

export const nameOf = (table: PricingTable, id: string) => table.models.find((model) => model.id === id)?.name || id;
