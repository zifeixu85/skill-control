import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installLauncher, LAUNCHER_MARKER, launcherScript, launcherStatus, launcherTarget, uninstallLauncher } from "../server/cli-launcher.mjs";
import { writeFixtureFile } from "./fixtures/smartorder.mjs";

const POSIX = process.platform !== "win32";
const CLI = fileURLToPath(new URL("../server/cli.mjs", import.meta.url));

async function tempHome(context) {
  const home = await mkdtemp(path.join(tmpdir(), "launcher-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test("how the CLI is started: app bundle, AppImage, Electron from source, plain Node; Windows not yet", () => {
  const mac = launcherTarget({ platform: "darwin", env: { SKILL_CONTROL_APP_EXECUTABLE: "/Applications/Skill Control.app/Contents/MacOS/Skill Control", SKILL_CONTROL_APP_PATH: "/Applications/Skill Control.app/Contents/Resources/app.asar", SKILL_CONTROL_APP_PACKAGED: "1", SKILL_CONTROL_BUNDLE_ID: "dev.skillcontrol.desktop" } });
  assert.deepEqual(mac, { kind: "mac-app", bundlePath: "/Applications/Skill Control.app", executableName: "Skill Control", bundleId: "dev.skillcontrol.desktop", asar: "Contents/Resources/app.asar" });
  const appImage = launcherTarget({ platform: "linux", env: { SKILL_CONTROL_APP_EXECUTABLE: "/tmp/.mount_x/skill-control", SKILL_CONTROL_APP_PATH: "/tmp/.mount_x/resources/app.asar", SKILL_CONTROL_APP_PACKAGED: "1", SKILL_CONTROL_APPIMAGE: "/home/a/Skill.AppImage" } });
  assert.deepEqual(appImage, { kind: "linux-app", executable: "/home/a/Skill.AppImage" });
  assert.equal(launcherTarget({ platform: "darwin", env: { SKILL_CONTROL_APP_EXECUTABLE: "/x/electron", SKILL_CONTROL_APP_PATH: "/repo", SKILL_CONTROL_APP_PACKAGED: "0" } }).kind, "electron-dev");
  assert.deepEqual(launcherTarget({ platform: "darwin", env: {}, execPath: "/usr/local/bin/node", versions: {} }), { kind: "node", executable: "/usr/local/bin/node", script: CLI, electron: false });
  assert.equal(launcherTarget({ platform: "win32", env: {} }).kind, "unsupported");
  // Values are single-quoted, never expanded by the shell.
  assert.match(launcherScript({ kind: "node", executable: "/a/b c/node", script: "/x/it's/cli.mjs", electron: false }), /exec '\/a\/b c\/node' '\/x\/it'\\''s\/cli\.mjs' "\$@"/u);
});

test("install, run, update and uninstall the launcher; someone else's file is never touched", { skip: !POSIX }, async (context) => {
  const home = await tempHome(context);
  const bin = path.join(home, ".local", "bin");
  const target = { kind: "node", executable: process.execPath, script: CLI, electron: false };
  const before = await launcherStatus({ homeDirectory: home, binDirectory: bin, target, pathEntries: ["/usr/bin"] });
  assert.deepEqual([before.installed, before.foreign, before.onPath, before.path], [false, false, false, "~/.local/bin/skill-control"]);
  assert.match(before.pathHint, /~\/\.local\/bin/u);
  const installed = await installLauncher({ homeDirectory: home, binDirectory: bin, target, pathEntries: [bin] });
  assert.deepEqual([installed.installed, installed.upToDate, installed.onPath], [true, true, true]);
  const file = path.join(bin, "skill-control");
  assert.equal((await stat(file)).mode & 0o777, 0o755);
  assert.equal((await readFile(file, "utf8")).split("\n")[1], LAUNCHER_MARKER);
  const ran = spawnSync(file, ["--version"], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^skill-control \d+\.\d+\.\d+/u);

  // An older launcher of ours is updated in place.
  await writeFile(file, `#!/bin/sh\n${LAUNCHER_MARKER}\nexit 1\n`);
  assert.equal((await launcherStatus({ homeDirectory: home, binDirectory: bin, target })).upToDate, false);
  assert.equal((await installLauncher({ homeDirectory: home, binDirectory: bin, target })).upToDate, true);
  assert.equal((await uninstallLauncher({ homeDirectory: home, binDirectory: bin, target })).installed, false);
  assert.equal(await stat(file).catch(() => null), null);

  // Someone else's skill-control: refused both ways, left as it was.
  await writeFixtureFile(bin, "skill-control", "#!/bin/sh\necho mine\n");
  await assert.rejects(installLauncher({ homeDirectory: home, binDirectory: bin, target }), (error) => error.code === "foreign-file" && error.statusCode === 409);
  await assert.rejects(uninstallLauncher({ homeDirectory: home, binDirectory: bin, target }), (error) => error.code === "foreign-file");
  assert.equal(await readFile(file, "utf8"), "#!/bin/sh\necho mine\n");
  assert.equal((await launcherStatus({ homeDirectory: home, binDirectory: bin, target })).foreign, true);
});

test("the macOS launcher finds the app by bundle id; a moved or missing app gives a clear error", { skip: process.platform !== "darwin" }, async (context) => {
  const home = await tempHome(context);
  const bundle = path.join(home, "Apps", "Fake Control.app");
  const bundleId = `test.skillcontrol.fake${process.pid}`;
  await writeFixtureFile(bundle, "Contents/Info.plist", `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>\n`);
  // A stand-in for the app executable: prints how it was started (no real app is launched).
  const executable = await writeFixtureFile(bundle, "Contents/MacOS/Fake Control", '#!/bin/sh\necho "run-as-node=$ELECTRON_RUN_AS_NODE"\nfor arg in "$@"; do echo "arg=$arg"; done\n');
  await chmod(executable, 0o755);
  await writeFixtureFile(bundle, "Contents/Resources/app.asar/server/cli.mjs", "// stand-in\n");
  const script = launcherScript({ kind: "mac-app", bundlePath: bundle, executableName: "Fake Control", bundleId, asar: "Contents/Resources/app.asar" });
  const launcher = path.join(home, "skill-control");
  await writeFile(launcher, script, { mode: 0o755 });
  const ran = spawnSync(launcher, ["status", "my skill", "--json"], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } });
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(ran.stdout.trim().split("\n"), ["run-as-node=1", `arg=${bundle}/Contents/Resources/app.asar/server/cli.mjs`, "arg=status", "arg=my skill", "arg=--json"]);
  // Moved away (and not in Spotlight or the Applications folders): a clear error, exit 127.
  await rename(bundle, path.join(home, "Apps", "Elsewhere.app"));
  const missing = spawnSync(launcher, ["status"], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } });
  assert.equal(missing.status, 127);
  assert.match(missing.stderr, /找不到 Skill Control 应用/u);
});

test("the Linux launcher runs the app's Node with a loader that finds server/cli.mjs next to the executable", { skip: !POSIX }, async (context) => {
  const home = await tempHome(context);
  const app = path.join(home, "Skill.AppImage");
  await writeFile(app, '#!/bin/sh\necho "run-as-node=$ELECTRON_RUN_AS_NODE"\nfor arg in "$@"; do echo "arg=$arg"; done\n', { mode: 0o755 });
  const launcher = path.join(home, "skill-control");
  await writeFile(launcher, launcherScript({ kind: "linux-app", executable: app }), { mode: 0o755 });
  const ran = spawnSync(launcher, ["sync", "--dry-run"], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } });
  const lines = ran.stdout.trim().split("\n");
  assert.deepEqual([lines[0], lines[1], lines.slice(-3)], ["run-as-node=1", "arg=-e", ["arg=--", "arg=sync", "arg=--dry-run"]]);
  assert.match(lines[2], /resources","app\.asar","server","cli\.mjs"/u);
});
