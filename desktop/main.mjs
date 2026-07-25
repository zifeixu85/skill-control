import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
} from "electron";

const DESKTOP_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = path.resolve(DESKTOP_DIRECTORY, "..");
const MANAGER_HOST = "127.0.0.1";
const DEFAULT_MANAGER_PORT = 43110;
const MANAGER_SERVICE_NAME = "Skill Control local service";
const PRODUCTION_WEB_PORT = readPort(
  process.env.SKILL_MANAGER_DESKTOP_WEB_PORT,
  0,
);

let mainWindow = null;
let managerServer = null;
let webServer = null;
let applicationOrigin = null;
let managerPort = DEFAULT_MANAGER_PORT;
let quitting = false;

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

  const { startServer } = await import("../server/local-server.mjs");
  const preferredPort =
    probe.kind === "available" ? DEFAULT_MANAGER_PORT : 0;
  managerServer = startServer({
    host: MANAGER_HOST,
    port: preferredPort,
  });
  try {
    await waitForServer(managerServer);
  } catch (error) {
    if (preferredPort !== DEFAULT_MANAGER_PORT || error?.code !== "EADDRINUSE") {
      throw error;
    }
    managerServer = startServer({ host: MANAGER_HOST, port: 0 });
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
      "img-src 'self' data:",
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

function installIpcHandlers() {
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
}

function createApplicationMenu(developmentMode) {
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about", label: `关于 ${app.name}` },
              { type: "separator" },
              { role: "hide", label: "隐藏" },
              { role: "hideOthers", label: "隐藏其他应用" },
              { role: "unhide", label: "全部显示" },
              { type: "separator" },
              { role: "quit", label: `退出 ${app.name}` },
            ],
          },
        ]
      : []),
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "显示",
      submenu: [
        { role: "reload", label: "重新载入" },
        { role: "togglefullscreen", label: "切换全屏" },
        ...(developmentMode
          ? [
              { type: "separator" },
              { role: "toggleDevTools", label: "开发者工具" },
            ]
          : []),
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(process.platform === "darwin"
          ? [{ type: "separator" }, { role: "front", label: "前置全部窗口" }]
          : [{ role: "close", label: "关闭" }]),
      ],
    },
  ];
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

  window.webContents.once("did-fail-load", (_event, code, description) => {
    clearTimeout(timeout);
    finish(1, {
      ok: false,
      error: `界面载入失败 (${code})：${description}`,
    });
  });
  window.webContents.once("did-finish-load", async () => {
    try {
      const expectedApiBase = JSON.stringify(getManagerUrl());
      const result = await window.webContents.executeJavaScript(`
        (async () => {
          const expectedApiBase = ${expectedApiBase};
          const [healthResponse, pageResponse, runtimeInfo] = await Promise.all([
            fetch(expectedApiBase + "/api/health"),
            fetch(window.location.href),
            window.skillManagerDesktop.getRuntimeInfo(),
          ]);
          const health = await healthResponse.json();
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
              csp.includes("img-src 'self' data:") &&
              csp.includes("object-src 'none'") &&
              csp.includes("frame-src 'none'"),
          };
          return {
            ok: Object.values(checks).every(Boolean),
            checks,
            runtimeInfo,
            csp,
          };
        })()
      `);
      clearTimeout(timeout);
      finish(result.ok ? 0 : 1, result);
    } catch (error) {
      clearTimeout(timeout);
      finish(1, {
        ok: false,
        error: error?.message || String(error),
      });
    }
  });
}

function createWindow(url, developmentMode) {
  const window = new BrowserWindow({
    title: "Skill Control",
    width: 1440,
    height: 960,
    minWidth: 1060,
    minHeight: 700,
    show: false,
    backgroundColor: "#f3f1e8",
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
      additionalArguments: [
        `--skill-control-api-base=${getManagerUrl()}`,
      ],
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

  installSmokeTest(window);
  void window.loadURL(url.toString());
  return window;
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
  const applicationUrl = developmentUrl || (await startProductionWebService());
  applicationOrigin = applicationUrl.origin;

  console.info("[desktop] 正在连接本地 Skills 服务…");
  await startManagerService(applicationOrigin);
  console.info("[desktop] 本地 Skills 服务已就绪。");
  await waitForPage(applicationUrl);

  const developmentMode = Boolean(developmentUrl);
  installSessionSecurity(developmentMode);
  createApplicationMenu(developmentMode);
  mainWindow = createWindow(applicationUrl, developmentMode);
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
    closeOwnedServers();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (!quitting && !mainWindow && applicationOrigin) {
      mainWindow = createWindow(
        new URL(applicationOrigin),
        Boolean(process.env.SKILL_MANAGER_DESKTOP_DEV_URL),
      );
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
