import { cacheHitRate } from "./cache";
import type { ChipSpec } from "./chips";
import { asArray, asNumber, asOptionalNumber, asOptionalString, asRecord, asString, asStringList } from "./parse";

/**
 * Estimated cost at each vendor's official API prices (docs/ARCHITECTURE.md · 预估费用).
 * Usage inside a subscription is priced as its API equivalent, so it isn't money spent.
 */

export const COST_HINT = "按各厂商官方 API 价格估算；订阅内用量不等于实际支出";

export type CostBasis = "official" | "estimate" | "family" | "reported" | "unpriced";

export interface CostSplit {
  official: number;
  estimate: number;
  family: number;
  reported: number;
}

export interface Cost {
  costUsd: number | null;
  costBasis: CostSplit | null;
  unpricedTokens: number;
}

export interface ModelTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  total: number;
}

export interface PriceRef {
  section: "models" | "estimates" | "families";
  id: string;
}

export interface ModelRow {
  model: string;
  name: string;
  vendor: string | null;
  basis: CostBasis;
  priceAs: string | null;
  priceRef: PriceRef | null;
  tokens: ModelTokens;
  requests: number;
  costUsd: number;
  longShare: number;
  /** 0–1, see lib/cache. */
  cacheHitRate: number | null;
  /** Only in /api/usage/models: which Agents used the model. */
  agents: { agentId: string; tokens: number; costUsd: number }[];
}

export interface ModelsReport {
  /** Null for 所有时间. */
  days: number | null;
  totals: Cost;
  models: ModelRow[];
  unpriced: string[];
  pricingStale: { ids: string[]; since: string | null } | null;
  pricingTable: { checkedAt: string | null; ageDays: number | null; reviewAfterDays: number | null; stale: boolean } | null;
}

export const BASIS_LABELS: Record<CostBasis, string> = {
  official: "官方",
  estimate: "估算",
  family: "系列兜底",
  reported: "产品自报",
  unpriced: "未定价",
};

export const BASIS_HINTS: Record<CostBasis, string> = {
  official: "按这个模型在官方价目表里的价格",
  estimate: "官方没有单独定价，按指定的模型估算",
  family: "价格表里没有这个 id，按同系列的代表模型估算",
  reported: "没有模型信息，用产品自己记录的费用",
  unpriced: "价格表里没有这个模型，不计入费用",
};

const BASES: CostBasis[] = ["official", "estimate", "family", "reported", "unpriced"];

export function basisChip(basis: CostBasis): ChipSpec {
  const tone = basis === "official" ? "ok" : basis === "unpriced" ? "danger" : basis === "reported" ? "mute" : "warn";
  return { id: `basis-${basis}`, kind: "status", tone, text: BASIS_LABELS[basis], title: BASIS_HINTS[basis] };
}

export function normalizeCost(value: unknown): Cost {
  const record = asRecord(value);
  const split = asRecord(record.costBasis);
  return {
    costUsd: asOptionalNumber(record.costUsd),
    costBasis: Object.keys(split).length
      ? { official: asNumber(split.official), estimate: asNumber(split.estimate), family: asNumber(split.family), reported: asNumber(split.reported) }
      : null,
    unpricedTokens: asNumber(record.unpricedTokens),
  };
}

function normalizeModelTokens(value: unknown): ModelTokens {
  const record = asRecord(value);
  const input = asNumber(record.input);
  const output = asNumber(record.output);
  const cacheRead = asNumber(record.cacheRead);
  const cacheWrite = asNumber(record.cacheWrite);
  const cacheWrite1h = asNumber(record.cacheWrite1h);
  return { input, output, cacheRead, cacheWrite, cacheWrite1h, total: asNumber(record.total, input + output + cacheRead + cacheWrite + cacheWrite1h) };
}

export function normalizeModelRow(value: unknown): ModelRow | null {
  const record = asRecord(value);
  const model = asString(record.model);
  if (!model) return null;
  const basis = asString(record.basis) as CostBasis;
  const ref = asRecord(record.priceRef);
  const section = asString(ref.section);
  return {
    model,
    name: asString(record.name, model),
    vendor: asOptionalString(record.vendor),
    basis: BASES.includes(basis) ? basis : "unpriced",
    priceAs: asOptionalString(record.priceAs),
    priceRef:
      ["models", "estimates", "families"].includes(section) && asString(ref.id)
        ? { section: section as PriceRef["section"], id: asString(ref.id) }
        : null,
    tokens: normalizeModelTokens(record.tokens),
    cacheHitRate: cacheHitRate(record.cacheHitRate, normalizeModelTokens(record.tokens)),
    requests: asNumber(record.requests),
    costUsd: asNumber(record.costUsd),
    longShare: Math.min(1, Math.max(0, asNumber(record.longShare))),
    agents: asArray(record.agents)
      .map((item) => {
        const agent = asRecord(item);
        return { agentId: asString(agent.agentId), tokens: asNumber(agent.tokens), costUsd: asNumber(agent.costUsd) };
      })
      .filter((agent) => agent.agentId),
  };
}

export const normalizeModelRows = (value: unknown): ModelRow[] =>
  sortModelRows(asArray(value).map(normalizeModelRow).filter((row): row is ModelRow => Boolean(row)));

export function normalizeModelsReport(raw: unknown, days: number | null = 30): ModelsReport {
  const record = asRecord(raw);
  const stale = asRecord(record.pricingStale);
  const table = asRecord(record.pricingTable);
  return {
    days: record.windowDays === null || days === null ? null : asNumber(record.windowDays, days),
    totals: normalizeCost(record.totals),
    models: normalizeModelRows(record.models),
    unpriced: asStringList(record.unpriced),
    pricingStale: asStringList(stale.ids).length ? { ids: asStringList(stale.ids), since: asOptionalString(stale.since) } : null,
    pricingTable: Object.keys(table).length
      ? {
          checkedAt: asOptionalString(table.checkedAt),
          ageDays: asOptionalNumber(table.ageDays),
          reviewAfterDays: asOptionalNumber(table.reviewAfterDays),
          stale: table.stale === true,
        }
      : null,
  };
}

/** Highest cost first; unpriced rows (no cost) by tokens, after everything that has a price. */
export function sortModelRows(rows: ModelRow[]): ModelRow[] {
  return [...rows].sort(
    (left, right) =>
      Number(left.basis === "unpriced") - Number(right.basis === "unpriced") ||
      right.costUsd - left.costUsd ||
      right.tokens.total - left.tokens.total ||
      left.model.localeCompare(right.model),
  );
}

/** USD with two decimals; tiny non-zero amounts read "<$0.01"; no value is "—". */
export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.01) return "<$0.01";
  // Cents are noise from $1,000 up and crowd narrow cards.
  const digits = Math.abs(value) >= 1000 ? 0 : 2;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Total of several costs (e.g. a skill across Agents), keeping the basis split. */
export function sumCosts(items: { costUsd: number | null; costBasis: CostSplit | null }[]): { costUsd: number; costBasis: CostSplit | null } {
  const splits = items.map((item) => item.costBasis).filter((split): split is CostSplit => Boolean(split));
  const add = (key: keyof CostSplit) => splits.reduce((sum, split) => sum + split[key], 0);
  return {
    costUsd: items.reduce((sum, item) => sum + (item.costUsd || 0), 0),
    costBasis: splits.length ? { official: add("official"), estimate: add("estimate"), family: add("family"), reported: add("reported") } : null,
  };
}

/** "长上下文 63%" for rows where part of the tokens were billed at the long-context price. */
export function longShareLabel(share: number): string | null {
  if (!(share > 0)) return null;
  const percent = share * 100;
  return `长上下文 ${percent < 1 ? "<1" : Math.round(percent)}%`;
}

/** Where a 依据 chip leads on the price table: the row it was priced by, else the rules. */
export function priceTarget(row: Pick<ModelRow, "priceRef" | "basis">): string {
  return row.priceRef ? `${row.priceRef.section}:${row.priceRef.id}` : "rules";
}
