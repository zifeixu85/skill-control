import { persistentStore, type PersistentStore } from "./storage";

/**
 * One sort control for every list: 最近使用 / 最新安装 / 最常用 / 名称 (+ 最近更新 for skills).
 * Each list remembers its own choice. Items without a value sort last; ties go by name.
 */

export type SortKey = "uses" | "used" | "installed" | "updated" | "name";

export const SORT_LABELS: Record<SortKey, string> = {
  uses: "最常用",
  used: "最近使用",
  installed: "最新安装",
  updated: "最近更新",
  name: "名称",
};

/** Display order of the options. */
export const SORT_ORDER: SortKey[] = ["uses", "used", "installed", "updated", "name"];

export interface SortFields {
  name: string;
  uses?: number | null;
  lastUsedAt?: string | null;
  installedAt?: string | null;
  updatedAt?: string | null;
}

const time = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

function valueOf(fields: SortFields, key: SortKey): number | null {
  if (key === "uses") return typeof fields.uses === "number" && fields.uses > 0 ? fields.uses : null;
  if (key === "used") return time(fields.lastUsedAt);
  if (key === "installed") return time(fields.installedAt);
  if (key === "updated") return time(fields.updatedAt);
  return null;
}

const collator = typeof Intl !== "undefined" ? new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" }) : null;
export const compareNames = (left: string, right: string) => (collator ? collator.compare(left, right) : left.localeCompare(right));

/** A new sorted array; never mutates `items`. */
export function sortItems<T>(items: readonly T[], key: SortKey, fields: (item: T) => SortFields): T[] {
  const rows = items.map((item) => ({ item, fields: fields(item) }));
  rows.sort((left, right) => {
    if (key !== "name") {
      const a = valueOf(left.fields, key);
      const b = valueOf(right.fields, key);
      if (a !== null || b !== null) {
        if (a === null) return 1;
        if (b === null) return -1;
        if (b !== a) return b - a;
      }
    }
    return compareNames(left.fields.name, right.fields.name);
  });
  return rows.map((row) => row.item);
}

/** The options worth offering: name always, the others only when some item has that value. */
export function sortOptions<T>(items: readonly T[], fields: (item: T) => SortFields, allowed: readonly SortKey[] = SORT_ORDER): SortKey[] {
  const present = new Set<SortKey>(["name"]);
  for (const item of items) {
    const value = fields(item);
    for (const key of allowed) if (key !== "name" && valueOf(value, key) !== null) present.add(key);
    if (present.size === allowed.length) break;
  }
  return SORT_ORDER.filter((key) => allowed.includes(key) && present.has(key));
}

/** 最常用 when there is usage data, else 名称; a remembered choice wins when it's still offered. */
export function resolveSort(stored: SortKey | "", options: readonly SortKey[]): SortKey {
  if (stored && options.includes(stored)) return stored;
  return options.includes("uses") ? "uses" : "name";
}

const stores = new Map<string, PersistentStore<SortKey | "">>();
const isSortKey = (value: string): value is SortKey => (SORT_ORDER as string[]).includes(value);

/** Per-list remembered choice ("" = not chosen yet, so the default can follow the data). */
export function sortStore(listId: string): PersistentStore<SortKey | ""> {
  const existing = stores.get(listId);
  if (existing) return existing;
  const store = persistentStore<SortKey | "">(`sort:${listId}`, "", (value) => value === "" || isSortKey(value));
  stores.set(listId, store);
  return store;
}
