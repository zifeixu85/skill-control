import { execFile as execFileCallback, spawn as spawnProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, constants, lstat, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import {
  backupNameFor,
  isAllowedDownloadUrl,
  MANUAL_TEXT,
  MAX_DOWNLOAD_BYTES,
  readInfoPlistXml,
  UpdateError,
} from "./app-update-core.mjs";

/**
 * macOS install mechanics for the custom updater. Builds are ad-hoc signed, so Squirrel.Mac
 * cannot install them: we download the release zip, check its sha512, unpack it with ditto,
 * check the new bundle and swap it in place of the running one (rolling back on failure).
 */

const execFile = promisify(execFileCallback);
const DITTO = "/usr/bin/ditto";
const PLUTIL = "/usr/bin/plutil";
const TEMP_PREFIX = "skill-control-update-";
const STALL_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Download and checksum

/**
 * Streams `url` to `destination` (created exclusively, 0600) while hashing it.
 * Fails on HTTP errors, a redirect to an unknown host, a size mismatch or a stalled transfer.
 */
export async function downloadToFile({
  fetchImpl,
  url,
  destination,
  expectedSize,
  onProgress = () => {},
  headers = {},
  stallMs = STALL_TIMEOUT_MS,
  maxBytes = MAX_DOWNLOAD_BYTES,
}) {
  const controller = new AbortController();
  let stall = null;
  const armStall = () => {
    clearTimeout(stall);
    stall = setTimeout(() => controller.abort(new UpdateError("network", "下载停滞，已取消。")), stallMs);
  };
  armStall();
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "application/octet-stream", ...headers },
    });
    if (!response.ok) throw new UpdateError("network", `下载失败（HTTP ${response.status}）。`);
    if (response.url && !isAllowedDownloadUrl(response.url)) {
      throw new UpdateError("network", "下载地址被重定向到了未知的主机，已停止。");
    }
    if (!response.body) throw new UpdateError("network", "下载没有返回内容。");
    const limit = Math.min(maxBytes, expectedSize || maxBytes);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 0 && declared !== expectedSize && expectedSize) {
      throw new UpdateError("size", "下载的文件大小和更新清单不一致，已停止。");
    }
    const hash = createHash("sha512");
    let transferred = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        transferred += chunk.length;
        if (transferred > limit) {
          callback(new UpdateError("size", "下载的文件比更新清单写的大，已停止。"));
          return;
        }
        hash.update(chunk);
        armStall();
        onProgress(transferred, expectedSize || 0);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    if (expectedSize && transferred !== expectedSize) {
      throw new UpdateError("size", "下载的文件不完整，请重试。");
    }
    return { size: transferred, sha512: hash.digest("base64") };
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof UpdateError) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(stall);
  }
}

/** Base64 SHA-512 of a file, the encoding electron-builder writes into latest*.yml. */
export async function sha512File(filePath) {
  const hash = createHash("sha512");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("base64");
}

export const sha512Matches = (actual, expected) =>
  typeof actual === "string" && typeof expected === "string" && actual.length === 88 && actual === expected;

// ---------------------------------------------------------------------------
// Extract and check the bundle

export async function extractZip(zipPath, destination, { execFileImpl = execFile } = {}) {
  try {
    await execFileImpl(DITTO, ["-x", "-k", zipPath, destination], { timeout: 5 * 60_000, maxBuffer: 1024 * 1024 });
  } catch {
    throw new UpdateError("extract", "更新包解压失败。");
  }
}

/** The one .app at the top of an extracted zip (a symlinked .app does not count). */
export async function findExtractedApp(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const apps = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (apps.length !== 1) throw new UpdateError("bundle", "更新包里没有找到唯一的应用。");
  return path.join(directory, apps[0].name);
}

/** Info.plist keys of a bundle (XML; binary plists are converted with plutil on macOS). */
export async function readBundleInfo(appPath, { execFileImpl = execFile, platform = process.platform } = {}) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const info = await lstat(plistPath).catch(() => null);
  if (!info?.isFile() || info.size > 1_000_000) throw new UpdateError("bundle", "新版本缺少 Info.plist。");
  let text = await readFile(plistPath, "utf8");
  if (text.startsWith("bplist")) {
    if (platform !== "darwin") throw new UpdateError("bundle", "无法读取二进制 Info.plist。");
    ({ stdout: text } = await execFileImpl(PLUTIL, ["-convert", "xml1", "-o", "-", plistPath], { maxBuffer: 2_000_000 }));
  }
  return readInfoPlistXml(text);
}

/** The bundle is a real folder with our bundle id, the expected version and an executable. */
export async function validateBundle(appPath, { bundleId, version }, options = {}) {
  const root = await lstat(appPath).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) throw new UpdateError("bundle", "新版本不是有效的应用。");
  const info = await readBundleInfo(appPath, options);
  if (info.CFBundleIdentifier !== bundleId) throw new UpdateError("bundle", "新版本的应用标识不对，已停止。");
  if (info.CFBundleShortVersionString !== version) {
    throw new UpdateError("bundle", "新版本的版本号和发布不一致，已停止。");
  }
  const executable = info.CFBundleExecutable;
  if (typeof executable !== "string" || !executable || executable.includes("/") || executable.startsWith(".")) {
    throw new UpdateError("bundle", "新版本缺少可执行文件。");
  }
  const executablePath = path.join(appPath, "Contents", "MacOS", executable);
  const binary = await lstat(executablePath).catch(() => null);
  if (!binary?.isFile() || (binary.mode & 0o111) === 0) throw new UpdateError("bundle", "新版本缺少可执行文件。");
  return { bundleId, version, executablePath };
}

// ---------------------------------------------------------------------------
// Where the running app lives

/** ".../Skill Control.app/Contents/MacOS/Skill Control" → ".../Skill Control.app"; null otherwise. */
export function bundlePathFromExecutable(executablePath) {
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath)) return null;
  const macos = path.dirname(executablePath);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  if (path.basename(macos) !== "MacOS" || path.basename(contents) !== "Contents" || !bundle.endsWith(".app")) return null;
  return bundle;
}

/** Whether the bundle can be swapped in place: not translocated, folder and parent writable. */
export async function checkReplaceable(bundlePath, { accessImpl = access } = {}) {
  if (!bundlePath) return { ok: false, manual: MANUAL_TEXT.location };
  if (bundlePath.includes("/AppTranslocation/")) {
    return { ok: false, manual: "macOS 正在从隔离位置运行这个应用，请先在访达里把它拖进“应用程序”文件夹，再重新打开。" };
  }
  try {
    await accessImpl(path.dirname(bundlePath), constants.W_OK);
    await accessImpl(bundlePath, constants.W_OK);
    return { ok: true };
  } catch {
    return { ok: false, manual: MANUAL_TEXT.location };
  }
}

// ---------------------------------------------------------------------------
// Swap with rollback

const exists = (target) => lstat(target).then(() => true, () => false);

export const defaultSwapOps = Object.freeze({
  rename,
  copy: (source, destination) => execFile(DITTO, [source, destination], { timeout: 5 * 60_000 }),
  remove: (target) => rm(target, { recursive: true, force: true }),
  exists,
});

async function freePath(directory, name, ops) {
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  for (let index = 0; index < 100; index += 1) {
    const candidate = path.join(directory, index ? `${stem} ${index + 1}${extension}` : name);
    if (!(await ops.exists(candidate))) return candidate;
  }
  throw new UpdateError("swap", "找不到可用的备份名称。");
}

/** rename, or (across volumes) ditto to a hidden sibling and rename that. */
async function moveInto(source, destination, ops, stamp) {
  try {
    await ops.rename(source, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    const staging = path.join(path.dirname(destination), `.${path.basename(destination)}.update-${stamp}`);
    try {
      await ops.copy(source, staging);
      await ops.rename(staging, destination);
    } catch (copyError) {
      await ops.remove(staging).catch(() => {});
      throw copyError;
    }
  }
}

/**
 * Moves the running bundle aside under a timestamped name, moves the new bundle into its
 * place, re-validates it and then moves the old one to the Trash. Any failure before the
 * Trash step puts the old bundle back. A Trash failure keeps the old bundle (backupPath).
 */
export async function swapBundle({ currentPath, newPath, currentVersion, date = new Date(), trashItem, validate, ops = defaultSwapOps }) {
  const parent = path.dirname(currentPath);
  const stamp = date.getTime().toString(36);
  const backupPath = await freePath(parent, backupNameFor(path.basename(currentPath, ".app"), currentVersion, date), ops);
  try {
    await ops.rename(currentPath, backupPath);
  } catch {
    throw new UpdateError("swap", "没能移动当前版本，更新没有进行，原来的版本没有改动。");
  }
  try {
    await moveInto(newPath, currentPath, ops, stamp);
    if (validate) await validate(currentPath);
  } catch (error) {
    try {
      if (await ops.exists(currentPath)) {
        const failed = path.join(parent, `.${path.basename(currentPath)}.failed-${stamp}`);
        await ops.rename(currentPath, failed);
        await ops.remove(failed).catch(() => {});
      }
      await ops.rename(backupPath, currentPath);
    } catch {
      throw new UpdateError("swap", `更新失败，而且没能自动恢复。原来的版本在：${backupPath}`);
    }
    const detail = error instanceof UpdateError ? error.message : "无法放入新版本。";
    throw new UpdateError("swap", `更新没有完成，已恢复原来的版本。${detail}`);
  }
  let trashed = false;
  try {
    if (trashItem) {
      await trashItem(backupPath);
      trashed = true;
    }
  } catch {
    trashed = false;
  }
  return { backupPath, trashed };
}

// ---------------------------------------------------------------------------
// Temp folders and relaunch

/** Removes one of our own update folders (skill-control-update-* directly under tempRoot). */
export async function removeTempDir(directory, tempRoot) {
  if (!directory || path.dirname(path.resolve(directory)) !== path.resolve(tempRoot)) return;
  if (!path.basename(directory).startsWith(TEMP_PREFIX)) return;
  await rm(directory, { recursive: true, force: true });
}

export const TEMP_DIR_PREFIX = TEMP_PREFIX;

/**
 * After this process exits (polling up to 60 s), `open -n` starts the new bundle. The pid and
 * the path are positional shell arguments, never interpolated into the script.
 */
export function spawnRelaunchHelper({ pid, appPath, spawnImpl = spawnProcess }) {
  const script =
    'i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.2; i=$((i+1)); done; exec /usr/bin/open -n "$2"';
  const child = spawnImpl("/bin/sh", ["-c", script, "skill-control-relaunch", String(pid), appPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref?.();
  return child;
}
