import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  hasCertificateSigner,
  isCdhashRequirement,
  normalizeSha1,
  parseCodesignDisplay,
  TRUSTED_SIGNER_SHA1,
} from "../desktop/code-signature.mjs";
import {
  CODESIGN,
  codesignArgs,
  collectSignTargets,
  compareSignatures,
  hookOptions,
  parseFindIdentity,
  parseKeychainList,
  pemForSha1,
  prepareP12Identity,
  runTool,
  SECURITY,
  signApp,
  signingMode,
  SUDO,
  verifyBundle,
} from "../scripts/sign-mac.mjs";
import { ADHOC_DISPLAY, CERT_SHA1, certDisplay, DER, DER_SHA1 } from "./helpers/codesign-fixtures.mjs";

async function tempDir(t, label) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `sc-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Records every tool call; `responses` maps "tool sub-command" to { stdout, stderr } or an Error. */
function recorder(responses = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === CODESIGN && args[0] === "-d" && String(args[1]).startsWith("--extract-certificates=")) {
      await writeFile(`${args[1].slice("--extract-certificates=".length)}0`, DER);
      return { stdout: "", stderr: "" };
    }
    const key = `${path.basename(command)} ${command === SUDO ? args[1] + " " + args[2] : args[0]}`;
    const response = typeof responses[key] === "function" ? responses[key](args) : responses[key];
    if (response instanceof Error) throw response;
    return { stdout: "", stderr: "", ...(response || {}) };
  };
  return { run, calls };
}

// ---------------------------------------------------------------------------
// codesign output

test("parseCodesignDisplay reads ad-hoc and certificate signatures", () => {
  const adhoc = parseCodesignDisplay(ADHOC_DISPLAY);
  assert.equal(adhoc.identifier, "dev.skillcontrol.desktop");
  assert.equal(adhoc.adhoc, true);
  assert.equal(adhoc.flags, "adhoc");
  assert.equal(adhoc.cdhash, "a53def63b68c67fab80392a01dc51b790bf64f1e");
  assert.equal(adhoc.designated, 'cdhash H"a53def63b68c67fab80392a01dc51b790bf64f1e"', "the implied requirement is a comment");
  assert.equal(isCdhashRequirement(adhoc.designated), true);
  assert.equal(hasCertificateSigner(adhoc), false);

  const signed = parseCodesignDisplay(certDisplay());
  assert.equal(signed.adhoc, false);
  assert.deepEqual(signed.authorities, ["Skill Control Code Signing (zifeixu85)"]);
  assert.equal(signed.teamIdentifier, null);
  assert.match(signed.designated, /^identifier "dev\.skillcontrol\.desktop" and certificate leaf = H"313a65ff/u);
  assert.equal(hasCertificateSigner(signed), true);

  const linkerSigned = parseCodesignDisplay("CodeDirectory v=20400 size=392 flags=0x20002(adhoc,linker-signed) hashes=9+0 location=embedded\n");
  assert.equal(linkerSigned.adhoc, true, "v0.2.0's linker signature counts as ad hoc");
  assert.equal(hasCertificateSigner(null), false);
  assert.equal(normalizeSha1("31:3a:65:ff:90:80:e4:47:21:6e:bc:2c:09:03:44:78:5d:26:52:b1"), CERT_SHA1);
  assert.equal(normalizeSha1("nope"), null);
  assert.ok(TRUSTED_SIGNER_SHA1.includes(CERT_SHA1));
});

// ---------------------------------------------------------------------------
// Mode

test("signingMode: p12 only in GitHub Actions, a keychain identity locally, ad hoc otherwise", () => {
  const p12 = { MAC_SIGN_P12_BASE64: "AAAA", MAC_SIGN_P12_PASSWORD: "pw" };
  assert.deepEqual(signingMode({}), { mode: "adhoc", identity: "-", required: false });
  assert.deepEqual(signingMode({ ...p12, GITHUB_ACTIONS: "true" }), { mode: "p12", required: false });
  assert.deepEqual(signingMode({ MAC_SIGN_IDENTITY: " Skill Control Code Signing (zifeixu85) " }), {
    mode: "identity",
    identity: "Skill Control Code Signing (zifeixu85)",
    required: false,
  });
  assert.throws(() => signingMode(p12), /只在 GitHub Actions/u, "never creates keychains or trust settings on a developer Mac");
  assert.throws(() => signingMode({ MAC_SIGN_P12_BASE64: "AAAA" }), /同时设置/u);
  assert.throws(() => signingMode({ MAC_SIGN_REQUIRED: "true" }), /MAC_SIGN_REQUIRED/u, "CI fails without the certificate");
  assert.throws(() => signingMode({ MAC_SIGN_REQUIRED: "true", MAC_SIGN_P12_BASE64: "", MAC_SIGN_P12_PASSWORD: "" }), /MAC_SIGN_REQUIRED/u);
  assert.equal(signingMode({ ...p12, GITHUB_ACTIONS: "true", MAC_SIGN_REQUIRED: "true" }).required, true);
});

// ---------------------------------------------------------------------------
// Inside-out order

const MACH_O = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]);
const FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]);

async function fakeApp(root) {
  const app = path.join(root, "Skill Control.app");
  const write = async (relative, content) => {
    await mkdir(path.dirname(path.join(app, relative)), { recursive: true });
    await writeFile(path.join(app, relative), content);
  };
  await write("Contents/MacOS/Skill Control", MACH_O);
  await write("Contents/Info.plist", "<plist/>");
  await write("Contents/Resources/app.asar", "asar");
  await write("Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework", FAT);
  await write("Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib", MACH_O);
  await write("Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler", MACH_O);
  await write("Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist", "<plist/>");
  await symlink("A", path.join(app, "Contents/Frameworks/Electron Framework.framework/Versions/Current"));
  await symlink("Versions/Current/Electron Framework", path.join(app, "Contents/Frameworks/Electron Framework.framework/Electron Framework"));
  await write("Contents/Frameworks/Skill Control Helper (Renderer).app/Contents/MacOS/Skill Control Helper (Renderer)", MACH_O);
  await write("Contents/Frameworks/Skill Control Helper (Renderer).app/Contents/Info.plist", "<plist/>");
  await write("Contents/_CodeSignature/CodeResources", "old seal");
  return app;
}

test("collectSignTargets signs nested code inside-out and never follows symlinks", async (t) => {
  const app = await fakeApp(await tempDir(t, "targets"));
  const targets = await collectSignTargets(app);
  const relative = targets.map((target) => [path.relative(app, target.path) || ".", target.kind]);
  const index = (name) => relative.findIndex(([item]) => item === name);
  assert.deepEqual(relative.at(-1), [".", "app"], "the app is signed last");
  assert.ok(index("Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib") < index("Contents/Frameworks/Electron Framework.framework"));
  assert.ok(index("Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler") < index("Contents/Frameworks/Electron Framework.framework"));
  assert.ok(
    index("Contents/Frameworks/Skill Control Helper (Renderer).app/Contents/MacOS/Skill Control Helper (Renderer)") <
      index("Contents/Frameworks/Skill Control Helper (Renderer).app"),
  );
  assert.equal(index("Contents/Resources/app.asar"), -1, "resources are sealed by the bundle, not signed one by one");
  assert.equal(index("Contents/Frameworks/Electron Framework.framework/Electron Framework"), -1, "symlinks are skipped");
  assert.equal(relative.filter(([, kind]) => kind === "bundle").length, 2);
  assert.ok(!relative.some(([item]) => item.includes("_CodeSignature")));
});

test("codesignArgs: entitlements for app bundles only, keychain and hardened runtime when asked", () => {
  const base = { identity: "-", entitlements: "/e/main.plist", entitlementsInherit: "/e/inherit.plist" };
  assert.deepEqual(codesignArgs({ ...base, target: { path: "/x/App.app", kind: "app" } }), [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    "--entitlements",
    "/e/main.plist",
    "/x/App.app",
  ]);
  assert.deepEqual(codesignArgs({ ...base, target: { path: "/x/Helper.app", kind: "bundle" } }).slice(-3), ["--entitlements", "/e/inherit.plist", "/x/Helper.app"]);
  assert.equal(codesignArgs({ ...base, target: { path: "/x/E.framework", kind: "bundle" } }).includes("--entitlements"), false);
  assert.equal(codesignArgs({ ...base, target: { path: "/x/lib.dylib", kind: "file" } }).includes("--entitlements"), false);
  const signed = codesignArgs({ ...base, identity: CERT_SHA1, keychain: "/k/signing.keychain-db", hardenedRuntime: true, target: { path: "/x/App.app", kind: "app" } });
  assert.deepEqual(signed.slice(0, 8), ["--force", "--sign", CERT_SHA1, "--timestamp=none", "--keychain", "/k/signing.keychain-db", "--options", "runtime"]);
});

// ---------------------------------------------------------------------------
// security output

test("parse find-identity, list-keychains and find-certificate output", () => {
  const untrusted = `Policy: Code Signing
  Matching identities
  1) ${CERT_SHA1} "Skill Control Code Signing (zifeixu85)" (CSSMERR_TP_NOT_TRUSTED)
     1 identities found

  Valid identities only
     0 valid identities found
`;
  assert.deepEqual(parseFindIdentity(untrusted), [{ sha1: CERT_SHA1, name: "Skill Control Code Signing (zifeixu85)", problem: "CSSMERR_TP_NOT_TRUSTED" }]);
  assert.deepEqual(parseFindIdentity(`  1) ${CERT_SHA1} "Name"\n     1 valid identities found\n`), [{ sha1: CERT_SHA1, name: "Name", problem: null }]);
  assert.deepEqual(parseKeychainList('    "/Users/runner/Library/Keychains/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n'), [
    "/Users/runner/Library/Keychains/login.keychain-db",
    "/Library/Keychains/System.keychain",
  ]);
  const listing = `SHA-256 hash: AB
SHA-1 hash: 0000000000000000000000000000000000000000
-----BEGIN CERTIFICATE-----
OTHER
-----END CERTIFICATE-----
SHA-256 hash: CD
SHA-1 hash: ${CERT_SHA1}
-----BEGIN CERTIFICATE-----
MINE
-----END CERTIFICATE-----
`;
  assert.equal(pemForSha1(listing, CERT_SHA1), "-----BEGIN CERTIFICATE-----\nMINE\n-----END CERTIFICATE-----\n");
  assert.equal(pemForSha1(listing, "1111111111111111111111111111111111111111"), null);
});

// ---------------------------------------------------------------------------
// p12 import (CI): exact commands, and everything is undone afterwards

const identityListing = (trusted) => ({
  stdout: trusted
    ? `  1) ${CERT_SHA1} "Skill Control Code Signing (zifeixu85)"\n     1 valid identities found\n`
    : "     0 valid identities found\n",
});

test("prepareP12Identity imports into a temp keychain, trusts the certificate and cleans up the keychain", async (t) => {
  const root = await tempDir(t, "p12");
  const pem = `SHA-1 hash: ${CERT_SHA1}\n-----BEGIN CERTIFICATE-----\nMINE\n-----END CERTIFICATE-----\n`;
  let trusted = false;
  const { run, calls } = recorder({
    "security list-keychains": (args) => (args.includes("-s") ? {} : { stdout: '    "/Users/runner/Library/Keychains/login.keychain-db"\n' }),
    "security find-identity": (args) =>
      args.includes("-v") ? identityListing(trusted) : { stdout: `  1) ${CERT_SHA1} "Skill Control Code Signing (zifeixu85)" (CSSMERR_TP_NOT_TRUSTED)\n` },
    "security find-certificate": { stdout: pem },
    [`sudo ${SECURITY} add-trusted-cert`]: () => ((trusted = true), {}),
  });
  const env = { MAC_SIGN_P12_BASE64: Buffer.alloc(512, 7).toString("base64"), MAC_SIGN_P12_PASSWORD: "p12-secret" };
  const logs = [];
  const prepared = await prepareP12Identity({ env, run, tempRoot: root, log: (line) => logs.push(line) });
  assert.equal(prepared.identity, CERT_SHA1);
  assert.match(prepared.keychain, /skill-control-sign-.+\/signing\.keychain-db$/u);
  assert.ok(prepared.keychain.startsWith(root), "the keychain lives in the temp folder");
  const names = calls.map((call) => (call[0] === SUDO ? `sudo ${path.basename(call[2])} ${call[3]}` : `${path.basename(call[0])} ${call[1]}`));
  assert.deepEqual(names, [
    "security list-keychains",
    "security create-keychain",
    "security set-keychain-settings",
    "security unlock-keychain",
    "security import",
    "security set-key-partition-list",
    "security list-keychains",
    "security find-identity",
    "security find-certificate",
    "security find-identity",
    "sudo security add-trusted-cert",
    "security find-identity",
  ]);
  const trust = calls.find((call) => call[0] === SUDO);
  assert.deepEqual(trust.slice(1, 9), ["-n", SECURITY, "add-trusted-cert", "-d", "-r", "trustRoot", "-p", "codeSign"]);
  const searchList = calls.find((call) => call[1] === "list-keychains" && call.includes("-s"));
  assert.deepEqual(searchList.slice(-2), [prepared.keychain, "/Users/runner/Library/Keychains/login.keychain-db"]);
  assert.ok(!logs.join("\n").includes("p12-secret"));

  calls.length = 0;
  await prepared.cleanup();
  const cleanup = calls.map((call) => (call[0] === SUDO ? call[3] : call[1]));
  // The trust setting stays: removing it waits for an authorization dialog on the runner.
  assert.deepEqual(cleanup, ["list-keychains", "delete-keychain"]);
  assert.deepEqual(calls[0].slice(-1), ["/Users/runner/Library/Keychains/login.keychain-db"], "the search list is restored");
  assert.deepEqual(await readdir(root), [], "the p12, keychain and certificate files are removed");

  // A second signing in the same job (the trust is already there) never asks sudo again.
  calls.length = 0;
  const again = await prepareP12Identity({ env, run, tempRoot: root, log() {} });
  assert.equal(again.identity, CERT_SHA1);
  assert.equal(calls.some((call) => call[0] === SUDO), false);
  await again.cleanup();
});

test("prepareP12Identity cleans up when the certificate cannot be trusted", async (t) => {
  const root = await tempDir(t, "p12-fail");
  const { run, calls } = recorder({
    "security list-keychains": (args) => (args.includes("-s") ? {} : { stdout: '"/k/login.keychain-db"\n' }),
    "security find-identity": (args) => ({
      stdout: args.includes("-v") ? "     0 valid identities found\n" : `  1) ${CERT_SHA1} "Name" (CSSMERR_TP_NOT_TRUSTED)\n`,
    }),
    "security find-certificate": { stdout: `SHA-1 hash: ${CERT_SHA1}\n-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n` },
  });
  await assert.rejects(
    prepareP12Identity({ env: { MAC_SIGN_P12_BASE64: Buffer.alloc(512).toString("base64"), MAC_SIGN_P12_PASSWORD: "pw" }, run, tempRoot: root, log() {} }),
    /信任设置没有生效/u,
  );
  assert.ok(calls.some((call) => call[1] === "delete-keychain"));
  assert.equal(calls.filter((call) => call[0] === SUDO).length, 1, "trusted once, never removed");
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(
    prepareP12Identity({ env: { MAC_SIGN_P12_BASE64: "c2hvcnQ=", MAC_SIGN_P12_PASSWORD: "pw" }, run, tempRoot: root, log() {} }),
    /不是有效的 p12/u,
  );
});

test("runTool errors never repeat the arguments (they can hold the p12 password)", async () => {
  await assert.rejects(runTool(process.execPath, ["-e", "process.stderr.write('bad things'); process.exit(3)", "secret-password"]), (error) => {
    assert.match(error.message, /bad things/u);
    assert.doesNotMatch(error.message, /secret-password/u);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Verify

test("verifyBundle checks the identifier, a certificate when required and its SHA-1", async (t) => {
  const root = await tempDir(t, "verify");
  const display = (text) => ({ "codesign -d": { stderr: text } });
  const quiet = { tempRoot: root, log() {} };

  const adhoc = await verifyBundle({ appPath: "/a.app", expectedIdentifier: "dev.skillcontrol.desktop", run: recorder(display(ADHOC_DISPLAY)).run, ...quiet });
  assert.equal(adhoc.leafSha1, null);
  await assert.rejects(
    verifyBundle({ appPath: "/a.app", expectedIdentifier: "dev.skillcontrol.desktop.test", run: recorder(display(ADHOC_DISPLAY)).run, ...quiet }),
    /签名标识/u,
  );
  await assert.rejects(verifyBundle({ appPath: "/a.app", requireCertificate: true, run: recorder(display(ADHOC_DISPLAY)).run, ...quiet }), /ad-hoc/u);
  // No secrets (forks, PRs): the SHA-1 pin alone never fails an ad-hoc build.
  assert.equal((await verifyBundle({ appPath: "/a.app", expectCertSha1: DER_SHA1, run: recorder(display(ADHOC_DISPLAY)).run, ...quiet })).leafSha1, null);
  await assert.rejects(
    verifyBundle({ appPath: "/a.app", expectCertSha1: DER_SHA1, requireCertificate: true, run: recorder(display(ADHOC_DISPLAY)).run, ...quiet }),
    /ad-hoc/u,
  );

  const signed = await verifyBundle({ appPath: "/a.app", requireCertificate: true, expectCertSha1: DER_SHA1.toLowerCase(), run: recorder(display(certDisplay())).run, ...quiet });
  assert.equal(signed.leafSha1, DER_SHA1);
  await assert.rejects(verifyBundle({ appPath: "/a.app", expectCertSha1: CERT_SHA1, run: recorder(display(certDisplay())).run, ...quiet }), /SHA-1/u);
  await assert.rejects(verifyBundle({ appPath: "/a.app", expectCertSha1: "xyz", run: recorder(display(certDisplay())).run, ...quiet }), /40 位/u);

  const broken = recorder({ "codesign --verify": new Error("a sealed resource is missing or invalid") });
  await assert.rejects(verifyBundle({ appPath: "/a.app", run: broken.run, ...quiet }), /sealed resource/u);
});

// ---------------------------------------------------------------------------
// signApp and the hook

test("signApp signs ad hoc by default and with the imported identity in CI, always cleaning up", async (t) => {
  const root = await tempDir(t, "sign");
  const app = await fakeApp(root);
  const adhoc = recorder({ "codesign -d": { stderr: ADHOC_DISPLAY } });
  const result = await signApp({ appPath: app, env: {}, expectedIdentifier: "dev.skillcontrol.desktop", run: adhoc.run, tempRoot: root, log() {} });
  assert.equal(result.adhoc, true);
  const signs = adhoc.calls.filter((call) => call[1] === "--force");
  assert.equal(signs.at(-1).at(-1), app);
  assert.ok(signs.every((call) => call[3] === "-"));

  let cleaned = 0;
  const prepare = async () => ({ identity: CERT_SHA1, keychain: "/k/signing.keychain-db", cleanup: async () => (cleaned += 1) });
  const ci = recorder({ "codesign -d": { stderr: certDisplay() } });
  const env = { GITHUB_ACTIONS: "true", MAC_SIGN_P12_BASE64: "AAAA", MAC_SIGN_P12_PASSWORD: "pw", MAC_SIGN_CERT_SHA1: DER_SHA1 };
  const signed = await signApp({ appPath: app, env, run: ci.run, tempRoot: root, log() {}, prepare });
  assert.equal(signed.leafSha1, DER_SHA1);
  assert.ok(ci.calls.filter((call) => call[1] === "--force").every((call) => call[3] === CERT_SHA1 && call.includes("/k/signing.keychain-db")));
  assert.equal(cleaned, 1);

  const failing = recorder({ "codesign --force": new Error("no identity found") });
  await assert.rejects(signApp({ appPath: app, env, run: failing.run, tempRoot: root, log() {}, prepare }), /no identity found/u);
  assert.equal(cleaned, 2, "the keychain is removed even when signing fails");
});

test("the afterPack hook signs only macOS packages, with the configured entitlements", () => {
  const packager = {
    config: {},
    projectDir: "/repo",
    platformSpecificBuildOptions: { entitlements: "resources/entitlements.mac.plist", hardenedRuntime: false },
    appInfo: { productFilename: "Skill Control", id: "dev.skillcontrol.desktop" },
  };
  assert.equal(hookOptions({ electronPlatformName: "linux", appOutDir: "/out", packager }), null);
  assert.deepEqual(hookOptions({ electronPlatformName: "darwin", appOutDir: "/out/mac-arm64", packager }), {
    appPath: "/out/mac-arm64/Skill Control.app",
    expectedIdentifier: "dev.skillcontrol.desktop",
    entitlements: "/repo/resources/entitlements.mac.plist",
    entitlementsInherit: "/repo/resources/entitlements.mac.plist",
    hardenedRuntime: false,
  });
  assert.throws(
    () => hookOptions({ electronPlatformName: "darwin", appOutDir: "/out", packager: { ...packager, config: { electronFuses: {} } } }),
    /electronFuses/u,
  );
});

test("compareSignatures: same certificate requirement across builds, different cdhash", () => {
  const first = parseCodesignDisplay(certDisplay({ cdhash: "1".repeat(40) }));
  const second = parseCodesignDisplay(certDisplay({ cdhash: "2".repeat(40) }));
  assert.deepEqual(compareSignatures(first, second), {
    designated: `identifier "dev.skillcontrol.desktop" and certificate leaf = H"${CERT_SHA1.toLowerCase()}"`,
    cdhashes: ["1".repeat(40), "2".repeat(40)],
  });
  const adhoc = parseCodesignDisplay(ADHOC_DISPLAY);
  assert.throws(() => compareSignatures(adhoc, adhoc), /ad-hoc/u, "an ad-hoc requirement is only a cdhash");
  assert.throws(() => compareSignatures(first, parseCodesignDisplay(certDisplay({ hash: "0".repeat(40) }))), /不一致/u);
  assert.throws(() => compareSignatures(first, first), /cdhash/u);
});

test("ad-hoc builds pass with only MAC_SIGN_CERT_SHA1 set; certificate builds must match it", async (t) => {
  const root = await tempDir(t, "sha1-pin");
  const app = await fakeApp(root);
  const env = { MAC_SIGN_CERT_SHA1: CERT_SHA1 };
  const adhoc = recorder({ "codesign -d": { stderr: ADHOC_DISPLAY } });
  assert.equal((await signApp({ appPath: app, env, run: adhoc.run, tempRoot: root, log() {} })).adhoc, true);
  await assert.rejects(signApp({ appPath: app, env: { ...env, MAC_SIGN_REQUIRED: "true" }, run: adhoc.run, tempRoot: root, log() {} }), /MAC_SIGN_REQUIRED/u);
  const prepare = async () => ({ identity: CERT_SHA1, keychain: "/k/kc", cleanup: async () => {} });
  const wrongCert = recorder({ "codesign -d": { stderr: certDisplay() } });
  await assert.rejects(
    signApp({ appPath: app, env: { ...env, GITHUB_ACTIONS: "true", MAC_SIGN_P12_BASE64: "AAAA", MAC_SIGN_P12_PASSWORD: "pw" }, run: wrongCert.run, tempRoot: root, log() {}, prepare }),
    /SHA-1/u,
    "the fixture certificate is not the pinned one",
  );
});
