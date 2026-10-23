"use client";

import { useId, useMemo } from "react";
import { usePersistent } from "../../hooks/usePersistent";
import { resolveSort, SORT_LABELS, sortItems, sortOptions, sortStore, type SortFields, type SortKey } from "../../lib/sort";

/** Sorted items, the offered options and the current choice for one list (remembered per list). */
export function useSortedList<T>(listId: string, items: readonly T[], fields: (item: T) => SortFields, allowed?: readonly SortKey[]) {
  const [stored, setStored] = usePersistent(sortStore(listId));
  const options = useMemo(() => sortOptions(items, fields, allowed), [items, fields, allowed]);
  const key = resolveSort(stored, options);
  const sorted = useMemo(() => sortItems(items, key, fields), [items, key, fields]);
  return { sorted, key, options, setKey: setStored as (key: SortKey) => void };
}

/** "排序 [最常用 ▾]" — a native select, so it works with the keyboard and screen readers as-is. */
export function SortControl({
  value,
  options,
  onChange,
  label = "排序",
  labels,
}: {
  value: SortKey;
  options: readonly SortKey[];
  onChange: (key: SortKey) => void;
  label?: string;
  /** Wording for this list, e.g. uses → "被技能引用最多". */
  labels?: Partial<Record<SortKey, string>>;
}) {
  const id = useId();
  if (options.length < 2) return null;
  return (
    <span className="sort-control">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value as SortKey)}>
        {options.map((key) => (
          <option key={key} value={key}>
            {labels?.[key] || SORT_LABELS[key]}
          </option>
        ))}
      </select>
    </span>
  );
}
