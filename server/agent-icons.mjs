import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readAppBundle } from "./config-files.mjs";
import { resolveInside } from "./fs-safe.mjs";

/**
 * GET /api/agent-icon: a 128 px PNG of an installed macOS app's icon. The bundle is found
 * by known names under /Applications and ~/Applications and must carry an expected bundle
 * id; its .icns is converted once with `sips` (argument array, no shell) and cached in
 * ~/.agent-skill-manager/icons. Other platforms and missing apps return null (404).
 */

const run = promisify(execFile);
const ICON_SOURCE_LIMIT = 20 * 1024 * 1024;
const ICON_OUTPUT_LIMIT = 512 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Agent or product id → app bundle names and accepted bundle ids (empty: name only). */
export const AGENT_APPS = {
  codex: { names: ["Codex.app"], bundleIds: ["com.openai.codex"] },
  claude: { names: ["Claude.app"], bundleIds: ["com.anthropic.claudefordesktop"] },
  workbuddy: { names: ["WorkBuddy.app"], bundleIds: ["com.tencent.workbuddy.mac", "com.tencent.workbuddy"] },
  cursor: { names: ["Cursor.app"], bundleIds: ["com.todesktop.230313mzl4w4u92"] },
  trae: { names: ["Trae CN.app", "Trae.app", "TRAE SOLO.app"], bundleIds: ["cn.trae.app", "com.trae.app", "com.trae.solo.app"] },
  hermes: { names: ["Hermes.app"], bundleIds: ["com.nousresearch.hermes"] },
  qclaw: { names: ["QClaw.app"], bundleIds: ["com.tencent.qclaw"] },
  lumiclaw: { names: ["LumiClaw.app"], bundleIds: ["com.lumiclaw.app"] },
  moticlaw: { names: ["MotiClaw.app"], bundleIds: ["cn.moticlaw.desktop"] },
  smartorder: { names: ["订单来了.app"], bundleIds: ["com.ddll.ddlldesk"] },
  kiro: { names: ["Kiro.app"], bundleIds: [] },
  windsurf: { names: ["Windsurf.app"], bundleIds: ["com.exafunction.windsurf"] },
  "office-raccoon": { names: ["办公小浣熊.app"], bundleIds: ["com.sensetime.desktop.raccoon"] },
};

export const defaultApplicationDirectories = (homeDirectory = homedir()) => ["/Applications", path.join(homeDirectory, "Applications")];

/** The first installed app for this agent, with its icon file inside the bundle. */
async function findApp(agentId, applicationDirectories) {
  const spec = AGENT_APPS[agentId];
  if (!spec) return null;
  for (const directory of applicationDirectories) {
    for (const name of spec.names) {
      const appPath = path.join(directory, name);
      const bundle = await readAppBundle(appPath);
      if (!bundle) continue;
      if (spec.bundleIds.length && !spec.bundleIds.includes(bundle.bundleId)) continue;
      const iconName = bundle.iconFile ? (path.extname(bundle.iconFile) ? bundle.iconFile : `${bundle.iconFile}.icns`) : null;
      const candidates = [iconName, "AppIcon.icns", "icon.icns", "electron.icns"].filter(Boolean);
      for (const candidate of candidates) {
        if (!/^[\p{L}\p{N} _.-]{1,128}\.icns$/u.test(candidate)) continue;
        const iconPath = await resolveInside(appPath, path.join("Contents", "Resources", candidate));
        if (iconPath) return { appPath, iconPath };
      }
    }
  }
  return null;
}

/** Cheap check for the scan: a known, verified app bundle with an icon file (no conversion). */
export async function hasAgentIcon(agentId, { homeDirectory = homedir(), applicationDirectories = defaultApplicationDirectories(homeDirectory), platform = process.platform } = {}) {
  if (platform !== "darwin" || !Object.hasOwn(AGENT_APPS, agentId)) return false;
  return Boolean(await findApp(agentId, applicationDirectories).catch(() => null));
}

async function convertWithSips(source, destination) {
  await run("/usr/bin/sips", ["-s", "format", "png", "-Z", "128", source, "--out", destination], {
    timeout: 10_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
}

const isPng = (buffer) => buffer.length > PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);

/**
 * Returns { buffer, mimeType, filename } or null. `convert(source, destination)` is
 * injectable for tests; the default runs /usr/bin/sips.
 */
export async function readAgentIcon(
  agentId,
  {
    homeDirectory = homedir(),
    cacheDirectory = path.join(homeDirectory, ".agent-skill-manager", "icons"),
    applicationDirectories = defaultApplicationDirectories(homeDirectory),
    platform = process.platform,
    convert = convertWithSips,
  } = {},
) {
  if (platform !== "darwin" || !Object.hasOwn(AGENT_APPS, agentId)) return null;
  const app = await findApp(agentId, applicationDirectories);
  if (!app) return null;
  let source;
  try {
    source = await stat(app.iconPath);
  } catch {
    return null;
  }
  if (!source.isFile() || source.size > ICON_SOURCE_LIMIT) return null;
  const version = createHash("sha1").update(`${app.iconPath}\0${source.size}\0${source.mtimeMs}`).digest("hex").slice(0, 16);
  const cached = path.join(cacheDirectory, `${agentId}-${version}.png`);
  const result = (buffer) => ({ buffer, mimeType: "image/png", filename: `${agentId}.png` });
  try {
    const buffer = await readFile(cached);
    if (isPng(buffer) && buffer.length <= ICON_OUTPUT_LIMIT) return result(buffer);
  } catch {
    // Not cached yet.
  }
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const temporary = path.join(cacheDirectory, `.${agentId}-${process.pid}-${Date.now()}.png`);
  try {
    await convert(app.iconPath, temporary);
    const buffer = await readFile(temporary);
    if (!isPng(buffer) || buffer.length > ICON_OUTPUT_LIMIT) return null;
    await rename(temporary, cached);
    // Older conversions of the same app are no longer needed.
    for (const name of await readdir(cacheDirectory).catch(() => [])) {
      if (name.startsWith(`${agentId}-`) && name.endsWith(".png") && name !== path.basename(cached)) {
        await rm(path.join(cacheDirectory, name), { force: true });
      }
    }
    return result(buffer);
  } catch {
    return null;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
