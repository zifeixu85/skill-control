import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readInfoPlistXml } from "../desktop/app-update-core.mjs";
import { hasCertificateSigner, isCdhashRequirement, normalizeSha1, parseCodesignDisplay } from "../desktop/code-signature.mjs";

/**
 * macOS code signing for Skill Control.
 *
 * electron-builder runs this as its `afterPack` hook (electron-builder.yml). `mac.identity` is
 * null, so electron-builder signs nothing itself (and, having signed nothing, would skip an
 * afterSign hook); this script signs the bundle inside-out right after packing, before the
 * dmg and zip are built, then verifies it.
 *
 * Modes, from the environment:
 *   - MAC_SIGN_P12_BASE64 + MAC_SIGN_P12_PASSWORD in GitHub Actions (GITHUB_ACTIONS=true):
 *     import the certificate into a temporary keychain, trust it for code signing on the
 *     runner (codesign refuses an untrusted self-signed identity), sign, then remove the
 *     keychain, the search-list entry and the trust setting again.
 *   - MAC_SIGN_IDENTITY: an identity this Mac's keychains already trust (SHA-1 or name).
 *     Nothing is imported and no keychain or trust setting is touched.
 *   - neither: ad hoc ("-"), as in v0.2.1.
 * MAC_SIGN_REQUIRED=true turns a missing certificate into an error (release workflow flag).
 * MAC_SIGN_CERT_SHA1, when set, must equal the signing certificate's SHA-1.
 *
 * CLI (the release and signing-check workflows):
 *   node scripts/sign-mac.mjs sign <app>          sign an existing bundle the same way
 *   node scripts/sign-mac.mjs verify <app>...     verify, print the designated requirement
 *   node scripts/sign-mac.mjs compare <a> <b>     same requirement, different cdhash
 */

const execFile = promisify(execFileCallback);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CODESIGN = "/usr/bin/codesign";
export const SECURITY = "/usr/bin/security";
export const SUDO = "/usr/bin/sudo";
export const SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";
export const DEFAULT_ENTITLEMENTS = path.join(ROOT, "resources", "entitlements.mac.plist");
const NESTED_BUNDLES = new Set([".app", ".framework", ".xpc", ".appex", ".bundle", ".plugin"]);
const MACH_O_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

const truthy = (value) => value === "true" || value === "1";
const has = (value) => typeof value === "string" && value.trim() !== "";

/**
 * Runs a tool without a shell. Failures name the tool and its stderr, never the arguments
 * (they can hold the p12 password).
 */
export async function runTool(command, args, options = {}) {
  try {
    return await execFile(command, args, { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000, ...options });
  } catch (error) {
    const detail = String(error?.stderr || "").trim().split("\n").slice(-3).join(" ");
    throw new Error(`${path.basename(command)} ${args[0] || ""} 失败${detail ? `：${detail}` : ""}`, { cause: error?.code });
  }
}

// ---------------------------------------------------------------------------
// Mode

/** { mode: "p12" | "identity" | "adhoc", identity?, required }; throws when the settings conflict. */
export function signingMode(env = process.env) {
  const p12 = has(env.MAC_SIGN_P12_BASE64);
  const password = has(env.MAC_SIGN_P12_PASSWORD);
  const required = truthy(env.MAC_SIGN_REQUIRED);
  if (p12 !== password) throw new Error("MAC_SIGN_P12_BASE64 和 MAC_SIGN_P12_PASSWORD 要同时设置。");
  if (p12 && truthy(env.GITHUB_ACTIONS)) return { mode: "p12", required };
  if (has(env.MAC_SIGN_IDENTITY)) return { mode: "identity", identity: env.MAC_SIGN_IDENTITY.trim(), required };
  if (p12) {
    throw new Error(
      "用 p12 签名要创建临时钥匙串并信任证书，只在 GitHub Actions 里自动进行。本机请用 MAC_SIGN_IDENTITY 指定钥匙串里已信任的证书，或去掉 MAC_SIGN_P12_* 改用 ad-hoc 签名。",
    );
  }
  if (required) throw new Error("MAC_SIGN_REQUIRED 已开启，但没有签名证书（MAC_SIGN_P12_BASE64 / MAC_SIGN_P12_PASSWORD）。");
  return { mode: "adhoc", identity: "-", required };
}

// ---------------------------------------------------------------------------
// What to sign, inside-out

async function isMachO(file) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buffer, 0, 4, 0);
    return bytesRead === 4 && MACH_O_MAGIC.has(buffer.readUInt32BE(0));
  } finally {
    await handle.close();
  }
}

/**
 * Every Mach-O file and nested bundle inside `appPath`, deepest first (files before the
 * bundle that contains them), then the app itself. Symlinks are never followed.
 */
export async function collectSignTargets(appPath) {
  const targets = [];
  const walk = async (directory, depth) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === "_CodeSignature") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        if (NESTED_BUNDLES.has(path.extname(entry.name))) targets.push({ path: full, kind: "bundle", depth });
      } else if (entry.isFile() && (await isMachO(full))) {
        targets.push({ path: full, kind: "file", depth });
      }
    }
  };
  await walk(appPath, 1);
  targets.sort((left, right) => right.depth - left.depth || (left.kind === right.kind ? 0 : left.kind === "file" ? -1 : 1));
  return [...targets, { path: appPath, kind: "app", depth: 0 }];
}

/** codesign arguments for one target; app bundles get entitlements. */
export function codesignArgs({ target, identity, keychain = null, entitlements = null, entitlementsInherit = null, hardenedRuntime = false }) {
  const args = ["--force", "--sign", identity, "--timestamp=none"];
  if (keychain) args.push("--keychain", keychain);
  if (hardenedRuntime) args.push("--options", "runtime");
  const isApp = target.kind === "app" || (target.kind === "bundle" && target.path.endsWith(".app"));
  const plist = target.kind === "app" ? entitlements : entitlementsInherit;
  if (isApp && plist) args.push("--entitlements", plist);
  args.push(target.path);
  return args;
}

export async function signBundle({ appPath, identity, keychain = null, entitlements, entitlementsInherit, hardenedRuntime = false, run = runTool }) {
  const targets = await collectSignTargets(appPath);
  for (const target of targets) {
    await run(CODESIGN, codesignArgs({ target, identity, keychain, entitlements, entitlementsInherit, hardenedRuntime }));
  }
  return targets.length;
}

// ---------------------------------------------------------------------------
// Certificate from a p12 (CI only)

/** `security find-identity` lines → [{ sha1, name, problem }], one per identity. */
export function parseFindIdentity(text) {
  const identities = new Map();
  for (const line of String(text || "").split("\n")) {
    const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+?)"(?:\s+\((.+)\))?\s*$/u.exec(line);
    if (match && !identities.has(match[1])) identities.set(match[1], { sha1: match[1], name: match[2], problem: match[3] || null });
  }
  return [...identities.values()];
}

/** `security list-keychains` → the quoted keychain paths. */
export function parseKeychainList(text) {
  return [...String(text || "").matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

/** The PEM block that `security find-certificate -a -Z -p` prints after "SHA-1 hash: <sha1>". */
export function pemForSha1(text, sha1) {
  let current = null;
  let block = null;
  for (const line of String(text || "").split("\n")) {
    const hash = /^SHA-1 hash:\s*([0-9A-F]{40})\s*$/iu.exec(line.trim());
    if (hash) current = hash[1].toUpperCase();
    else if (line.startsWith("-----BEGIN CERTIFICATE-----")) block = [line];
    else if (block) {
      block.push(line);
      if (line.startsWith("-----END CERTIFICATE-----")) {
        if (current === sha1) return `${block.join("\n")}\n`;
        block = null;
      }
    }
  }
  return null;
}

/**
 * Imports MAC_SIGN_P12_BASE64 into a new keychain under `tempRoot`, puts it on the user search
 * list, trusts the certificate for code signing (passwordless sudo on GitHub's runners) and
 * returns the identity plus a cleanup that undoes all of it.
 */
export async function prepareP12Identity({ env, run = runTool, tempRoot = os.tmpdir(), log = console.info }) {
  const dir = await mkdtemp(path.join(tempRoot, "skill-control-sign-"));
  const keychain = path.join(dir, "signing.keychain-db");
  const keychainPassword = randomBytes(24).toString("hex");
  const steps = { created: false, listed: false, trusted: null };
  const previous = parseKeychainList((await run(SECURITY, ["list-keychains", "-d", "user"])).stdout);
  const cleanup = async () => {
    if (steps.trusted) await run(SUDO, ["-n", SECURITY, "remove-trusted-cert", "-d", steps.trusted]).catch(() => {});
    if (steps.listed) await run(SECURITY, ["list-keychains", "-d", "user", "-s", ...previous]).catch(() => {});
    if (steps.created) await run(SECURITY, ["delete-keychain", keychain]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  };
  try {
    const p12 = path.join(dir, "signing.p12");
    const bytes = Buffer.from(env.MAC_SIGN_P12_BASE64.trim(), "base64");
    if (bytes.length < 100) throw new Error("MAC_SIGN_P12_BASE64 不是有效的 p12 文件。");
    await writeFile(p12, bytes, { mode: 0o600 });
    await run(SECURITY, ["create-keychain", "-p", keychainPassword, keychain]);
    steps.created = true;
    await run(SECURITY, ["set-keychain-settings", "-lut", "21600", keychain]);
    await run(SECURITY, ["unlock-keychain", "-p", keychainPassword, keychain]);
    await run(SECURITY, ["import", p12, "-k", keychain, "-f", "pkcs12", "-P", env.MAC_SIGN_P12_PASSWORD, "-T", CODESIGN, "-T", SECURITY]);
    await run(SECURITY, ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychain]);
    await run(SECURITY, ["list-keychains", "-d", "user", "-s", keychain, ...previous.filter((item) => item !== keychain)]);
    steps.listed = true;
    const identities = parseFindIdentity((await run(SECURITY, ["find-identity", "-p", "codesigning", keychain])).stdout);
    if (identities.length !== 1) throw new Error(`p12 里应当正好有一个代码签名身份，找到 ${identities.length} 个。`);
    const [{ sha1, name }] = identities;
    const pem = pemForSha1((await run(SECURITY, ["find-certificate", "-a", "-Z", "-p", keychain])).stdout, sha1);
    if (!pem) throw new Error("没能从钥匙串导出签名证书。");
    const certificate = path.join(dir, "signing.pem");
    await writeFile(certificate, pem, { mode: 0o600 });
    await run(SUDO, ["-n", SECURITY, "add-trusted-cert", "-d", "-r", "trustRoot", "-p", "codeSign", "-k", SYSTEM_KEYCHAIN, certificate]);
    steps.trusted = certificate;
    const valid = parseFindIdentity((await run(SECURITY, ["find-identity", "-v", "-p", "codesigning", keychain])).stdout);
    if (!valid.some((identity) => identity.sha1 === sha1 && !identity.problem)) {
      throw new Error("证书已导入，但仍不能用来签名（信任设置没有生效）。");
    }
    log(`[sign-mac] 签名证书：${name}（SHA-1 ${sha1}）`);
    return { identity: sha1, keychain, sha1, name, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Verify

/** SHA-1 of the signing (leaf) certificate, or null for an ad-hoc signature. */
export async function leafSha1(appPath, { run = runTool, tempRoot = os.tmpdir() } = {}) {
  const dir = await mkdtemp(path.join(tempRoot, "skill-control-certs-"));
  try {
    const prefix = path.join(dir, "cert-");
    await run(CODESIGN, ["-d", `--extract-certificates=${prefix}`, appPath]);
    const der = await readFile(`${prefix}0`).catch(() => null);
    return der ? createHash("sha1").update(der).digest("hex").toUpperCase() : null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function readSignature(appPath, { run = runTool } = {}) {
  const { stdout = "", stderr = "" } = await run(CODESIGN, ["-d", "-r-", "--verbose=4", appPath]);
  return parseCodesignDisplay(`${stderr}\n${stdout}`);
}

/**
 * `codesign --verify --deep --strict`, then checks the identifier, that a certificate was used
 * when required, and the certificate SHA-1 when `expectCertSha1` is set and the build is
 * certificate-signed. The SHA-1 pin never fails an ad-hoc build (forks and PRs have no
 * signing secrets); forbidding ad hoc is `requireCertificate` (MAC_SIGN_REQUIRED).
 */
export async function verifyBundle({
  appPath,
  expectedIdentifier = null,
  requireCertificate = false,
  expectCertSha1 = null,
  run = runTool,
  tempRoot = os.tmpdir(),
  log = console.info,
}) {
  await run(CODESIGN, ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const info = await readSignature(appPath, { run });
  if (expectedIdentifier && info.identifier !== expectedIdentifier) {
    throw new Error(`签名标识是 ${info.identifier || "（无）"}，应为 ${expectedIdentifier}。`);
  }
  const expected = expectCertSha1 ? normalizeSha1(expectCertSha1) : null;
  if (expectCertSha1 && !expected) throw new Error("MAC_SIGN_CERT_SHA1 不是 40 位十六进制的 SHA-1。");
  const certificate = hasCertificateSigner(info);
  if (requireCertificate && !certificate) throw new Error(`${path.basename(appPath)} 仍是 ad-hoc 签名，没有用证书签名。`);
  if (expected && !certificate) log("[sign-mac]   ad-hoc 签名，不对照 MAC_SIGN_CERT_SHA1（要求证书签名请设置 MAC_SIGN_REQUIRED=true）");
  const sha1 = certificate ? await leafSha1(appPath, { run, tempRoot }) : null;
  if (expected && certificate && sha1 !== expected) throw new Error(`签名证书 SHA-1 是 ${sha1}，应为 ${expected}。`);
  log(`[sign-mac] ${appPath}`);
  log(`[sign-mac]   designated => ${info.designated || "（无）"}`);
  log(`[sign-mac]   cdhash ${info.cdhash || "（未知）"}${sha1 ? ` · 证书 SHA-1 ${sha1}` : " · ad-hoc"}`);
  return { ...info, leafSha1: sha1 };
}

// ---------------------------------------------------------------------------
// Sign (hook and CLI)

export async function signApp({
  appPath,
  env = process.env,
  expectedIdentifier = null,
  entitlements = DEFAULT_ENTITLEMENTS,
  entitlementsInherit = entitlements,
  hardenedRuntime = false,
  run = runTool,
  tempRoot = os.tmpdir(),
  log = console.info,
  prepare = prepareP12Identity,
}) {
  const plan = signingMode(env);
  const prepared = plan.mode === "p12" ? await prepare({ env, run, tempRoot, log }) : null;
  try {
    const identity = prepared ? prepared.identity : plan.identity;
    const count = await signBundle({ appPath, identity, keychain: prepared?.keychain || null, entitlements, entitlementsInherit, hardenedRuntime, run });
    log(`[sign-mac] 已签名 ${count} 项（${plan.mode === "adhoc" ? "ad-hoc" : "证书"}）`);
    return await verifyBundle({
      appPath,
      expectedIdentifier,
      requireCertificate: plan.mode !== "adhoc" || plan.required,
      expectCertSha1: has(env.MAC_SIGN_CERT_SHA1) ? env.MAC_SIGN_CERT_SHA1 : null,
      run,
      tempRoot,
      log,
    });
  } finally {
    await prepared?.cleanup();
  }
}

/** signApp options for an electron-builder afterPack context; null for other platforms. */
export function hookOptions(context) {
  if (context.electronPlatformName !== "darwin") return null;
  // Fuses are flipped after afterPack and would break the signature.
  if (context.packager.config?.electronFuses) {
    throw new Error("sign-mac：配置了 electronFuses 时要在翻转 fuses 之后签名，请先调整签名时机。");
  }
  const options = context.packager.platformSpecificBuildOptions || {};
  const resolve = (value) => (value ? path.resolve(context.packager.projectDir || ROOT, value) : null);
  const entitlements = resolve(options.entitlements) || DEFAULT_ENTITLEMENTS;
  return {
    appPath: path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
    expectedIdentifier: context.packager.appInfo.id,
    entitlements,
    entitlementsInherit: resolve(options.entitlementsInherit) || entitlements,
    hardenedRuntime: options.hardenedRuntime === true,
  };
}

/** electron-builder `afterPack` hook. */
export default async function afterPack(context) {
  const options = hookOptions(context);
  if (options) await signApp(options);
}

/**
 * Two signatures of the same app from different builds: the designated requirement must be a
 * real one (not an ad-hoc cdhash) and identical, while the cdhash differs.
 */
export function compareSignatures(left, right) {
  if (!left?.designated || isCdhashRequirement(left.designated)) {
    throw new Error("第一份应用没有证书签名的指定要求（ad-hoc 签名的指定要求只是 cdhash）。");
  }
  if (left.designated !== right?.designated) throw new Error("两份应用的指定要求（designated requirement）不一致。");
  if (!left.cdhash || !right.cdhash || left.cdhash === right.cdhash) throw new Error("两份应用的 cdhash 相同或缺失，没有比较出变化。");
  return { designated: left.designated, cdhashes: [left.cdhash, right.cdhash] };
}

// ---------------------------------------------------------------------------
// CLI

async function bundleIdentifier(appPath) {
  return readInfoPlistXml(await readFile(path.join(appPath, "Contents", "Info.plist"), "utf8")).CFBundleIdentifier || null;
}

async function main([command, ...apps]) {
  if (process.platform !== "darwin") throw new Error("只能在 macOS 上运行。");
  if (!apps.length) throw new Error("用法：node scripts/sign-mac.mjs sign|verify|compare <app>...");
  for (const app of apps) if (!(await lstat(app)).isDirectory()) throw new Error(`${app} 不是应用。`);
  if (command === "sign") {
    for (const app of apps) await signApp({ appPath: app, expectedIdentifier: await bundleIdentifier(app) });
  } else if (command === "verify") {
    for (const app of apps) {
      await verifyBundle({
        appPath: app,
        expectedIdentifier: await bundleIdentifier(app),
        requireCertificate: truthy(process.env.MAC_SIGN_REQUIRED),
        expectCertSha1: has(process.env.MAC_SIGN_CERT_SHA1) ? process.env.MAC_SIGN_CERT_SHA1 : null,
      });
    }
  } else if (command === "compare") {
    if (apps.length !== 2) throw new Error("compare 需要两个应用。");
    const [left, right] = await Promise.all(apps.map((app) => readSignature(app)));
    console.info(`[sign-mac] ${apps[0]}\n  designated => ${left.designated}\n  cdhash ${left.cdhash}`);
    console.info(`[sign-mac] ${apps[1]}\n  designated => ${right.designated}\n  cdhash ${right.cdhash}`);
    compareSignatures(left, right);
    console.info("[sign-mac] 指定要求一致，cdhash 不同：换版本后，按指定要求授予的权限仍然有效。");
  } else {
    throw new Error(`未知命令：${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[sign-mac] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
