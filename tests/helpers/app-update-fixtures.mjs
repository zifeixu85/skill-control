import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { BUNDLE_ID, readInfoPlistXml } from "../../desktop/app-update-core.mjs";

/** Shared fixtures for the app updater tests: fake bundles, releases, manifests and fetch. */

export const REPO = "https://github.com/zifeixu85/skill-control";
export const sha512 = (buffer) => createHash("sha512").update(buffer).digest("base64");
export const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

export async function tempDir(t, label = "updater") {
  const directory = await mkdtemp(path.join(os.tmpdir(), `sc-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export function infoPlist({ bundleId = BUNDLE_ID, version, executable = "Skill Control" }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Skill Control</string>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleIdentifier</key>
      <string>nested.should.be.ignored</string>
    </dict>
  </array>
  <key>CFBundleExecutable</key>
  <string>${executable}</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSEnvironment</key>
  <dict/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>Copyright &#169; 2026 Skill Control contributors &amp; friends</string>
</dict>
</plist>
`;
}

export async function makeBundle(directory, { version, bundleId, executable = "Skill Control", mode = 0o755, name = "Skill Control.app" }) {
  const app = path.join(directory, name);
  await mkdir(path.join(app, "Contents", "MacOS"), { recursive: true });
  await writeFile(path.join(app, "Contents", "Info.plist"), infoPlist({ bundleId, version, executable }));
  await writeFile(path.join(app, "Contents", "MacOS", executable), "#!/bin/sh\nexit 0\n", { mode });
  return app;
}

export const bundleVersion = async (app) =>
  readInfoPlistXml(await readFile(path.join(app, "Contents", "Info.plist"), "utf8")).CFBundleShortVersionString;

export function releaseJson(version, names, overrides = {}) {
  return {
    tag_name: `v${version}`,
    html_url: `${REPO}/releases/tag/v${version}`,
    body: "## 新功能\n\n- 应用内更新",
    published_at: "2026-10-24T08:00:00Z",
    draft: false,
    prerelease: false,
    assets: names.map((name) => ({ name, size: 10, browser_download_url: `${REPO}/releases/download/v${version}/${name}` })),
    ...overrides,
  };
}

export function macManifest(version, files) {
  return yaml.dump({
    version,
    files: files.map(([url, buffer]) => ({ url, sha512: sha512(buffer), size: buffer.length })),
    path: files[0][0],
    sha512: sha512(files[0][1]),
    releaseDate: "2026-10-24T08:00:00.000Z",
  });
}

/** fetch stand-in: a map of URL → Response factory; records every request. */
export function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const route = routes[String(url)];
    if (!route) return new Response("not found", { status: 404 });
    return typeof route === "function" ? route(init) : route.clone();
  };
  return { fetchImpl, calls };
}

export const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
