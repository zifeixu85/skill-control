import type { UsagePoint } from "./usage";

/**
 * Time windows on 数据: 7 / 30 / 90 days or 所有时间 ("all"; the service answers with
 * windowDays null and windowLabel "所有时间"). Long ranges chart by week or month.
 */

export type UsageWindow = "7" | "30" | "90" | "all";

export const WINDOW_OPTIONS: { id: UsageWindow; label: string }[] = [
  { id: "7", label: "7 天" },
  { id: "30", label: "30 天" },
  { id: "90", label: "90 天" },
  { id: "all", label: "所有时间" },
];

export const ALL_TIME = "所有时间";

/** The `days` query value for a window. */
export const windowParam = (window: UsageWindow): number | "all" => (window === "all" ? "all" : Number(window));

/** "近 30 天" or "所有时间"; the service's own label wins when it sends one. */
export function windowLabel(days: number | null | undefined, serviceLabel?: string | null): string {
  if (serviceLabel) return serviceLabel;
  return days ? `近 ${days} 天` : ALL_TIME;
}

export type Period = "day" | "week" | "month";

export interface ChartPoint {
  label: string;
  date: string;
  sessions: number;
  tokens: number;
  costUsd: number;
}

const DAY = 86_400_000;
const parse = (date: string) => {
  const match = date.slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
};
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayText = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

/** Day up to ~120 days, then weeks (Monday start) up to ~1.5 years, then months. */
export function periodFor(spanDays: number): Period {
  if (spanDays <= 120) return "day";
  if (spanDays <= 540) return "week";
  return "month";
}

function bucketOf(date: string, period: Period): string {
  if (period === "day") return date;
  if (period === "month") return `${date.slice(0, 7)}-01`;
  const ms = parse(date) ?? 0;
  const weekday = (new Date(ms).getUTCDay() + 6) % 7; // Monday = 0
  return iso(ms - weekday * DAY);
}

/** Labels carry the year when it isn't the end date's year, e.g. "2025年9月1日起". */
function labelOf(bucket: string, period: Period, endYear: string): string {
  if (period === "month") return `${bucket.slice(0, 4)}年${Number(bucket.slice(5, 7))}月`;
  const year = bucket.slice(0, 4) === endYear ? "" : `${bucket.slice(0, 4)}年`;
  return period === "week" ? `${year}${dayText(bucket)}起` : `${year}${dayText(bucket)}`;
}

/**
 * Chart points for a window ending on `endDate`: every day (zero-filled) for short windows,
 * summed weeks or months for long ones. Summed periods count sessions by the day they
 * started, since a session active on several days would otherwise count several times.
 */
export function chartPoints(series: UsagePoint[], days: number | null, endDate: string): { period: Period; points: ChartPoint[] } {
  const end = parse(endDate);
  const dated = series.filter((point) => parse(point.date) !== null);
  if (end === null) return { period: "day", points: [] };
  const first = days ? end - (days - 1) * DAY : Math.min(end, ...dated.map((point) => parse(point.date) as number));
  const span = Math.round((end - first) / DAY) + 1;
  const period = periodFor(span);
  const byDate = new Map(dated.map((point) => [point.date.slice(0, 10), point]));
  const buckets = new Map<string, ChartPoint>();
  for (let ms = first; ms <= end; ms += DAY) {
    const date = iso(ms);
    const key = bucketOf(date, period);
    const point = byDate.get(date);
    const current = buckets.get(key) || { label: labelOf(key, period, endDate.slice(0, 4)), date: key, sessions: 0, tokens: 0, costUsd: 0 };
    buckets.set(key, {
      ...current,
      sessions: current.sessions + (point ? (period === "day" ? point.sessions : point.sessionsStarted) : 0),
      tokens: current.tokens + (point?.tokens || 0),
      costUsd: current.costUsd + (point?.costUsd || 0),
    });
  }
  return { period, points: [...buckets.values()] };
}

export const PERIOD_NAMES: Record<Period, string> = { day: "日期", week: "周", month: "月" };

/** "每天活跃的会话数" / "每周开始的会话数" / "每月开始的会话数". */
export function sessionsMetricLabel(period: Period): string {
  return period === "day" ? "每天活跃的会话数" : `每${period === "week" ? "周" : "月"}开始的会话数`;
}

export const perPeriod = (period: Period) => (period === "day" ? "每天" : period === "week" ? "每周" : "每月");
