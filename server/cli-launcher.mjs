import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { posixQuote } from "./agent-update-run.mjs";
import { assertSafeWrite } from "./home-guard.mjs";

/**
 * The `skill-control` launcher (v0.3 §4.1): a small shell script in ~/.local/bin that runs
 * server/cli.mjs with the app's own Node (Electron in ELECTRON_RUN_AS_NODE mode), or with
 * the Node that runs the service from source. On macOS the script finds the app by its
 * bundle id each time (the recorded location first, then Spotlight, then /Applications and
 * ~/Applications), so moving or updating the app keeps it working; if the app is gone it
 * says so. It never uses AppleScript `path to application id`, which launches the app.
 *
 * The script carries a marker line; a file without it is someone else's and is never
 * overwritten or removed. Windows is not supported yet (the status explains).
 */

export const LAUNCHER_NAME = "skill-control";
export const LAUNCHER_MARKER = "# skill-control-launcher v1 — written by Skill Control";
const BUNDLE_ID = /^[\w.-]{1,200}$/u;
const SCRIPT_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));

/**
 * How the CLI can be started from here. The desktop app passes SKILL_CONTROL_APP_EXECUTABLE,
 * SKILL_CONTROL_APP_PATH, SKILL_CONTROL_APP_PACKAGED, SKILL_CONTROL_BUNDLE_ID and (AppImage)
 * SKILL_CONTROL_APPIMAGE; without them the service runs from source under Node.
 */
export function launcherTarget({ env = process.env, platform = process.platform, execPath = process.execPath, versions = process.versions } = {}) {
  const executable = env.SKILL_CONTROL_APP_EXECUTABLE;
  const appPath = env.SKILL_CONTROL_APP_PATH;
  const packaged = env.SKILL_CONTROL_APP_PACKAGED === "1";
  if (platform === "win32") return { kind: "unsupported", reason: "Windows 暂不支持安装命令行工具；可以在终端里用 node 运行 server/cli.mjs（从源码运行时）。" };
  if (executable && appPath && packaged) {
    if (platform === "darwin") {
      const match = executable.match(/^(.+\.app)\/Contents\/MacOS\/([^/]+)$/u);
      if (!match) return { kind: "unsupported", reason: "无法确定应用包的位置。" };
      const bundleId = BUNDLE_ID.test(String(env.SKILL_CONTROL_BUNDLE_ID || "")) ? env.SKILL_CONTROL_BUNDLE_ID : null;
      return { kind: "mac-app", bundlePath: match[1], executableName: match[2], bundleId, asar: path.relative(match[1], appPath) };
    }
    // AppImage: the image itself (its mount point changes every run); .deb / unpacked: the executable.
    return { kind: "linux-app", executable: env.SKILL_CONTROL_APPIMAGE || executable };
  }
  if (executable && appPath) return { kind: "electron-dev", executable, script: path.join(appPath, "server", "cli.mjs") };
  return { kind: "node", executable: execPath, script: SCRIPT_PATH, electron: Boolean(versions.electron) };
}

const header = (lines) => ["#!/bin/sh", LAUNCHER_MARKER, "# Skill Control 可能会改写或删除这个文件；请在应用的“设置 → Agent 集成”里安装或卸载。", ...lines].join("\n");

/** The launcher script for a target (values are single-quoted, never interpolated). */
export function launcherScript(target) {
  switch (target.kind) {
    case "mac-app": {
      const executable = `Contents/MacOS/${target.executableName}`;
      return `${header([
        `RECORDED_APP=${posixQuote(target.bundlePath)}`,
        `BUNDLE_ID=${posixQuote(target.bundleId || "")}`,
        `EXE_REL=${posixQuote(executable)}`,
        `CLI_REL=${posixQuote(`${target.asar}/server/cli.mjs`)}`,
        "bundle_id_of() {",
        '  /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$1/Contents/Info.plist" 2>/dev/null',
        "}",
        "matches() {",
        '  [ -x "$1/$EXE_REL" ] && { [ -z "$BUNDLE_ID" ] || [ "$(bundle_id_of "$1")" = "$BUNDLE_ID" ]; }',
        "}",
        'APP=""',
        'if matches "$RECORDED_APP"; then',
        '  APP="$RECORDED_APP"',
        'elif [ -n "$BUNDLE_ID" ]; then',
        "  # Spotlight first, then the usual Applications folders (nothing is launched).",
        '  CANDIDATES=$(/usr/bin/mdfind "kMDItemCFBundleIdentifier == \'$BUNDLE_ID\'" 2>/dev/null)',
        "  OLD_IFS=$IFS",
        "  IFS='",
        "'",
        '  for candidate in $CANDIDATES /Applications/*.app "$HOME"/Applications/*.app; do',
        '    if matches "$candidate"; then APP="$candidate"; break; fi',
        "  done",
        "  IFS=$OLD_IFS",
        "fi",
        'if [ -z "$APP" ]; then',
        '  echo "skill-control：找不到 Skill Control 应用（$BUNDLE_ID；上次在 $RECORDED_APP）。请重新安装应用，或在应用的“设置 → Agent 集成”里重新安装命令行工具。" >&2',
        "  exit 127",
        "fi",
        'ELECTRON_RUN_AS_NODE=1 exec "$APP/$EXE_REL" "$APP/$CLI_REL" "$@"',
      ])}\n`;
    }
    case "linux-app": {
      // The app's Node finds server/cli.mjs next to its own executable (resources/app.asar),
      // which also works inside an AppImage's changing mount point.
      const loader = 'const p=require("path");process.argv.splice(1,0,"skill-control");import(require("url").pathToFileURL(p.join(p.dirname(process.execPath),"resources","app.asar","server","cli.mjs")).href)';
      return `${header([
        `APP=${posixQuote(target.executable)}`,
        'if [ ! -x "$APP" ]; then',
        '  echo "skill-control：找不到 Skill Control（$APP）。请重新安装应用，或在应用的“设置 → Agent 集成”里重新安装命令行工具。" >&2',
        "  exit 127",
        "fi",
        `ELECTRON_RUN_AS_NODE=1 exec "$APP" -e ${posixQuote(loader)} -- "$@"`,
      ])}\n`;
    }
    case "electron-dev":
      return `${header([`ELECTRON_RUN_AS_NODE=1 exec ${posixQuote(target.executable)} ${posixQuote(target.script)} "$@"`])}\n`;
    case "node":
      return `${header([`${target.electron ? "ELECTRON_RUN_AS_NODE=1 " : ""}exec ${posixQuote(target.executable)} ${posixQuote(target.script)} "$@"`])}\n`;
    default:
      return null;
  }
}

async function inspect(file) {
  const info = await lstat(file).catch(() => null);
  if (!info) return { exists: false, ours: false, content: null };
  if (!info.isFile()) return { exists: true, ours: false, content: null };
  const content = await readFile(file, "utf8").catch(() => null);
  return { exists: true, ours: Boolean(content?.split("\n", 3).includes(LAUNCHER_MARKER)), content };
}

const display = (value, homeDirectory) => (value && value.startsWith(`${homeDirectory}${path.sep}`) ? `~/${path.relative(homeDirectory, value).split(path.sep).join("/")}` : value);

/** GET /api/cli-launcher: where the launcher goes, whether it is ours and current, and whether ~/.local/bin is on PATH. */
export async function launcherStatus({ homeDirectory, binDirectory = path.join(homeDirectory, ".local", "bin"), target = launcherTarget(), pathEntries = null }) {
  const file = path.join(binDirectory, LAUNCHER_NAME);
  const current = await inspect(file);
  const script = launcherScript(target);
  const onPath = Array.isArray(pathEntries) ? pathEntries.some((entry) => path.resolve(entry) === path.resolve(binDirectory)) : null;
  return {
    supported: target.kind !== "unsupported",
    ...(target.kind === "unsupported" ? { reason: target.reason } : {}),
    path: display(file, homeDirectory),
    installed: current.exists && current.ours,
    foreign: current.exists && !current.ours,
    upToDate: Boolean(script && current.ours && current.content === script),
    runsWith: target.kind === "mac-app" ? display(target.bundlePath, homeDirectory) : target.kind === "unsupported" ? null : display(target.executable, homeDirectory),
    onPath,
    ...(onPath === false ? { pathHint: `把 ${display(binDirectory, homeDirectory)} 加入 PATH，例如在 ~/.zshrc 里加一行：export PATH="$HOME/.local/bin:$PATH"` } : {}),
  };
}

export class LauncherError extends Error {
  constructor(statusCode, message, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** Writes (or updates) the launcher; a file that is not ours is never overwritten. */
export async function installLauncher({ homeDirectory, binDirectory = path.join(homeDirectory, ".local", "bin"), target = launcherTarget(), pathEntries = null }) {
  const script = launcherScript(target);
  if (!script) throw new LauncherError(409, target.reason || "这个平台暂不支持安装命令行工具。", "unsupported");
  const file = path.join(binDirectory, LAUNCHER_NAME);
  const current = await inspect(file);
  if (current.exists && !current.ours) throw new LauncherError(409, `${display(file, homeDirectory)} 已存在，而且不是 Skill Control 写的，已拒绝覆盖。请先自己处理这个文件。`, "foreign-file");
  await assertSafeWrite(file, homeDirectory);
  await mkdir(binDirectory, { recursive: true });
  const temporary = `${file}.skill-control-${process.pid}-${Date.now()}`;
  await writeFile(temporary, script, { mode: 0o755 });
  await rename(temporary, file);
  return launcherStatus({ homeDirectory, binDirectory, target, pathEntries });
}

/** Removes the launcher if it is ours. */
export async function uninstallLauncher({ homeDirectory, binDirectory = path.join(homeDirectory, ".local", "bin"), target = launcherTarget(), pathEntries = null }) {
  const file = path.join(binDirectory, LAUNCHER_NAME);
  const current = await inspect(file);
  if (current.exists && !current.ours) throw new LauncherError(409, `${display(file, homeDirectory)} 不是 Skill Control 写的，已拒绝删除。`, "foreign-file");
  if (current.exists) {
    await assertSafeWrite(file, homeDirectory);
    await unlink(file);
  }
  return launcherStatus({ homeDirectory, binDirectory, target, pathEntries });
}
