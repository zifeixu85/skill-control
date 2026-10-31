/**
 * Pure helpers for macOS code signatures, shared by the build-time signing hook
 * (scripts/sign-mac.mjs) and the in-app updater (desktop/app-update-mac.mjs).
 */

/**
 * Leaf certificate SHA-1s an installed copy accepts for an update even when the new
 * bundle does not satisfy the running copy's designated requirement. Add the next
 * certificate here one release before rotating (docs/RELEASING.md, "轮换证书").
 */
export const TRUSTED_SIGNER_SHA1 = Object.freeze(["313A65FF9080E447216EBC2C090344785D2652B1"]);

/** "31:3a:65 …" or "313a65…" → "313A65…"; null unless it is 40 hex digits. */
export function normalizeSha1(value) {
  if (typeof value !== "string") return null;
  const hex = value.replace(/[\s:]/gu, "").toUpperCase();
  return /^[0-9A-F]{40}$/u.test(hex) ? hex : null;
}

/**
 * `codesign -d -r- --verbose=4 <app>` (stderr and stdout together) →
 * { identifier, adhoc, flags, authorities, teamIdentifier, cdhash, designated }.
 * An ad-hoc signature has no explicit designated requirement: codesign prints the implied
 * one as a comment ("# designated => cdhash H\"…\""), which is kept as `designated`.
 */
export function parseCodesignDisplay(text) {
  const info = {
    identifier: null,
    adhoc: false,
    flags: null,
    authorities: [],
    teamIdentifier: null,
    cdhash: null,
    designated: null,
  };
  for (const raw of String(text || "").split(/\r?\n/u)) {
    const line = raw.trim();
    let match;
    if ((match = /^Identifier=(.+)$/u.exec(line))) info.identifier = match[1].trim();
    else if (line === "Signature=adhoc") info.adhoc = true;
    else if ((match = /^Authority=(.+)$/u.exec(line))) info.authorities.push(match[1].trim());
    else if ((match = /^TeamIdentifier=(.+)$/u.exec(line))) {
      info.teamIdentifier = match[1].trim() === "not set" ? null : match[1].trim();
    } else if ((match = /^CDHash=([0-9a-f]{40,64})$/iu.exec(line))) info.cdhash = match[1].toLowerCase();
    else if ((match = /^#?\s*designated\s*=>\s*(.+)$/u.exec(line))) info.designated = match[1].trim();
    else if ((match = /\bflags=0x[0-9a-f]+\(([^)]*)\)/iu.exec(line)) && line.startsWith("CodeDirectory")) {
      info.flags = match[1];
      if (/(^|,)adhoc(,|$)/u.test(match[1])) info.adhoc = true;
    }
  }
  return info;
}

/** An ad-hoc signature's only requirement is its own cdhash, which changes with every build. */
export const isCdhashRequirement = (requirement) =>
  typeof requirement === "string" && /^cdhash\s+H"[0-9a-f]+"$/iu.test(requirement.trim());

/** True when the signature names a signer (a certificate), so its requirement is worth enforcing. */
export function hasCertificateSigner(info) {
  return Boolean(
    info &&
      !info.adhoc &&
      info.authorities.length > 0 &&
      typeof info.designated === "string" &&
      info.designated &&
      !isCdhashRequirement(info.designated),
  );
}
