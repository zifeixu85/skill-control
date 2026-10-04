/** Tolerant readers for endpoints whose shapes may still evolve. Never throw. */

export type UnknownRecord = Record<string, unknown>;

export function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

export function asOptionalString(value: unknown): string | null {
  const text = asString(value);
  return text ? text : null;
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

export function asOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = asNumber(value, Number.NaN);
  return Number.isFinite(number) ? number : null;
}

export function asBoolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function asStringList(value: unknown): string[] {
  return asArray(value)
    .map((item) => asString(item))
    .filter(Boolean);
}

/** First present key among aliases, e.g. pick(record, "count", "uses"). */
export function pick(record: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}
