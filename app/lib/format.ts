/** Pure formatting helpers. Callers pass `now` so rendering stays deterministic. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function parseDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "9月3日"; adds the year when it differs from `now`'s year. */
export function formatMonthDay(value: string | null | undefined, now?: number): string {
  const date = parseDate(value);
  if (!date) return "";
  const label = `${date.getMonth() + 1}月${date.getDate()}日`;
  if (now === undefined) return label;
  const year = new Date(now).getFullYear();
  return date.getFullYear() === year ? label : `${date.getFullYear()}年${label}`;
}

export function formatRelative(value: string | null | undefined, now: number): string {
  const date = parseDate(value);
  if (!date) return "未知";
  const difference = now - date.getTime();
  if (difference < MINUTE) return "刚刚";
  if (difference < HOUR) return `${Math.floor(difference / MINUTE)} 分钟前`;
  if (difference < DAY) return `${Math.floor(difference / HOUR)} 小时前`;
  const days = Math.floor(difference / DAY);
  if (days < 30) return `${days} 天前`;
  return formatMonthDay(value, now);
}

export function formatDateTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return "";
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatBytes(value: number | null | undefined): string {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatInteger(value: number | null | undefined): string {
  return new Intl.NumberFormat("zh-CN").format(Math.round(Number(value) || 0));
}

/** Chinese compact numbers: 9,999 → "9,999"; 26,900 → "2.7 万"; 1.2e8 → "1.2 亿". */
export function formatCompact(value: number | null | undefined): string {
  const number = Number(value) || 0;
  const absolute = Math.abs(number);
  const trim = (text: string) => text.replace(/\.0$/, "");
  if (absolute < 10_000) return formatInteger(number);
  if (absolute < 100_000_000) return `${trim((number / 10_000).toFixed(1))} 万`;
  return `${trim((number / 100_000_000).toFixed(1))} 亿`;
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value < 0.01) return "< $0.01";
  return `$${value < 100 ? value.toFixed(2) : Math.round(value).toLocaleString("en-US")}`;
}

/** Short label for a skill title: drops a trailing " — subtitle" or "：说明". */
export function shortTitle(title: string): string {
  const head = title.split(/\s+[—–\-|·]\s+|｜|：/)[0] || title;
  return head.trim() || title;
}

export function joinNames(names: string[], separator = "、"): string {
  return names.filter(Boolean).join(separator);
}

/** Last path segment of a "~/a/b" style display path. */
export function baseName(pathname: string | null | undefined): string {
  if (!pathname) return "";
  const parts = pathname.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || pathname;
}
