/** Nearest ancestor that scrolls vertically, or null. */
export function scrollParent(element: HTMLElement | null): HTMLElement | null {
  let node = element?.parentElement || null;
  while (node) {
    const { overflowY } = window.getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

/** Brings the top of `element` into view inside its own scroll container only. */
export function revealTop(element: HTMLElement | null, margin = 8): void {
  const parent = scrollParent(element);
  if (!element || !parent) return;
  const delta = element.getBoundingClientRect().top - parent.getBoundingClientRect().top;
  if (delta < 0 || delta > parent.clientHeight * 0.6) parent.scrollTop += delta - margin;
}
