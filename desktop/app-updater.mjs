import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BUNDLE_ID,
  CHECK_INTERVAL_MS,
  isAllowedAssetUrl,
  isAllowedDownloadUrl,
  isNewerVersion,
  LATEST_RELEASE_API,
  MAC_MANIFEST_NAME,
  MANUAL_TEXT,
  MAX_MANIFEST_BYTES,
  MAX_RELEASE_JSON_BYTES,
  messageOf,
  normalizeVersion,
  parseMacManifest,
  parseReleaseResponse,
  pickMacZip,
  RELEASES_URL,
  releasePageUrl,
  sanitizeNotes,
  shouldCheck,
  UNSIGNED_NOTICE,
  updateSupport,
  UpdateError,
} from "./app-update-core.mjs";
import * as macOps from "./app-update-mac.mjs";

export * from "./app-update-core.mjs";
export * from "./app-update-mac.mjs";

/**
 * Skill Control's own updates from GitHub Releases, run in the main process; the window only
 * sees the state through IPC (desktop/preload.cjs → skillManagerDesktop.appUpdate).
 *
 * State: { status: "up-to-date"|"available"|"downloading"|"ready"|"error"|"unsupported",
 *   current, latest?, notes?, url?, publishedAt?, checkedAt?, error?, canInstall,
 *   reason?, manual?, notice?, transferred?, total?, percent?, installing? }
 *
 * macOS uses the custom updater in app-update-mac.mjs; Windows (NSIS) and Linux (AppImage)
 * use electron-updater, loaded only on those platforms. Offline mode
 * (SKILL_MANAGER_UPDATES_OFFLINE=1) and source runs never touch the network.
 */

export const TICK_MS = 60 * 60 * 1000;
export const STARTUP_DELAY_MS = 15_000;
export const RECENT_CHECK_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 15_000;
const PROGRESS_INTERVAL_MS = 200;
const STATE_SCHEMA = 1;

async function readCapped(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new UpdateError("manifest", "GitHub 返回的数据过大。");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The latest published (non-draft, non-pre-release) release; null when there is none. */
export async function fetchLatestRelease({ fetchImpl, userAgent, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const response = await fetchImpl(LATEST_RELEASE_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": userAgent,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) return null;
  if (response.status === 403 || response.status === 429) {
    throw new UpdateError("rate-limit", "GitHub 暂时限制了请求次数，请过一会儿再试。");
  }
  if (!response.ok) throw new UpdateError("network", `检查更新失败（GitHub 返回 HTTP ${response.status}）。`);
  const text = await readCapped(response, MAX_RELEASE_JSON_BYTES);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UpdateError("manifest", "GitHub 返回的发布信息无法解析。");
  }
  return parseReleaseResponse(json);
}

/** latest-mac.yml from the release assets (github.com, then GitHub's download hosts). */
export async function fetchManifestText({ fetchImpl, url, userAgent, timeoutMs = REQUEST_TIMEOUT_MS }) {
  if (!isAllowedAssetUrl(url)) throw new UpdateError("manifest", "更新清单的地址不在本项目的发布里。");
  const response = await fetchImpl(url, {
    headers: { Accept: "application/octet-stream", "User-Agent": userAgent },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new UpdateError("network", `没能下载更新清单（HTTP ${response.status}）。`);
  if (response.url && !isAllowedDownloadUrl(response.url)) {
    throw new UpdateError("network", "更新清单被重定向到了未知的主机，已停止。");
  }
  return readCapped(response, MAX_MANIFEST_BYTES);
}

/** NSIS on Windows, AppImage on Linux; built explicitly so a .deb never gets DebUpdater. */
export async function loadDefaultElectronUpdater(platform) {
  const loaded = await import("electron-updater");
  const api = loaded.default ?? loaded;
  if (platform === "win32") return new api.NsisUpdater();
  if (platform === "linux") return new api.AppImageUpdater();
  throw new UpdateError("platform", "这个平台不使用 electron-updater。");
}

const INSTALLABLE = Object.freeze({ canInstall: true, reason: null, manual: null });

function blocked(reason, manual = MANUAL_TEXT[reason] || null) {
  return { canInstall: false, reason, manual };
}

export function createAppUpdater({
  currentVersion,
  platform = process.platform,
  arch = process.arch,
  packaged = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
  stateFile = null,
  tempRoot = os.tmpdir(),
  executablePath = process.execPath,
  resourcesPath = process.resourcesPath,
  pid = process.pid,
  now = () => Date.now(),
  openExternal = async () => {},
  trashItem = null,
  quit = () => {},
  emit = () => {},
  loadElectronUpdater = loadDefaultElectronUpdater,
  mac = macOps,
  fileExists = existsSync,
  logger = console,
  intervalMs = CHECK_INTERVAL_MS,
  tickMs = TICK_MS,
  startupDelayMs = STARTUP_DELAY_MS,
  recentMs = RECENT_CHECK_MS,
  timeoutMs = REQUEST_TIMEOUT_MS,
  timers = globalThis,
}) {
  const current = normalizeVersion(currentVersion) || String(currentVersion || "0.0.0");
  const support = updateSupport({ platform, arch, packaged, env });
  const userAgent = `Skill-Control/${current} (${platform}; ${arch})`;
  const bundlePath = support.backend === "mac" ? mac.bundlePathFromExecutable(executablePath) : null;

  let status = support.check ? "up-to-date" : "unsupported";
  let release = null;
  let checkedAt = null;
  let lastFinishedAt = 0;
  let error = null;
  let progress = null;
  let installNotice = null;
  let installability = support.install ? INSTALLABLE : blocked(support.reason);
  let pending = null;
  let checking = null;
  let downloading = null;
  let installing = false;
  let electronUpdater = null;
  let startTimer = null;
  let tickTimer = null;
  let lastProgressAt = 0;
  const warn = (message, failure) => logger?.warn?.(`[app-update] ${message}${failure ? `：${failure?.message || failure}` : ""}`);

  function snapshot() {
    const state = { status, current, canInstall: support.check && installability.canInstall };
    if (release) {
      state.latest = release.version;
      if (release.notes) state.notes = release.notes;
      state.url = release.url;
      if (release.publishedAt) state.publishedAt = release.publishedAt;
    } else {
      state.url = RELEASES_URL;
    }
    if (checkedAt) state.checkedAt = checkedAt;
    if (error) state.error = error;
    const reason = support.check ? installability.reason : support.reason;
    if (reason) {
      state.reason = reason;
      const manual = support.check ? installability.manual : MANUAL_TEXT[reason];
      if (manual) state.manual = manual;
    }
    const notice = installNotice || (support.backend === "electron-updater" ? UNSIGNED_NOTICE[platform] : null);
    if (notice) state.notice = notice;
    if (progress && (status === "downloading" || status === "ready")) {
      state.transferred = progress.transferred;
      state.total = progress.total;
      state.percent = progress.total ? Math.min(100, Math.round((progress.transferred / progress.total) * 1000) / 10) : 0;
    }
    if (installing) state.installing = true;
    return state;
  }

  function publish() {
    const state = snapshot();
    try {
      emit(state);
    } catch (failure) {
      warn("无法通知窗口", failure);
    }
    return state;
  }

  function reportProgress(transferred, total) {
    progress = { transferred, total };
    const at = now();
    if (at - lastProgressAt >= PROGRESS_INTERVAL_MS || (total && transferred >= total)) {
      lastProgressAt = at;
      publish();
    }
  }

  async function load() {
    if (!stateFile || !support.check) return;
    try {
      const text = await readFile(stateFile, "utf8");
      if (text.length > MAX_RELEASE_JSON_BYTES) return;
      const saved = JSON.parse(text);
      if (saved?.schema !== STATE_SCHEMA) return;
      if (typeof saved.checkedAt === "string" && Number.isFinite(Date.parse(saved.checkedAt))) checkedAt = saved.checkedAt;
      const cached = saved.release;
      const version = normalizeVersion(cached?.version);
      if (version && isNewerVersion(version, current)) {
        const published = Date.parse(cached.publishedAt);
        release = {
          version,
          tag: typeof cached.tag === "string" ? cached.tag : `v${version}`,
          url: releasePageUrl(cached.url),
          notes: sanitizeNotes(cached.notes),
          publishedAt: Number.isFinite(published) ? new Date(published).toISOString() : null,
          assets: null,
        };
        status = "available";
      }
    } catch {
      // First run or an unreadable file: start without a cached check.
    }
  }

  async function persist() {
    if (!stateFile) return;
    const data = {
      schema: STATE_SCHEMA,
      checkedAt,
      release: release
        ? { version: release.version, tag: release.tag, url: release.url, notes: release.notes, publishedAt: release.publishedAt }
        : null,
    };
    try {
      await mkdir(path.dirname(stateFile), { recursive: true });
      const temporary = `${stateFile}.tmp-${pid}-${now()}`;
      await writeFile(temporary, `${JSON.stringify(data)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, stateFile);
    } catch (failure) {
      warn("无法保存检查结果", failure);
    }
  }

  async function refreshInstallability() {
    if (!support.install) return;
    if (support.backend === "mac") {
      const where = await mac.checkReplaceable(bundlePath);
      installability = where.ok ? INSTALLABLE : blocked("location", where.manual);
    } else if (support.backend === "electron-updater") {
      const configured = Boolean(resourcesPath) && fileExists(path.join(resourcesPath, "app-update.yml"));
      installability = configured ? INSTALLABLE : blocked("package");
    }
  }

  async function discardPending() {
    if (!pending) return;
    const { dir } = pending;
    pending = null;
    await mac.removeTempDir(dir, tempRoot).catch((failure) => warn("无法清理下载目录", failure));
  }

  async function openReleasePage() {
    try {
      await openExternal(release?.url || RELEASES_URL);
    } catch (failure) {
      warn("无法打开下载页", failure);
    }
  }

  // ---------------------------------------------------------------------------
  // Check

  async function runCheck(background) {
    try {
      const latest = await fetchLatestRelease({ fetchImpl, userAgent, timeoutMs });
      const newer = latest && isNewerVersion(latest.version, current) ? latest : null;
      if (!newer) {
        await discardPending();
        release = null;
        if (status !== "downloading") status = "up-to-date";
      } else {
        const keep = (status === "ready" || status === "downloading") && release?.version === newer.version;
        if (!keep) {
          await discardPending();
          status = "available";
        }
        release = newer;
      }
      error = null;
      checkedAt = new Date(now()).toISOString();
      await refreshInstallability();
      await persist();
    } catch (failure) {
      warn("检查失败", failure);
      error = messageOf(failure);
      if (!background) status = "error";
    } finally {
      lastFinishedAt = now();
    }
    return publish();
  }

  function refresh(background) {
    checking ||= runCheck(background).finally(() => {
      checking = null;
    });
    return checking;
  }

  const loaded = load();

  /** On-demand check; a successful check from the last minute is reused. Never rejects. */
  async function check({ background = false } = {}) {
    await loaded;
    if (!support.check) return snapshot();
    if (checking) return checking;
    if (!background && !error && lastFinishedAt && now() - lastFinishedAt < recentMs) return snapshot();
    return refresh(background);
  }

  // ---------------------------------------------------------------------------
  // Download

  async function downloadMac(target) {
    const manifestAsset = target.assets.get(MAC_MANIFEST_NAME);
    if (!manifestAsset) {
      throw new UpdateError("manifest", "这个版本没有提供 macOS 更新清单（latest-mac.yml），请从下载页手动更新。");
    }
    const manifest = parseMacManifest(await fetchManifestText({ fetchImpl, url: manifestAsset.url, userAgent, timeoutMs }));
    if (manifest.version !== target.version) throw new UpdateError("manifest", "更新清单的版本和发布不一致，已停止。");
    const file = pickMacZip(manifest, arch);
    const asset = target.assets.get(file.url);
    if (!asset) throw new UpdateError("manifest", "发布里缺少本机架构的更新包。");
    await mkdir(tempRoot, { recursive: true });
    const dir = await mkdtemp(path.join(tempRoot, mac.TEMP_DIR_PREFIX));
    try {
      const zipPath = path.join(dir, file.url);
      reportProgress(0, file.size);
      const result = await mac.downloadToFile({
        fetchImpl,
        url: asset.url,
        destination: zipPath,
        expectedSize: file.size,
        headers: { "User-Agent": userAgent },
        onProgress: reportProgress,
      });
      if (!mac.sha512Matches(result.sha512, file.sha512)) {
        throw new UpdateError("checksum", "下载的文件没有通过 sha512 校验，已丢弃。");
      }
      const extractDir = path.join(dir, "extracted");
      await mkdir(extractDir);
      await mac.extractZip(zipPath, extractDir);
      await rm(zipPath, { force: true });
      const appPath = await mac.findExtractedApp(extractDir);
      await mac.validateBundle(appPath, { bundleId: BUNDLE_ID, version: target.version });
      return { dir, appPath, version: target.version };
    } catch (failure) {
      await mac.removeTempDir(dir, tempRoot).catch(() => {});
      throw failure;
    }
  }

  async function getElectronUpdater() {
    if (electronUpdater) return electronUpdater;
    const updater = await loadElectronUpdater(platform);
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowDowngrade = false;
    updater.allowPrerelease = false;
    updater.fullChangelog = false;
    updater.logger = {
      info() {},
      debug() {},
      warn: (message) => warn(String(message)),
      error: (message) => warn(String(message)),
    };
    updater.on?.("download-progress", (info) => reportProgress(Number(info?.transferred) || 0, Number(info?.total) || 0));
    // Errors also reject the awaited calls; the listener keeps them from being unhandled.
    updater.on?.("error", () => {});
    electronUpdater = updater;
    return updater;
  }

  async function downloadWithElectronUpdater(target) {
    const updater = await getElectronUpdater();
    const result = await updater.checkForUpdates();
    const version = normalizeVersion(result?.updateInfo?.version);
    if (!version || !isNewerVersion(version, current)) {
      throw new UpdateError("manifest", "更新源里没有找到新版本的安装包。");
    }
    if (version !== target.version) throw new UpdateError("manifest", "更新源的版本和发布页不一致，请稍后再试。");
    await updater.downloadUpdate();
  }

  async function runDownload() {
    if (!release?.assets) await refresh(false);
    if (!release?.assets) return snapshot();
    await refreshInstallability();
    if (!installability.canInstall) {
      await openReleasePage();
      return snapshot();
    }
    status = "downloading";
    error = null;
    progress = { transferred: 0, total: 0 };
    publish();
    try {
      if (support.backend === "mac") pending = await downloadMac(release);
      else await downloadWithElectronUpdater(release);
      status = "ready";
      const total = progress?.total || progress?.transferred || 0;
      progress = { transferred: total, total };
    } catch (failure) {
      warn("下载失败", failure);
      status = "error";
      error = messageOf(failure);
      progress = null;
    }
    return publish();
  }

  /** Downloads and checks the update; resolves with "ready" or "error". Never rejects. */
  async function download() {
    await loaded;
    if (!support.check) return snapshot();
    if (status === "ready" || installing) return snapshot();
    if (downloading) return downloading;
    downloading = runDownload().finally(() => {
      downloading = null;
    });
    return downloading;
  }

  // ---------------------------------------------------------------------------
  // Install

  async function installMac() {
    if (!pending || !bundlePath) throw new UpdateError("swap", "找不到下载好的新版本，请重新下载。");
    const expected = { bundleId: BUNDLE_ID, version: pending.version };
    await mac.validateBundle(pending.appPath, expected);
    const result = await mac.swapBundle({
      currentPath: bundlePath,
      newPath: pending.appPath,
      currentVersion: current,
      date: new Date(now()),
      trashItem,
      validate: (target) => mac.validateBundle(target, expected),
    });
    await discardPending();
    installNotice = result.trashed
      ? null
      : `旧版本没能移到废纸篓，留在“${path.basename(result.backupPath)}”，确认新版本正常后可以手动删除。`;
    mac.spawnRelaunchHelper({ pid, appPath: bundlePath });
    timers.setTimeout(() => quit(), 300);
  }

  async function installWithElectronUpdater() {
    const updater = await getElectronUpdater();
    timers.setTimeout(() => {
      try {
        updater.quitAndInstall(false, true);
      } catch (failure) {
        installing = false;
        status = "error";
        error = messageOf(failure);
        publish();
      }
    }, 300);
  }

  /** Swaps in the downloaded update and relaunches; resolves with the state. Never rejects. */
  async function install() {
    await loaded;
    if (!support.check || installing) return snapshot();
    if (status !== "ready") {
      if (release && !installability.canInstall) {
        await openReleasePage();
        return snapshot();
      }
      return { ...snapshot(), error: release ? "请先下载更新。" : "没有可安装的新版本。" };
    }
    await refreshInstallability();
    if (!installability.canInstall) {
      await openReleasePage();
      return snapshot();
    }
    installing = true;
    try {
      if (support.backend === "mac") await installMac();
      else await installWithElectronUpdater();
      return publish();
    } catch (failure) {
      warn("安装失败", failure);
      installing = false;
      status = "error";
      error = messageOf(failure);
      await discardPending();
      return publish();
    }
  }

  // ---------------------------------------------------------------------------
  // Schedule

  /** Checks 15 s after start when the last check is older than 24 h, then re-evaluates hourly. */
  async function start() {
    await loaded;
    if (!support.check || tickTimer) return;
    await refreshInstallability();
    const tick = () => {
      if (!checking && !downloading && shouldCheck({ checkedAt, now: now(), intervalMs })) void check({ background: true });
    };
    startTimer = timers.setTimeout(tick, startupDelayMs);
    startTimer?.unref?.();
    tickTimer = timers.setInterval(tick, tickMs);
    tickTimer?.unref?.();
  }

  function stop() {
    if (startTimer) timers.clearTimeout(startTimer);
    if (tickTimer) timers.clearInterval(tickTimer);
    startTimer = null;
    tickTimer = null;
  }

  /** The current state, without touching the network. */
  async function readStatus() {
    await loaded;
    return snapshot();
  }

  return Object.freeze({ status: readStatus, check, download, install, start, stop, support });
}
