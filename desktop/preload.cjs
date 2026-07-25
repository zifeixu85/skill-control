/* eslint-disable @typescript-eslint/no-require-imports -- Electron sandboxed preload scripts use CommonJS. */
const { contextBridge, ipcRenderer } = require("electron");

const apiArgument = process.argv.find((argument) =>
  argument.startsWith("--skill-control-api-base="),
);
let apiBase = "http://127.0.0.1:43110";
try {
  const candidate = new URL(
    apiArgument?.slice("--skill-control-api-base=".length) || apiBase,
  );
  if (
    candidate.protocol === "http:" &&
    candidate.hostname === "127.0.0.1" &&
    candidate.pathname === "/" &&
    !candidate.username &&
    !candidate.password
  ) {
    apiBase = candidate.origin;
  }
} catch {
  // Keep the source-development default if the trusted main argument is absent.
}

const desktopApi = Object.freeze({
  apiBase,
  getRuntimeInfo: () => ipcRenderer.invoke("desktop:get-runtime-info"),
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
});

contextBridge.exposeInMainWorld("skillManagerDesktop", desktopApi);
