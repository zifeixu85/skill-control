/**
 * Whether an IPC request comes from the top frame of our own window. Every privileged
 * desktop channel (clipboard, app updates) checks this before doing anything.
 */
export function isOwnTopFrame(event, window) {
  if (!window || !event || event.sender !== window.webContents) return false;
  if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) return false;
  return true;
}
