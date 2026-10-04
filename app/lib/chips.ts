/**
 * Chips on rows and cards follow one order: status (colored) → kind (neutral) → counts
 * (neutral, number emphasised). They stay on one line; what doesn't fit becomes "+N".
 */

export type ChipKind = "status" | "kind" | "count";
export type ChipTone = "ok" | "warn" | "info" | "danger" | "mute";

export interface ChipSpec {
  id: string;
  kind: ChipKind;
  /** Plain text, also used for the "+N" tooltip and screen readers. */
  text: string;
  tone?: ChipTone;
  /** For counts: the number shown in bold, with the text around it. */
  count?: { before?: string; value: number | string; after?: string };
  title?: string;
}

const ORDER: Record<ChipKind, number> = { status: 0, kind: 1, count: 2 };

/** Sorted by kind (stable within a kind), then split into what shows and what folds into +N. */
export function arrangeChips(chips: ChipSpec[], max: number): { shown: ChipSpec[]; hidden: ChipSpec[] } {
  const sorted = chips
    .map((chip, index) => ({ chip, index }))
    .sort((left, right) => ORDER[left.chip.kind] - ORDER[right.chip.kind] || left.index - right.index)
    .map((item) => item.chip);
  if (sorted.length <= max) return { shown: sorted, hidden: [] };
  // "+N" takes a slot itself.
  const keep = Math.max(1, max - 1);
  return { shown: sorted.slice(0, keep), hidden: sorted.slice(keep) };
}

export const countChip = (id: string, value: number, after: string, before = ""): ChipSpec => ({
  id,
  kind: "count",
  text: `${before}${value}${after}`,
  count: { before, value, after },
});

/**
 * How many chips (measured `widths`, in order) fit in `available` px, at most `max`. When
 * not all show, room is kept for the "+N" chip; at least one chip always shows (it truncates).
 */
export function fitCount(widths: number[], available: number, gap: number, moreWidth: number, max = Infinity): number {
  const total = (count: number) => widths.slice(0, count).reduce((sum, width, index) => sum + width + (index ? gap : 0), 0);
  if (widths.length <= max && total(widths.length) <= available) return widths.length;
  let count = Math.min(widths.length - 1, max);
  while (count > 1 && total(count) + gap + moreWidth > available) count -= 1;
  return Math.max(1, count);
}
