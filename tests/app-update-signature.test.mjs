import assert from "node:assert/strict";
import { mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import * as macOps from "../desktop/app-update-mac.mjs";
import {
  appManagementMayAsk,
  BLOCKED_TEXT,
  BUNDLE_ID,
  checkSigner,
  readCodeSignature,
  swapBundle,
  UpdateError,
  validateBundle,
} from "../desktop/app-updater.mjs";
import { bundleVersion, makeBundle, tempDir } from "./helpers/app-update-fixtures.mjs";
import { ADHOC_DISPLAY, CERT_SHA1, certDisplay, DER, DER_SHA1 } from "./helpers/codesign-fixtures.mjs";

const CURRENT = "/Applications/Skill Control.app";
const NEW = "/tmp/update/extracted/Skill Control.app";

/**
 * A fake execFile for /usr/bin/codesign: `display[path]` answers `-d -r-`, `verify(path, requirement)`
 * answers `--verify` (throw to fail), and `--extract-certificates` writes the DER fixture.
 */
function fakeCodesign({ display = {}, verify = () => {} } = {}) {
  const calls = [];
  const execFileImpl = async (command, args) => {
    assert.equal(command, "/usr/bin/codesign");
    calls.push(args);
    const target = args.at(-1);
    if (args[0] === "--verify") {
      const index = args.indexOf("-R");
      verify(target, index >= 0 ? args[index + 1] : null);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "-d" && String(args[1]).startsWith("--extract-certificates=")) {
      await writeFile(`${args[1].slice("--extract-certificates=".length)}0`, DER);
      return { stdout: "", stderr: "" };
    }
    if (!(target in display)) throw Object.assign(new Error("code object is not signed at all"), { code: 1 });
    return { stdout: "", stderr: display[target] };
  };
  return { execFileImpl, calls };
}

test("readCodeSignature parses codesign and returns null for unsigned code", async () => {
  const { execFileImpl, calls } = fakeCodesign({ display: { [CURRENT]: ADHOC_DISPLAY } });
  const info = await readCodeSignature(CURRENT, { execFileImpl });
  assert.equal(info.adhoc, true);
  assert.equal(info.cdhash, "a53def63b68c67fab80392a01dc51b790bf64f1e");
  assert.deepEqual(calls[0], ["-d", "-r-", "--verbose=4", CURRENT]);
  assert.equal(await readCodeSignature("/elsewhere.app", { execFileImpl }), null);
});

test("an ad-hoc running copy (0.2.x) only needs a valid signature on the new bundle", async (t) => {
  const tempDir_ = await tempDir(t, "sig-adhoc");
  const { execFileImpl, calls } = fakeCodesign({ display: { [CURRENT]: ADHOC_DISPLAY, [NEW]: certDisplay() } });
  assert.deepEqual(await checkSigner({ currentPath: CURRENT, newPath: NEW, tempDir: tempDir_, bundleId: BUNDLE_ID, execFileImpl }), {
    checked: false,
    reason: "adhoc",
  });
  assert.deepEqual(calls[0], ["--verify", "--deep", "--strict", NEW]);
  assert.equal(calls.some((args) => args.includes("-R")), false, "no requirement to compare against");

  const unsigned = fakeCodesign({ display: {} });
  assert.equal((await checkSigner({ currentPath: CURRENT, newPath: NEW, tempDir: tempDir_, bundleId: BUNDLE_ID, execFileImpl: unsigned.execFileImpl })).reason, "unsigned");

  const broken = fakeCodesign({
    display: { [CURRENT]: ADHOC_DISPLAY },
    verify: () => {
      throw new Error("a sealed resource is missing or invalid");
    },
  });
  await assert.rejects(
    checkSigner({ currentPath: CURRENT, newPath: NEW, tempDir: tempDir_, bundleId: BUNDLE_ID, execFileImpl: broken.execFileImpl }),
    (error) => error instanceof UpdateError && error.code === "signature" && /签名无效/u.test(error.message),
  );
});

test("a certificate-signed running copy requires its designated requirement", async (t) => {
  const tempDir_ = await tempDir(t, "sig-dr");
  const requirements = [];
  const same = fakeCodesign({
    display: { [CURRENT]: certDisplay(), [NEW]: certDisplay({ cdhash: "f".repeat(40) }) },
    verify: (_target, requirement) => requirements.push(requirement),
  });
  assert.deepEqual(await checkSigner({ currentPath: CURRENT, newPath: NEW, tempDir: tempDir_, bundleId: BUNDLE_ID, execFileImpl: same.execFileImpl }), {
    checked: true,
    by: "designated-requirement",
  });
  assert.deepEqual(requirements, [null, `=identifier "dev.skillcontrol.desktop" and certificate leaf = H"${CERT_SHA1.toLowerCase()}"`]);

  // Another certificate: refused unless this version already trusts it (certificate rotation).
  const otherHash = "0".repeat(40);
  const rotation = () =>
    fakeCodesign({
      display: { [CURRENT]: certDisplay(), [NEW]: certDisplay({ hash: otherHash }) },
      verify: (_target, requirement) => {
        if (requirement) throw new Error("test-requirement: code failed to satisfy specified code requirement(s)");
      },
    });
  await assert.rejects(
    checkSigner({ currentPath: CURRENT, newPath: NEW, tempDir: tempDir_, bundleId: BUNDLE_ID, execFileImpl: rotation().execFileImpl, trusted: [CERT_SHA1] }),
    (error) => error.code === "signature" && /证书和当前应用不一致/u.test(error.message),
  );
  assert.deepEqual(
    await checkSigner({ currentPath: CURRENT, newPath: NEW, tempDir: tempDir_, bundleId: BUNDLE_ID, execFileImpl: rotation().execFileImpl, trusted: [DER_SHA1] }),
    { checked: true, by: "trusted-certificate", sha1: DER_SHA1 },
  );

  // A trusted certificate on another app, or an ad-hoc update, never passes.
  const foreign = fakeCodesign({
    display: { [CURRENT]: certDisplay(), [NEW]: certDisplay({ hash: otherHash, identifier: "com.example.other" }) },
    verify: (_target, requirement) => {
      if (requirement) throw new Error("failed");
    },
  });
  await assert.rejects(checkSigner({ currentPath: CURRENT, newPath: NEW, tempDir: tempDir_, bundleId: BUNDLE_ID, execFileImpl: foreign.execFileImpl, trusted: [DER_SHA1] }), /不一致/u);
  const downgrade = fakeCodesign({
    display: { [CURRENT]: certDisplay(), [NEW]: ADHOC_DISPLAY },
    verify: (_target, requirement) => {
      if (requirement) throw new Error("failed");
    },
  });
  await assert.rejects(checkSigner({ currentPath: CURRENT, newPath: NEW, tempDir: tempDir_, bundleId: BUNDLE_ID, execFileImpl: downgrade.execFileImpl, trusted: [DER_SHA1] }), /不一致/u);
});

test("appManagementMayAsk: macOS 13+ (Darwin 22+) without a Developer ID team", () => {
  assert.equal(appManagementMayAsk({ signature: null, osRelease: "25.4.0" }), true);
  assert.equal(appManagementMayAsk({ signature: { teamIdentifier: null }, osRelease: "22.1.0" }), true);
  assert.equal(appManagementMayAsk({ signature: { teamIdentifier: "ABCDE12345" }, osRelease: "25.4.0" }), false);
  assert.equal(appManagementMayAsk({ signature: null, osRelease: "21.6.0" }), false, "macOS 12 has no App Management");
  assert.equal(appManagementMayAsk({ signature: null, osRelease: "garbage" }), false);
});

// ---------------------------------------------------------------------------
// macOS refusing the swap (App Management, permissions)

async function swapFixture(t) {
  const root = await tempDir(t, "blocked");
  const applications = path.join(root, "Applications");
  const current = await makeBundle(applications, { version: "0.2.1" });
  const fresh = await makeBundle(path.join(root, "download"), { version: "0.3.0" });
  await mkdir(path.join(root, "Trash"));
  return { applications, current, fresh, trashItem: (target) => rename(target, path.join(root, "Trash", path.basename(target))) };
}

const denied = (code) => Object.assign(new Error(`${code}: operation not permitted`), { code });

test("a refused first move (EPERM) is reported as blocked, with nothing changed", async (t) => {
  const fixture = await swapFixture(t);
  const ops = {
    ...macOps.defaultSwapOps,
    rename: async () => {
      throw denied("EPERM");
    },
  };
  await assert.rejects(
    swapBundle({ currentPath: fixture.current, newPath: fixture.fresh, currentVersion: "0.2.1", trashItem: fixture.trashItem, ops }),
    (error) => error instanceof UpdateError && error.code === "blocked" && error.message === `${BLOCKED_TEXT}原来的版本没有改动。`,
  );
  assert.match(BLOCKED_TEXT, /系统设置 → 隐私与安全性 → App管理/u);
  assert.equal(await bundleVersion(fixture.current), "0.2.1");
  assert.deepEqual(await readdir(fixture.applications), ["Skill Control.app"]);
});

test("a refused move of the new bundle (EACCES) rolls back and is reported as blocked", async (t) => {
  const fixture = await swapFixture(t);
  let calls = 0;
  const ops = {
    ...macOps.defaultSwapOps,
    rename: async (source, destination) => {
      calls += 1;
      if (calls === 2) throw denied("EACCES");
      return rename(source, destination);
    },
  };
  await assert.rejects(
    swapBundle({
      currentPath: fixture.current,
      newPath: fixture.fresh,
      currentVersion: "0.2.1",
      trashItem: fixture.trashItem,
      validate: (target) => validateBundle(target, { bundleId: BUNDLE_ID, version: "0.3.0" }),
      ops,
    }),
    (error) => error.code === "blocked" && error.message.endsWith("已恢复原来的版本。"),
  );
  assert.equal(await bundleVersion(fixture.current), "0.2.1");
  assert.deepEqual(await readdir(fixture.applications), ["Skill Control.app"]);
});
