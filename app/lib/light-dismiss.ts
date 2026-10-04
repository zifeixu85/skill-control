/**
 * Light dismiss for detail panels: a press outside the panel closes it, except on things
 * that open or switch a detail, on other panels and layers (dialogs, sheets, popovers,
 * toasts), on scrollbars, with a non-primary button, or while the panel is busy.
 */

/** Marks rows and cards that open or switch a detail: pressing one switches, never closes first. */
export const DETAIL_TRIGGER = "data-detail-trigger";
/** Marks controls that belong to a panel without being inside it (e.g. its resize handle). */
export const KEEP_PANEL = "data-keep-panel";
/** Set on every detail panel root. */
export const PANEL = "data-panel";

export const KEEP_SELECTOR = [
  `[${DETAIL_TRIGGER}]`,
  `[${KEEP_PANEL}]`,
  `[${PANEL}]`,
  "[aria-modal='true']",
  ".scrim",
  ".toast-region",
  "[role='menu']",
  "[role='listbox']",
  "[data-popover]",
].join(", ");

interface ClosestTarget {
  closest: (selector: string) => unknown;
  isConnected?: boolean;
}

export interface DismissInput {
  target: unknown;
  panel: { contains: (node: never) => boolean } | null;
  button?: number;
  onScrollbar?: boolean;
  busy?: boolean;
}

const isElementLike = (value: unknown): value is ClosestTarget =>
  Boolean(value) && typeof (value as ClosestTarget).closest === "function";

export function shouldLightDismiss({ target, panel, button = 0, onScrollbar = false, busy = false }: DismissInput): boolean {
  if (!panel || busy || button !== 0 || onScrollbar) return false;
  if (!isElementLike(target) || target.isConnected === false) return false;
  if (panel.contains(target as never)) return false;
  return !target.closest(KEEP_SELECTOR);
}

/** A press on an element's own scrollbar (the gutter beyond its client box). */
export function onOwnScrollbar(target: unknown, offsetX: number, offsetY: number): boolean {
  const box = target as { clientWidth?: number; clientHeight?: number; scrollHeight?: number; scrollWidth?: number };
  if (!box || typeof box.clientWidth !== "number" || typeof box.clientHeight !== "number") return false;
  const vertical = (box.scrollHeight || 0) > box.clientHeight && box.clientWidth > 0 && offsetX >= box.clientWidth;
  const horizontal = (box.scrollWidth || 0) > box.clientWidth && box.clientHeight > 0 && offsetY >= box.clientHeight;
  return vertical || horizontal;
}
