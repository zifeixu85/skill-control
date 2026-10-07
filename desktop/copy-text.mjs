/** Largest text the renderer may put on the clipboard. */
export const MAX_COPY_BYTES = 1024 * 1024;

/**
 * Whether a "desktop:copy-text" request may write the clipboard: it must come from the top
 * frame of our own window and carry a string of at most MAX_COPY_BYTES (UTF-8).
 */
export function copyTextAllowed(event, window, text) {
  if (!window || !event || event.sender !== window.webContents) return false;
  if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) return false;
  return typeof text === "string" && Buffer.byteLength(text, "utf8") <= MAX_COPY_BYTES;
}
