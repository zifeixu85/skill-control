/**
 * Brings an element into view inside the page's own scroll area (`.scroll`) and flashes it
 * once. Never scrolls the window or the shell, so the page header stays where it is.
 */
export function revealInPage(element: HTMLElement | null, { align = "center", flash = true }: { align?: "center" | "start"; flash?: boolean } = {}) {
  if (!element) return;
  const scroll = element.closest<HTMLElement>(".scroll");
  if (scroll) {
    const box = element.getBoundingClientRect();
    const offset = box.top - scroll.getBoundingClientRect().top;
    const margin = align === "start" ? 12 : Math.max(16, (scroll.clientHeight - box.height) / 2);
    scroll.scrollTop += offset - margin;
  }
  if (!flash) return;
  element.classList.remove("flash");
  // Restart the animation even when the same element is shown twice.
  void element.getBoundingClientRect();
  element.classList.add("flash");
  window.setTimeout(() => element.classList.remove("flash"), 2600);
}
