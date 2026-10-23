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

const APP_UPDATE_STATE_CHANNEL = "desktop:app-update-state";
const appUpdateUnavailable = Object.freeze({
  status: "error",
  current: "",
  canInstall: false,
  error: "应用更新服务暂时不可用。",
});
const invokeAppUpdate = (channel) =>
  ipcRenderer.invoke(channel).then(
    (state) => (state && typeof state === "object" ? state : appUpdateUnavailable),
    () => appUpdateUnavailable,
  );

// Skill Control's own updates. Every call resolves with the state object (never rejects);
// onProgress receives the full state on every change and returns an unsubscribe function.
const appUpdate = Object.freeze({
  status: () => invokeAppUpdate("desktop:app-update-status"),
  check: () => invokeAppUpdate("desktop:app-update-check"),
  download: () => invokeAppUpdate("desktop:app-update-download"),
  install: () => invokeAppUpdate("desktop:app-update-install"),
  onProgress: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, state) => {
      if (state && typeof state === "object") callback(state);
    };
    ipcRenderer.on(APP_UPDATE_STATE_CHANNEL, listener);
    return () => ipcRenderer.removeListener(APP_UPDATE_STATE_CHANNEL, listener);
  },
});

const desktopApi = Object.freeze({
  apiBase,
  appUpdate,
  getRuntimeInfo: () => ipcRenderer.invoke("desktop:get-runtime-info"),
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  // Resolves true when the text was copied (packaged apps cannot use navigator.clipboard).
  copyText: (text) =>
    typeof text === "string"
      ? ipcRenderer.invoke("desktop:copy-text", text).then(Boolean, () => false)
      : Promise.resolve(false),
});

contextBridge.exposeInMainWorld("skillManagerDesktop", desktopApi);
