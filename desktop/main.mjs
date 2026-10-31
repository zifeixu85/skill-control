import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMenuTemplate } from "./app-menu.mjs";
import { createAppUpdater } from "./app-updater.mjs";
import { copyTextAllowed } from "./copy-text.mjs";
import { isOwnTopFrame } from "./ipc-guard.mjs";
import { proxyConfigFromEnv } from "./network-proxy.mjs";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  session,
  shell,
} from "electron";

const DESKTOP_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = path.resolve(DESKTOP_DIRECTORY, "..");
const MANAGER_HOST = "127.0.0.1";
// SKILL_MANAGER_DESKTOP_MANAGER_PORT moves the preferred manager port (the packaged smoke
// test uses a free one so it never touches a running copy on 43110).
const DEFAULT_MANAGER_PORT = readPort(
  process.env.SKILL_MANAGER_DESKTOP_MANAGER_PORT,
  43110,
);
const MANAGER_SERVICE_NAME = "Skill Control local service";
const PRODUCTION_WEB_PORT = readPort(
  process.env.SKILL_MANAGER_DESKTOP_WEB_PORT,
  0,
);
const APP_UPDATE_STATE_CHANNEL = "desktop:app-update-state";
const NAVIGATE_CHANNEL = "desktop:navigate";
const STARTUP_PAGE = path.join(DESKTOP_DIRECTORY, "startup.html");
// The local service's network checks (Agent versions, skill and plugin updates) go through
// Chromium's network stack too, so the system proxy applies (server/local-server.mjs startServer).
const serverFetch = (input, init) => net.fetch(input, init);

let mainWindow = null;
let managerServer = null;
let webServer = null;
let applicationOrigin = null;
let managerPort = DEFAULT_MANAGER_PORT;
let quitting = false;
let appUpdater = null;

app.setName("Skill Control");

function readPort(value, fallback) {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`无效的本地端口：${value}`);
  }
  return port;
}

function getManagerUrl() {
  return `http://${MANAGER_HOST}:${managerPort}`;
}

function normalizeLocalUrl(rawValue) {
  if (!rawValue) return null;
  const url = new URL(rawValue);
  const isLoopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (url.protocol !== "http:" || !isLoopback || url.username || url.password) {
    throw new Error("桌面开发地址必须是无凭据的本机 HTTP 地址。");
  }
  return url;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 1_200) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function probeManagerService(port, origin) {
  try {
    const response = await fetchWithTimeout(
      `http://${MANAGER_HOST}:${port}/api/health`,
      {
      headers: { Origin: origin },
      },
    );
    const payload = await response.json().catch(() => null);
    if (
      response.ok &&
      payload?.ok === true &&
      payload?.service === MANAGER_SERVICE_NAME
    ) {
      return {
        kind: "manager",
        originAllowed:
          response.headers.get("access-control-allow-origin") === origin,
      };
    }
    return { kind: "occupied", originAllowed: false };
  } catch {
    return { kind: "available", originAllowed: false };
  }
}

function waitForServer(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const handleListening = () => {
      cleanup();
      resolve();
    };
    const handleError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      server.off("listening", handleListening);
      server.off("error", handleError);
    };
    server.once("listening", handleListening);
    server.once("error", handleError);
  });
}

async function startManagerService(origin) {
  const probe = await probeManagerService(DEFAULT_MANAGER_PORT, origin);
  if (probe.kind === "manager" && probe.originAllowed) {
    managerPort = DEFAULT_MANAGER_PORT;
    console.info("[desktop] 复用已运行的本地 Skills 服务。");
    return;
  }

  process.env.SKILL_MANAGER_HOST = MANAGER_HOST;
  process.env.SKILL_MANAGER_ORIGINS = origin;
  // How the `skill-control` launcher starts this app's own Node (server/cli-launcher.mjs):
  // the executable, app.asar, and the bundle id it looks the app up by after a move or update.
  process.env.SKILL_CONTROL_APP_EXECUTABLE = app.getPath("exe");
  process.env.SKILL_CONTROL_APP_PATH = app.getAppPath();
  process.env.SKILL_CONTROL_APP_PACKAGED = app.isPackaged ? "1" : "0";
  process.env.SKILL_CONTROL_BUNDLE_ID = "dev.skillcontrol.desktop";
  if (process.env.APPIMAGE) process.env.SKILL_CONTROL_APPIMAGE = process.env.APPIMAGE;

  const { startServer } = await import("../server/local-server.mjs");
  const preferredPort =
    probe.kind === "available" ? DEFAULT_MANAGER_PORT : 0;
  managerServer = startServer({
    host: MANAGER_HOST,
    port: preferredPort,
    fetchImpl: serverFetch,
  });
  try {
    await waitForServer(managerServer);
  } catch (error) {
    if (preferredPort !== DEFAULT_MANAGER_PORT || error?.code !== "EADDRINUSE") {
      throw error;
    }
    managerServer = startServer({ host: MANAGER_HOST, port: 0, fetchImpl: serverFetch });
    await waitForServer(managerServer);
  }
  const address = managerServer.address();
  if (!address || typeof address !== "object") {
    throw new Error("无法确认本地 Skills 服务端口。");
  }
  managerPort = address.port;
  process.env.SKILL_MANAGER_PORT = String(managerPort);
  if (managerPort !== DEFAULT_MANAGER_PORT) {
    console.info(
      `[desktop] 默认端口已占用，已自动改用本机端口 ${managerPort}。`,
    );
  }
}

async function startProductionWebService() {
  console.info("[desktop] 正在启动本地界面服务…");
  const { startProdServer } = await import(
    "./runtime/vinext-prod-server.mjs"
  );
  const outDir = app.isPackaged
    ? path.join(app.getAppPath(), "dist")
    : path.join(PROJECT_DIRECTORY, "dist");
  const started = await startProdServer({
    host: MANAGER_HOST,
    port: PRODUCTION_WEB_PORT,
    outDir,
  });
  webServer = started.server;
  console.info(`[desktop] 本地界面服务已就绪：${MANAGER_HOST}:${started.port}`);
  return new URL(`http://${MANAGER_HOST}:${started.port}`);
}

async function waitForPage(url, attempts = 80) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, {}, 1_000);
      if (response.ok) return;
      lastError = new Error(`界面服务返回 HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(
    `本地界面未能就绪：${lastError?.message || "连接超时"}`,
  );
}

function isTrustedApplicationUrl(rawUrl) {
  if (!applicationOrigin) return false;
  try {
    const url = new URL(rawUrl);
    return url.origin === applicationOrigin;
  } catch {
    return false;
  }
}

function installSessionSecurity(developmentMode) {
  const appSession = session.defaultSession;
  appSession.setPermissionCheckHandler(() => false);
  appSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  appSession.setDevicePermissionHandler(() => false);

  if (!developmentMode) {
    const contentSecurityPolicy = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self' ${getManagerUrl()}`,
      `img-src 'self' data: blob: ${getManagerUrl()}`,
      "font-src 'self' data:",
      "media-src 'self' data:",
      "object-src 'none'",
      "frame-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
    appSession.webRequest.onHeadersReceived(
      { urls: [`${applicationOrigin}/*`] },
      (details, callback) => {
        const headers = { ...details.responseHeaders };
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === "content-security-policy") {
            delete headers[key];
          }
        }
        headers["Content-Security-Policy"] = [contentSecurityPolicy];
        callback({ responseHeaders: headers });
      },
    );
  }
}

/**
 * HTTPS_PROXY / HTTP_PROXY / ALL_PROXY / NO_PROXY, when set, override the system proxy for the
 * app's network checks (desktop/network-proxy.mjs); otherwise the system settings apply.
 */
async function applyProxyFromEnvironment() {
  const config = proxyConfigFromEnv(process.env);
  if (!config) return;
  const { hasCredentials, ...proxy } = config;
  try {
    await session.defaultSession.setProxy(proxy);
    console.info(`[desktop] 联网检查使用环境变量中的代理：${proxy.proxyRules}`);
    if (hasCredentials) console.warn("[desktop] 代理地址里的用户名和密码不会被使用。");
  } catch (error) {
    console.warn(`[desktop] 无法使用环境变量中的代理：${error?.message || error}`);
  }
}

/**
 * config `network` ({ updateChecks, noticeSeenAt, envOffline }) from the local service, for the
 * automatic app update check; null when it cannot be read (the updater then decides safely).
 */
async function readNetworkSettings() {
  if (!applicationOrigin) return null;
  const response = await fetchWithTimeout(`${getManagerUrl()}/api/config`, { headers: { Origin: applicationOrigin } }, 3_000);
  if (!response.ok) return null;
  const config = await response.json().catch(() => null);
  return config && typeof config.network === "object" ? config.network : null;
}

function getAppUpdater() {
  appUpdater ||= createAppUpdater({
    currentVersion: app.getVersion(),
    packaged: app.isPackaged,
    env: process.env,
    // Chromium's network stack, so system proxy settings apply.
    fetchImpl: (url, init) => net.fetch(url, init),
    stateFile: path.join(app.getPath("userData"), "app-update.json"),
    executablePath: app.getPath("exe"),
    resourcesPath: process.resourcesPath,
    openExternal: (url) => shell.openExternal(url),
    trashItem: (target) => shell.trashItem(target),
    readNetworkSettings,
    quit: () => app.quit(),
    emit: (state) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(APP_UPDATE_STATE_CHANNEL, state);
      }
    },
  });
  return appUpdater;
}

/** Argument-less privileged calls (app updates, the folder dialog) only come from our own window's top frame. */
function ownWindowRequestAllowed(event, args) {
  return (
    args.length === 0 &&
    isOwnTopFrame(event, mainWindow) &&
    isTrustedApplicationUrl(event.senderFrame?.url ?? "")
  );
}

function installAppUpdateHandlers() {
  const actions = {
    "desktop:app-update-status": (updater) => updater.status(),
    "desktop:app-update-check": (updater) => updater.check(),
    "desktop:app-update-download": (updater) => updater.download(),
    "desktop:app-update-install": (updater) => updater.install(),
    "desktop:app-update-open-app-management": (updater) => updater.openAppManagement(),
    "desktop:app-update-open-download-page": (updater) => updater.openDownloadPage(),
  };
  for (const [channel, run] of Object.entries(actions)) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!ownWindowRequestAllowed(event, args)) {
        return {
          status: "error",
          current: app.getVersion(),
          canInstall: false,
          error: "只接受来自应用窗口的更新请求。",
        };
      }
      const updater = getAppUpdater();
      try {
        return await run(updater);
      } catch (error) {
        console.error("[app-update]", error);
        return {
          ...(await updater.status()),
          status: "error",
          error: "应用更新出错了，请稍后再试。",
        };
      }
    });
  }
}

function installIpcHandlers() {
  installAppUpdateHandlers();

  ipcMain.handle("desktop:get-runtime-info", () => ({
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    version: app.getVersion(),
    apiBase: getManagerUrl(),
  }));

  ipcMain.handle("desktop:open-external", async (_event, rawUrl) => {
    if (typeof rawUrl !== "string") return false;
    const url = new URL(rawUrl);
    if (url.protocol !== "https:") return false;
    await shell.openExternal(url.toString());
    return true;
  });

  // Packaged apps deny navigator.clipboard (the permission check handler returns false),
  // so copying goes through the main process: plain text only, at most 1 MB, and only
  // from the top frame of our own window.
  ipcMain.handle("desktop:copy-text", (event, text) => {
    if (!copyTextAllowed(event, mainWindow, text)) return false;
    clipboard.writeText(text);
    return true;
  });

  // 导入技能 → 选择文件夹. Only the path the user picked goes back to the page.
  ipcMain.handle("desktop:pick-folder", async (event, ...args) => {
    if (!ownWindowRequestAllowed(event, args)) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "选择技能文件夹",
      buttonLabel: "导入",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
}

/** 设置… (⌘,): shows the window and asks the renderer to open 设置 (preload onNavigate). */
function openSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send(NAVIGATE_CHANNEL, { page: "settings" });
}

function createApplicationMenu(developmentMode) {
  const template = buildMenuTemplate({
    platform: process.platform,
    appName: app.name,
    developmentMode,
    openSettings,
    openExternal: (url) => void shell.openExternal(url),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function installSmokeTest(window) {
  if (process.env.SKILL_CONTROL_SMOKE_TEST !== "1") return;
  let finished = false;
  const finish = (exitCode, result) => {
    if (finished) return;
    finished = true;
    console.log(`[desktop-smoke] ${JSON.stringify(result)}`);
    closeOwnedServers();
    setTimeout(() => app.exit(exitCode), 50);
  };
  const timeout = setTimeout(() => {
    finish(1, { ok: false, error: "桌面生产冒烟测试超时。" });
  }, 20_000);

  // The window shows desktop/startup.html first: only the application page counts.
  window.webContents.on("did-fail-load", (_event, code, description, validatedUrl, isMainFrame) => {
    if (isMainFrame === false || !isTrustedApplicationUrl(validatedUrl)) return;
    clearTimeout(timeout);
    finish(1, {
      ok: false,
      error: `界面载入失败 (${code})：${description}`,
    });
  });
  const onApplicationLoaded = async () => {
    if (!isTrustedApplicationUrl(window.webContents.getURL())) return;
    window.webContents.off("did-finish-load", onApplicationLoaded);
    try {
      const expectedApiBase = JSON.stringify(getManagerUrl());
      const imageProbeConfig = JSON.stringify({
        instanceId: process.env.SKILL_CONTROL_SMOKE_IMAGE_INSTANCE || "",
        path: process.env.SKILL_CONTROL_SMOKE_IMAGE_PATH || "",
      });
      const result = await window.webContents.executeJavaScript(`
        (async () => {
          const expectedApiBase = ${expectedApiBase};
          const imageProbeConfig = ${imageProbeConfig};
          const probeImage = async () => {
            if (!imageProbeConfig.instanceId || !imageProbeConfig.path) {
              return { ok: true, skipped: true };
            }
            const assetUrl =
              expectedApiBase +
              "/api/skill-asset?instanceId=" +
              encodeURIComponent(imageProbeConfig.instanceId) +
              "&path=" +
              encodeURIComponent(imageProbeConfig.path);
            const response = await fetch(assetUrl);
            if (!response.ok) {
              return { ok: false, error: "HTTP " + response.status };
            }
            const objectUrl = URL.createObjectURL(await response.blob());
            try {
              const dimensions = await new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = () =>
                  resolve({
                    width: image.naturalWidth,
                    height: image.naturalHeight,
                  });
                image.onerror = () => reject(new Error("Chromium 图片解码失败"));
                image.src = objectUrl;
              });
              return {
                ok: dimensions.width > 0 && dimensions.height > 0,
                ...dimensions,
              };
            } finally {
              URL.revokeObjectURL(objectUrl);
            }
          };
          const [healthResponse, pageResponse, runtimeInfo, imageProbe] =
            await Promise.all([
            fetch(expectedApiBase + "/api/health"),
            fetch(window.location.href),
            window.skillManagerDesktop.getRuntimeInfo(),
            probeImage(),
          ]);
          const health = await healthResponse.json();
          const appUpdateApi = window.skillManagerDesktop.appUpdate;
          const appUpdateState = await appUpdateApi.status();
          const unsubscribe = appUpdateApi.onProgress(() => {});
          const appUpdateWired =
            typeof appUpdateApi.check === "function" &&
            typeof appUpdateApi.download === "function" &&
            typeof appUpdateApi.install === "function" &&
            typeof unsubscribe === "function" &&
            appUpdateState.current === runtimeInfo.version &&
            typeof appUpdateState.status === "string";
          unsubscribe();
          const csp = pageResponse.headers.get("content-security-policy") || "";
          const checks = {
            title: document.title.includes("技能管理器"),
            shell: Boolean(document.querySelector(".app-shell")),
            service:
              healthResponse.ok &&
              health.ok === true &&
              health.service === "Skill Control local service",
            preload:
              runtimeInfo.packaged === true &&
              typeof runtimeInfo.version === "string" &&
              runtimeInfo.apiBase === expectedApiBase &&
              window.skillManagerDesktop.apiBase === expectedApiBase,
            csp:
              csp.includes("connect-src 'self' " + expectedApiBase) &&
              csp.includes("img-src 'self' data: blob:") &&
              csp.includes("object-src 'none'") &&
              csp.includes("frame-src 'none'"),
            image: imageProbe.ok === true,
            appUpdate: appUpdateWired,
          };
          return {
            ok: Object.values(checks).every(Boolean),
            checks,
            runtimeInfo,
            csp,
            imageProbe,
            appUpdateState,
          };
        })()
      `);
      clearTimeout(timeout);
      finish(result.ok ? 0 : 1, { ...result, startupPage: startupPageShown.has(window.id) });
    } catch (error) {
      clearTimeout(timeout);
      finish(1, {
        ok: false,
        error: error?.message || String(error),
      });
    }
  };
  window.webContents.on("did-finish-load", onApplicationLoaded);
}

// Which windows showed desktop/startup.html (reported by the smoke test).
const startupPageShown = new Set();
// The service address each window's preload received (fixed when the window is created).
const windowApiBase = new WeakMap();

/**
 * A window that shows desktop/startup.html ("正在启动本地服务…") right away; the app page is
 * loaded into it once the services are ready (loadApplication).
 */
function createWindow(developmentMode, bounds = null) {
  const apiBase = getManagerUrl();
  const window = new BrowserWindow({
    title: "Skill Control",
    width: 1440,
    height: 960,
    ...(bounds || {}),
    minWidth: 1060,
    minHeight: 700,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#18191b" : "#fbfbf9",
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: path.join(DESKTOP_DIRECTORY, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
      devTools: developmentMode,
      additionalArguments: [`--skill-control-api-base=${apiBase}`],
    },
  });

  window.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (targetUrl.startsWith("https://")) {
      void shell.openExternal(targetUrl);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isTrustedApplicationUrl(targetUrl)) {
      event.preventDefault();
      if (targetUrl.startsWith("https://")) void shell.openExternal(targetUrl);
    }
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.once("did-finish-load", () => {
    if (window.webContents.getURL().startsWith("file:")) startupPageShown.add(window.id);
  });

  windowApiBase.set(window, apiBase);
  void window.loadFile(STARTUP_PAGE);
  return window;
}

function loadApplication(window, url) {
  installSmokeTest(window);
  void window.loadURL(url.toString());
}

/**
 * Loads the app into the startup window. The preload's service address is fixed per window,
 * so when the manager had to move off the default port the window is replaced, keeping its bounds.
 */
function openApplicationWindow(url, developmentMode) {
  let window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (window && windowApiBase.get(window) !== getManagerUrl()) {
    const previous = window;
    window = createWindow(developmentMode, previous.getBounds());
    mainWindow = window;
    previous.destroy();
  }
  mainWindow = window || createWindow(developmentMode);
  loadApplication(mainWindow, url);
}

function closeOwnedServers() {
  webServer?.close();
  managerServer?.close();
  webServer = null;
  managerServer = null;
}

async function bootstrap() {
  console.info("[desktop] 正在初始化 Skill Control…");
  const developmentUrl = normalizeLocalUrl(
    process.env.SKILL_MANAGER_DESKTOP_DEV_URL,
  );
  const developmentMode = Boolean(developmentUrl);
  createApplicationMenu(developmentMode);
  // Show a window at once ("正在启动本地服务…"), then load the app when the services are ready.
  mainWindow = createWindow(developmentMode);
  const applicationUrl = developmentUrl || (await startProductionWebService());
  applicationOrigin = applicationUrl.origin;

  console.info("[desktop] 正在连接本地 Skills 服务…");
  await startManagerService(applicationOrigin);
  console.info("[desktop] 本地 Skills 服务已就绪。");
  await waitForPage(applicationUrl);

  installSessionSecurity(developmentMode);
  openApplicationWindow(applicationUrl, developmentMode);
  if (process.env.SKILL_CONTROL_SMOKE_TEST !== "1") {
    void getAppUpdater()
      .start()
      .catch((error) => console.error("[app-update]", error));
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  installIpcHandlers();
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("before-quit", () => {
    quitting = true;
    appUpdater?.stop();
    closeOwnedServers();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (!quitting && !mainWindow && applicationOrigin) {
      mainWindow = createWindow(Boolean(process.env.SKILL_MANAGER_DESKTOP_DEV_URL));
      loadApplication(mainWindow, new URL(applicationOrigin));
    }
  });
  app.on("certificate-error", (event, _webContents, _url, _error, _certificate, callback) => {
    event.preventDefault();
    callback(false);
  });

  console.info("[desktop] 正在等待 Electron 就绪…");
  void app
    .whenReady()
    .then(async () => {
      console.info("[desktop] Electron 已就绪。");
      await applyProxyFromEnvironment();
      await bootstrap();
    })
    .catch((error) => {
      closeOwnedServers();
      const message =
        error instanceof Error ? error.message : "桌面应用启动失败。";
      console.error(error);
      dialog.showErrorBox(
        "Skill Control 无法启动",
        `${message}\n\n请重新启动应用后重试；如果问题持续，请在项目 Issue 中附上这段提示。`,
      );
      app.quit();
    });
}
