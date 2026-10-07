/**
 * One way to copy text everywhere. The packaged app can't use navigator.clipboard (the
 * permission is denied), so the desktop bridge goes first; the browser API and a hidden
 * textarea + execCommand cover the web build and older shells.
 */

export interface ClipboardEnvironment {
  bridge?: { copyText?: (text: string) => Promise<boolean> } | null;
  clipboard?: { writeText?: (text: string) => Promise<void> } | null;
  document?: Pick<Document, "createElement" | "body" | "execCommand" | "activeElement"> | null;
}

function browserEnvironment(): ClipboardEnvironment {
  if (typeof window === "undefined") return {};
  return {
    bridge: (window as { skillManagerDesktop?: ClipboardEnvironment["bridge"] }).skillManagerDesktop ?? null,
    clipboard: typeof navigator !== "undefined" ? navigator.clipboard ?? null : null,
    document,
  };
}

function textareaCopy(text: string, doc: NonNullable<ClipboardEnvironment["document"]>): boolean {
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.pointerEvents = "none";
  area.style.left = "-9999px";
  const previous = doc.activeElement as HTMLElement | null;
  try {
    doc.body.appendChild(area);
    area.select();
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus?.();
  }
}

/** Resolves true when the text reached the clipboard by any route. Never throws. */
export async function copyText(text: string, environment: ClipboardEnvironment = browserEnvironment()): Promise<boolean> {
  if (typeof text !== "string") return false;
  const { bridge, clipboard, document: doc } = environment;
  if (typeof bridge?.copyText === "function") {
    try {
      if (await bridge.copyText(text)) return true;
    } catch {
      // Fall through to the browser routes.
    }
  }
  if (typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Denied (packaged app, insecure origin): try the legacy route.
    }
  }
  return doc ? textareaCopy(text, doc) : false;
}

export const COPIED_FOR_AI = "已复制，粘贴给你常用的 AI（如 Codex、Claude Code）";
export const COPY_FAILED = "复制失败，可以手动选中文字复制";
