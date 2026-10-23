import assert from "node:assert/strict";
import { access, chmod, cp, lstat, mkdir, readdir, rename, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import * as macOps from "../desktop/app-update-mac.mjs";
import {
  backupNameFor,
  bundlePathFromExecutable,
  BUNDLE_ID,
  checkReplaceable,
  compareVersions,
  downloadToFile,
  isAllowedAssetUrl,
  isAllowedDownloadUrl,
  isNewerVersion,
  MAX_NOTES_LENGTH,
  mergeMacManifests,
  normalizeVersion,
  parseMacManifest,
  parseReleaseResponse,
  pickMacZip,
  readInfoPlistXml,
  RELEASES_URL,
  sha512File,
  sha512Matches,
  shouldCheck,
  swapBundle,
  updateSupport,
  UpdateError,
  validateBundle,
} from "../desktop/app-updater.mjs";
import {
  bundleVersion,
  fakeFetch,
  infoPlist,
  macManifest,
  makeBundle,
  releaseJson,
  REPO,
  runningAsRoot,
  sha512,
  tempDir,
} from "./helpers/app-update-fixtures.mjs";

// ---------------------------------------------------------------------------
// Versions

test("compareVersions follows semver precedence, with or without a v prefix", () => {
  assert.equal(compareVersions("0.2.0", "0.1.0"), 1);
  assert.equal(compareVersions("v0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1, "numeric, not lexical");
  assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1, "a release outranks its pre-release");
  const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(compareVersions(ordered[index - 1], ordered[index]), -1, `${ordered[index - 1]} < ${ordered[index]}`);
  }
  assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0, "build metadata is ignored");
  assert.equal(compareVersions("1.0", "1.0.0"), null);
  assert.equal(compareVersions("latest", "1.0.0"), null);
  assert.equal(isNewerVersion("0.2.1", "0.2.0"), true);
  assert.equal(isNewerVersion("0.1.0", "0.2.0"), false);
  assert.equal(isNewerVersion("garbage", "0.2.0"), false);
  assert.equal(normalizeVersion("v0.2.0-beta.1+sha"), "0.2.0-beta.1");
});

test("shouldCheck: missing, old or future timestamps check; recent ones wait", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const day = 24 * 60 * 60 * 1000;
  assert.equal(shouldCheck({ checkedAt: null, now }), true);
  assert.equal(shouldCheck({ checkedAt: "not a date", now }), true);
  assert.equal(shouldCheck({ checkedAt: new Date(now - day - 1).toISOString(), now }), true);
  assert.equal(shouldCheck({ checkedAt: new Date(now - day + 60_000).toISOString(), now }), false);
  assert.equal(shouldCheck({ checkedAt: new Date(now + 2 * day).toISOString(), now }), true, "clock moved back");
});

test("updateSupport: offline and source runs never check; portable and deb only point to the download page", () => {
  assert.deepEqual(updateSupport({ platform: "darwin", arch: "arm64", packaged: true, env: { SKILL_MANAGER_UPDATES_OFFLINE: "1" } }).reason, "offline");
  assert.equal(updateSupport({ platform: "darwin", arch: "arm64", packaged: false, env: {} }).reason, "development");
  assert.equal(updateSupport({ platform: "darwin", arch: "arm64", packaged: true, env: {} }).backend, "mac");
  assert.equal(updateSupport({ platform: "darwin", arch: "ia32", packaged: true, env: {} }).check, false);
  assert.equal(updateSupport({ platform: "win32", arch: "x64", packaged: true, env: {} }).backend, "electron-updater");
  const portable = updateSupport({ platform: "win32", arch: "x64", packaged: true, env: { PORTABLE_EXECUTABLE_DIR: "C:\\Apps" } });
  assert.deepEqual([portable.check, portable.install, portable.reason], [true, false, "portable"]);
  assert.equal(updateSupport({ platform: "linux", arch: "x64", packaged: true, env: { APPIMAGE: "/opt/a.AppImage" } }).backend, "electron-updater");
  assert.equal(updateSupport({ platform: "linux", arch: "x64", packaged: true, env: {} }).reason, "package");
  assert.equal(updateSupport({ platform: "freebsd", arch: "x64", packaged: true, env: {} }).reason, "platform");
});

// ---------------------------------------------------------------------------
// GitHub release and manifests

test("parseReleaseResponse keeps only this repository's assets and safe names", () => {
  const parsed = parseReleaseResponse(
    releaseJson("0.2.0", ["latest-mac.yml", "Skill-Control-0.2.0-mac-arm64.zip"], {
      assets: [
        { name: "latest-mac.yml", size: 400, browser_download_url: `${REPO}/releases/download/v0.2.0/latest-mac.yml` },
        { name: "evil.zip", size: 1, browser_download_url: "https://example.com/zifeixu85/skill-control/releases/download/v0.2.0/evil.zip" },
        { name: "../escape.zip", size: 1, browser_download_url: `${REPO}/releases/download/v0.2.0/escape.zip` },
        { name: "other.zip", size: 1, browser_download_url: "https://github.com/someone/else/releases/download/v1/other.zip" },
      ],
    }),
  );
  assert.equal(parsed.version, "0.2.0");
  assert.equal(parsed.url, `${REPO}/releases/tag/v0.2.0`);
  assert.equal(parsed.publishedAt, "2026-10-24T08:00:00.000Z");
  assert.deepEqual([...parsed.assets.keys()], ["latest-mac.yml"]);
  assert.equal(parseReleaseResponse(releaseJson("0.3.0", [], { prerelease: true })), null, "pre-releases are not offered");
  assert.equal(parseReleaseResponse(releaseJson("0.3.0", [], { draft: true })), null);
  assert.equal(parseReleaseResponse(releaseJson("0.2.0", [], { html_url: "https://evil.example/x" })).url, RELEASES_URL);
  assert.equal(parseReleaseResponse(releaseJson("0.2.0", [], { body: "x".repeat(MAX_NOTES_LENGTH + 50) })).notes.length, MAX_NOTES_LENGTH + 2);
  assert.throws(() => parseReleaseResponse({ tag_name: "nightly" }), UpdateError);
  assert.throws(() => parseReleaseResponse([]), UpdateError);
});

test("asset and download URL allowlists", () => {
  assert.equal(isAllowedAssetUrl(`${REPO}/releases/download/v0.2.0/latest-mac.yml`), true);
  assert.equal(isAllowedAssetUrl("http://github.com/zifeixu85/skill-control/releases/download/v0.2.0/a.zip"), false);
  assert.equal(isAllowedAssetUrl("https://user:pw@github.com/zifeixu85/skill-control/releases/download/v0.2.0/a.zip"), false);
  assert.equal(isAllowedAssetUrl("https://github.com/zifeixu85/skill-control-evil/releases/download/v0.2.0/a.zip"), false);
  assert.equal(isAllowedDownloadUrl("https://release-assets.githubusercontent.com/github-production-release-asset/1/2"), true);
  assert.equal(isAllowedDownloadUrl("https://objects.githubusercontent.com/x"), true);
  assert.equal(isAllowedDownloadUrl("https://githubusercontent.com.evil.example/x"), false);
  assert.equal(isAllowedDownloadUrl("https://objects.githubusercontent.com:8443/x"), false);
});

test("parseMacManifest reads electron-builder's latest-mac.yml and keeps every scalar a string", () => {
  const arm = Buffer.from("arm64 zip");
  const x64 = Buffer.from("x64 zip");
  const manifest = parseMacManifest(
    macManifest("0.2.0", [
      ["Skill-Control-0.2.0-mac-arm64.zip", arm],
      ["Skill-Control-0.2.0-mac-arm64.dmg", arm],
      ["Skill-Control-0.2.0-mac-x64.zip", x64],
    ]),
  );
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.files.length, 3);
  assert.equal(pickMacZip(manifest, "arm64").sha512, sha512(arm));
  assert.equal(pickMacZip(manifest, "x64").size, x64.length);
  assert.throws(() => pickMacZip(manifest, "ia32"), /不支持/u);
  assert.equal(parseMacManifest("version: 1.10.0\nfiles:\n  - url: a-1.10.0-mac-x64.zip\n    sha512: " + sha512(x64) + "\n    size: 7\n").version, "1.10.0");

  const onlyArm = parseMacManifest(macManifest("0.2.0", [["Skill-Control-0.2.0-mac-arm64.zip", arm]]));
  assert.throws(() => pickMacZip(onlyArm, "x64"), /x64/u);
  const wrongVersion = parseMacManifest(macManifest("0.2.0", [["Skill-Control-0.1.9-mac-arm64.zip", arm]]));
  assert.throws(() => pickMacZip(wrongVersion, "arm64"), UpdateError, "the zip name must carry the manifest version");

  const bad = (text) => assert.throws(() => parseMacManifest(text), UpdateError, text);
  bad("");
  bad("version: 0.2.0\nfiles: []\n");
  bad(`version: 0.2.0\nfiles:\n  - url: ../a.zip\n    sha512: ${sha512(arm)}\n    size: 9\n`);
  bad("version: 0.2.0\nfiles:\n  - url: a.zip\n    sha512: short\n    size: 9\n");
  bad(`version: 0.2.0\nfiles:\n  - url: a.zip\n    sha512: ${sha512(arm)}\n    size: -1\n`);
  bad(`version: nope\nfiles:\n  - url: a.zip\n    sha512: ${sha512(arm)}\n    size: 9\n`);
  bad("[1, 2");
});

test("mergeMacManifests combines the arm64 and x64 manifests for one latest-mac.yml", () => {
  const arm = yaml.load(macManifest("0.2.0", [["Skill-Control-0.2.0-mac-arm64.zip", Buffer.from("a")], ["Skill-Control-0.2.0-mac-arm64.dmg", Buffer.from("b")]]));
  const x64 = yaml.load(macManifest("0.2.0", [["Skill-Control-0.2.0-mac-x64.zip", Buffer.from("c")]]));
  x64.releaseDate = "2026-10-24T09:00:00.000Z";
  const merged = mergeMacManifests([arm, x64]);
  assert.deepEqual(merged.files.map((file) => file.url), [
    "Skill-Control-0.2.0-mac-arm64.dmg",
    "Skill-Control-0.2.0-mac-arm64.zip",
    "Skill-Control-0.2.0-mac-x64.zip",
  ]);
  assert.equal(merged.path, "Skill-Control-0.2.0-mac-x64.zip");
  assert.equal(merged.sha512, sha512(Buffer.from("c")));
  assert.equal(merged.releaseDate, "2026-10-24T09:00:00.000Z");
  const reparsed = parseMacManifest(yaml.dump(merged));
  assert.equal(pickMacZip(reparsed, "arm64").url, "Skill-Control-0.2.0-mac-arm64.zip");
  assert.throws(() => mergeMacManifests([arm, { ...x64, version: "0.2.1" }]), /版本不一致/u);
  const clash = structuredClone(x64);
  clash.files = [{ ...arm.files[0], sha512: sha512(Buffer.from("zz")) }];
  assert.throws(() => mergeMacManifests([arm, clash]), /sha512/u);
  assert.throws(() => mergeMacManifests([]), Error);
});

test("readInfoPlistXml reads top-level keys only and decodes entities", () => {
  const info = readInfoPlistXml(infoPlist({ version: "0.2.0" }));
  assert.equal(info.CFBundleIdentifier, BUNDLE_ID, "the nested CFBundleIdentifier is ignored");
  assert.equal(info.CFBundleShortVersionString, "0.2.0");
  assert.equal(info.NSHighResolutionCapable, true);
  assert.equal(info.NSHumanReadableCopyright, "Copyright © 2026 Skill Control contributors & friends");
  assert.equal(Object.getPrototypeOf(info), null);
  assert.equal(readInfoPlistXml("<plist><dict><key>A</key><string/></dict></plist>").A, "");
  assert.throws(() => readInfoPlistXml("<plist><array/></plist>"), UpdateError);
  assert.throws(() => readInfoPlistXml("<plist><dict><key>A</key><string>x</dict>"), UpdateError);
});

// ---------------------------------------------------------------------------
// Download and sha512

test("downloadToFile streams, hashes and reports progress; sha512 must match", async (t) => {
  const directory = await tempDir(t);
  const payload = Buffer.alloc(200_000, 7);
  const { fetchImpl } = fakeFetch({ "https://github.com/x.zip": new Response(payload, { headers: { "content-length": String(payload.length) } }) });
  const seen = [];
  const destination = path.join(directory, "x.zip");
  const result = await downloadToFile({ fetchImpl, url: "https://github.com/x.zip", destination, expectedSize: payload.length, onProgress: (done, total) => seen.push([done, total]) });
  assert.equal(result.size, payload.length);
  assert.equal(result.sha512, sha512(payload));
  assert.equal(await sha512File(destination), sha512(payload));
  assert.equal(seen.at(-1)[0], payload.length);
  assert.equal((await lstat(destination)).mode & 0o777, 0o600);
  assert.equal(sha512Matches(result.sha512, sha512(payload)), true);
  assert.equal(sha512Matches(result.sha512, sha512(Buffer.from("other"))), false);
  assert.equal(sha512Matches(undefined, undefined), false);
});

test("downloadToFile refuses size mismatches, oversize bodies and unknown redirect hosts", async (t) => {
  const directory = await tempDir(t);
  const payload = Buffer.from("0123456789");
  const make = () => new Response(payload);
  await assert.rejects(
    downloadToFile({ fetchImpl: async () => make(), url: "https://github.com/a", destination: path.join(directory, "a"), expectedSize: 11 }),
    /不完整/u,
  );
  await assert.rejects(
    downloadToFile({ fetchImpl: async () => make(), url: "https://github.com/b", destination: path.join(directory, "b"), expectedSize: 4 }),
    /大/u,
  );
  const redirected = make();
  Object.defineProperty(redirected, "url", { value: "https://evil.example/payload.zip" });
  await assert.rejects(
    downloadToFile({ fetchImpl: async () => redirected, url: "https://github.com/c", destination: path.join(directory, "c"), expectedSize: 10 }),
    /未知的主机/u,
  );
  await assert.rejects(
    downloadToFile({ fetchImpl: async () => new Response("x", { status: 500 }), url: "https://github.com/d", destination: path.join(directory, "d"), expectedSize: 1 }),
    /HTTP 500/u,
  );
});

// ---------------------------------------------------------------------------
// Bundle checks

test("validateBundle checks the bundle id, version and executable", async (t) => {
  const directory = await tempDir(t);
  const good = await makeBundle(path.join(directory, "good"), { version: "0.2.0" });
  const result = await validateBundle(good, { bundleId: BUNDLE_ID, version: "0.2.0" });
  assert.equal(result.executablePath, path.join(good, "Contents", "MacOS", "Skill Control"));
  await assert.rejects(validateBundle(good, { bundleId: BUNDLE_ID, version: "0.2.1" }), /版本号/u);
  const foreign = await makeBundle(path.join(directory, "foreign"), { version: "0.2.0", bundleId: "com.example.other" });
  await assert.rejects(validateBundle(foreign, { bundleId: BUNDLE_ID, version: "0.2.0" }), /应用标识/u);
  const notExecutable = await makeBundle(path.join(directory, "noexec"), { version: "0.2.0", mode: 0o644 });
  await assert.rejects(validateBundle(notExecutable, { bundleId: BUNDLE_ID, version: "0.2.0" }), /可执行文件/u);
  const sneaky = await makeBundle(path.join(directory, "sneaky"), { version: "0.2.0", executable: "../../x" }).catch(() => null);
  if (sneaky) await assert.rejects(validateBundle(sneaky, { bundleId: BUNDLE_ID, version: "0.2.0" }), UpdateError);
  const link = path.join(directory, "Link.app");
  await symlink(good, link);
  await assert.rejects(validateBundle(link, { bundleId: BUNDLE_ID, version: "0.2.0" }), /不是有效的应用/u);
  await assert.rejects(validateBundle(path.join(directory, "missing.app"), { bundleId: BUNDLE_ID, version: "0.2.0" }), UpdateError);
});

test("bundlePathFromExecutable and checkReplaceable", async (t) => {
  assert.equal(bundlePathFromExecutable("/Applications/Skill Control.app/Contents/MacOS/Skill Control"), "/Applications/Skill Control.app");
  assert.equal(bundlePathFromExecutable("/usr/local/bin/electron"), null);
  assert.equal(bundlePathFromExecutable("relative/Skill Control.app/Contents/MacOS/x"), null);

  const translocated = await checkReplaceable("/private/var/folders/xy/AppTranslocation/ABC/d/Skill Control.app");
  assert.equal(translocated.ok, false);
  assert.match(translocated.manual, /应用程序/u);
  assert.equal((await checkReplaceable(null)).ok, false);

  const directory = await tempDir(t);
  const app = await makeBundle(directory, { version: "0.1.0" });
  assert.deepEqual(await checkReplaceable(app), { ok: true });
  if (!runningAsRoot) {
    await chmod(directory, 0o555);
    try {
      const readOnly = await checkReplaceable(app);
      assert.equal(readOnly.ok, false);
      assert.match(readOnly.manual, /不可写/u);
    } finally {
      await chmod(directory, 0o755);
    }
  }
});

// ---------------------------------------------------------------------------
// Swap and rollback

async function swapFixture(t) {
  const root = await tempDir(t, "swap");
  const applications = path.join(root, "Applications");
  const trash = path.join(root, "Trash");
  await mkdir(trash, { recursive: true });
  const current = await makeBundle(applications, { version: "0.1.0" });
  const fresh = await makeBundle(path.join(root, "download", "extracted"), { version: "0.2.0" });
  const trashItem = async (target) => rename(target, path.join(trash, path.basename(target)));
  const validate = (target) => validateBundle(target, { bundleId: BUNDLE_ID, version: "0.2.0" });
  return { root, applications, trash, current, fresh, trashItem, validate };
}

test("swapBundle replaces the app and moves the old one to the Trash with a timestamped name", async (t) => {
  const fixture = await swapFixture(t);
  const date = new Date(2026, 9, 24, 10, 15, 30);
  const result = await swapBundle({ currentPath: fixture.current, newPath: fixture.fresh, currentVersion: "0.1.0", date, trashItem: fixture.trashItem, validate: fixture.validate });
  assert.equal(await bundleVersion(fixture.current), "0.2.0");
  assert.equal(result.trashed, true);
  assert.equal(path.basename(result.backupPath), "Skill Control 0.1.0 (replaced 20261024-101530).app");
  assert.deepEqual(await readdir(fixture.trash), ["Skill Control 0.1.0 (replaced 20261024-101530).app"]);
  assert.equal(await bundleVersion(path.join(fixture.trash, path.basename(result.backupPath))), "0.1.0");
  assert.deepEqual(await readdir(fixture.applications), ["Skill Control.app"]);
});

test("swapBundle keeps the backup when the Trash refuses it", async (t) => {
  const fixture = await swapFixture(t);
  const result = await swapBundle({
    currentPath: fixture.current,
    newPath: fixture.fresh,
    currentVersion: "0.1.0",
    trashItem: async () => {
      throw new Error("trash unavailable");
    },
    validate: fixture.validate,
  });
  assert.equal(result.trashed, false);
  assert.equal(await bundleVersion(fixture.current), "0.2.0");
  assert.equal(await bundleVersion(result.backupPath), "0.1.0");
});

test("swapBundle rolls back when the new bundle cannot be moved in", async (t) => {
  const fixture = await swapFixture(t);
  let calls = 0;
  const ops = {
    ...macOps.defaultSwapOps,
    rename: async (source, destination) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return rename(source, destination);
    },
  };
  await assert.rejects(
    swapBundle({ currentPath: fixture.current, newPath: fixture.fresh, currentVersion: "0.1.0", trashItem: fixture.trashItem, validate: fixture.validate, ops }),
    /已恢复原来的版本/u,
  );
  assert.equal(await bundleVersion(fixture.current), "0.1.0");
  assert.deepEqual(await readdir(fixture.applications), ["Skill Control.app"]);
  assert.deepEqual(await readdir(fixture.trash), []);
});

test("swapBundle rolls back when the installed bundle fails validation", async (t) => {
  const fixture = await swapFixture(t);
  await assert.rejects(
    swapBundle({
      currentPath: fixture.current,
      newPath: fixture.fresh,
      currentVersion: "0.1.0",
      trashItem: fixture.trashItem,
      validate: (target) => validateBundle(target, { bundleId: BUNDLE_ID, version: "9.9.9" }),
    }),
    /已恢复原来的版本.*版本号/u,
  );
  assert.equal(await bundleVersion(fixture.current), "0.1.0");
  assert.deepEqual(await readdir(fixture.applications), ["Skill Control.app"], "the failed copy is cleaned up");
});

test("swapBundle copies across volumes (EXDEV) through a hidden staging folder", async (t) => {
  const fixture = await swapFixture(t);
  const copies = [];
  const ops = {
    ...macOps.defaultSwapOps,
    rename: async (source, destination) => {
      if (source === fixture.fresh) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      return rename(source, destination);
    },
    copy: async (source, destination) => {
      copies.push(path.basename(destination));
      await cp(source, destination, { recursive: true, verbatimSymlinks: true });
    },
  };
  await swapBundle({ currentPath: fixture.current, newPath: fixture.fresh, currentVersion: "0.1.0", trashItem: fixture.trashItem, validate: fixture.validate, ops });
  assert.equal(await bundleVersion(fixture.current), "0.2.0");
  assert.match(copies[0], /^\.Skill Control\.app\.update-/u);
  assert.deepEqual(await readdir(fixture.applications), ["Skill Control.app"]);
});

test("swapBundle refuses to start when the current bundle cannot be moved", async (t) => {
  const fixture = await swapFixture(t);
  await assert.rejects(
    swapBundle({ currentPath: path.join(fixture.applications, "Missing.app"), newPath: fixture.fresh, currentVersion: "0.1.0" }),
    /原来的版本没有改动/u,
  );
  await access(fixture.fresh);
});

test("ditto round trip: a zipped bundle extracts to one valid .app (macOS only)", { skip: process.platform !== "darwin" }, async (t) => {
  const root = await tempDir(t, "ditto");
  const app = await makeBundle(path.join(root, "src"), { version: "0.2.0" });
  const zip = path.join(root, "update.zip");
  const { execFile } = await import("node:child_process");
  await new Promise((resolve, reject) =>
    execFile("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip], (error) => (error ? reject(error) : resolve())),
  );
  const destination = path.join(root, "out");
  await mkdir(destination);
  await macOps.extractZip(zip, destination);
  const extracted = await macOps.findExtractedApp(destination);
  assert.equal(path.basename(extracted), "Skill Control.app");
  await validateBundle(extracted, { bundleId: BUNDLE_ID, version: "0.2.0" });
});

test("extractZip reports failures; findExtractedApp wants exactly one real .app", async (t) => {
  await assert.rejects(
    macOps.extractZip("/nope.zip", "/nope", { execFileImpl: async () => Promise.reject(new Error("exit 1")) }),
    /解压失败/u,
  );
  const calls = [];
  await macOps.extractZip("/a.zip", "/b", { execFileImpl: async (...args) => calls.push(args) });
  assert.deepEqual(calls[0].slice(0, 2), ["/usr/bin/ditto", ["-x", "-k", "/a.zip", "/b"]]);

  const root = await tempDir(t, "find");
  await assert.rejects(macOps.findExtractedApp(root), /唯一/u);
  const real = await makeBundle(path.join(root, "elsewhere"), { version: "0.2.0" });
  const only = path.join(root, "only");
  await mkdir(only);
  await symlink(real, path.join(only, "Skill Control.app"));
  await assert.rejects(macOps.findExtractedApp(only), /唯一/u, "a symlinked .app is not accepted");
});

test("spawnRelaunchHelper waits for this process, then opens the bundle with positional arguments", () => {
  const spawned = [];
  let unref = 0;
  macOps.spawnRelaunchHelper({
    pid: 4242,
    appPath: "/Applications/Skill Control.app; rm -rf ~",
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      return { unref: () => (unref += 1) };
    },
  });
  assert.equal(spawned[0].command, "/bin/sh");
  const [flag, script, name, pid, appPath] = spawned[0].args;
  assert.equal(flag, "-c");
  assert.match(script, /kill -0 "\$1"/u);
  assert.match(script, /exec \/usr\/bin\/open -n "\$2"/u);
  assert.equal(script.includes("Skill Control"), false, "the path is never part of the script");
  assert.deepEqual([name, pid, appPath], ["skill-control-relaunch", "4242", "/Applications/Skill Control.app; rm -rf ~"]);
  assert.deepEqual(spawned[0].options, { detached: true, stdio: "ignore" });
  assert.equal(unref, 1);
});

test("backupNameFor uses the bundle name, version and local time", () => {
  assert.equal(backupNameFor("Skill Control", "v0.1.0", new Date(2026, 0, 2, 3, 4, 5)), "Skill Control 0.1.0 (replaced 20260102-030405).app");
  assert.equal(backupNameFor("Skill Control", "weird", new Date(2026, 0, 2, 3, 4, 5)), "Skill Control old (replaced 20260102-030405).app");
});
