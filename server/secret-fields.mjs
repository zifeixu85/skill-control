import { text } from "./fs-safe.mjs";

/**
 * Locates (never returns) literal secrets inside an MCP server definition. The result is
 * a list of field locations such as `headers.X-API-Key`, `env.TOKEN`, `args[2]`,
 * `url.userinfo` or `url.query.key`. Every check is linear: inputs are clamped and no
 * regex has nested or adjacent ambiguous quantifiers.
 */

const MAX_DEPTH = 4;
const MAX_FIELDS = 100;
const MAX_ENTRIES = 200;
const VALUE_LIMIT = 4_096;
const ARG_PARSE_LIMIT = 256;
const SECRET_GROUPS = new Set(["headers", "http_headers", "env", "environment"]);
// Values under these keys are environment variable NAMES or non-secret settings.
const NAME_ONLY_KEYS = /(?:_env_var|_env_vars|^env_vars|^env_http_headers|^command|^cwd|^type|^transport)$/iu;
const SECRET_WORDS = new Set([
  "key", "apikey", "token", "secret", "password", "passwd", "pwd", "cookie",
  "credential", "credentials", "bearer", "authorization", "auth", "session",
  "signature", "privatekey",
]);
// Bare `$NAME` must be upper-case so a literal such as "$ecretPass" is not mistaken for one.
const ENV_TOKEN = /\$\{env:[A-Za-z_]\w{0,127}\}|\$\{[A-Za-z_]\w{0,127}\}|\{env:[A-Za-z_]\w{0,127}\}|\$[A-Z_][A-Z0-9_]{0,127}(?![a-z])/gu;
const AUTH_SCHEME = /^(?:bearer|basic|token)[ \t]+/iu;
const TOKEN_PREFIXES = [
  "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "sk-", "sk_live_", "sk_test_",
  "rk_live_", "xoxb-", "xoxp-", "xoxa-", "xoxs-", "xapp-", "glpat-", "npm_", "hf_",
  "pypi-", "akia", "aiza",
];
const JWT_LIKE = /^eyJ[\w-]{5,2048}\.[\w-]{5,4096}\.[\w-]{0,2048}$/u;
const TOKEN_CHARSET = /^[\w+/=.~-]{24,512}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const URL_PREFIX = /^https?:\/\//iu;
const KEY_VALUE_ARG = /^([A-Za-z_][\w.-]{0,127})=/u;
const HEADER_ARG = /^([A-Za-z][A-Za-z0-9-]{1,63}):[ \t]*/u;
const HEADER_FLAGS = new Set(["-h", "--header", "--headers"]);
const ENV_FLAGS = new Set(["-e", "--env", "--environment"]);

/** True when the whole value is only environment references (optionally after a scheme). */
export function isEnvReference(value) {
  if (typeof value !== "string") return false;
  const stripped = value.trim().replace(AUTH_SCHEME, "");
  if (!stripped || stripped.length > 512) return false;
  ENV_TOKEN.lastIndex = 0;
  return ENV_TOKEN.test(stripped) && stripped.replace(ENV_TOKEN, "").trim() === "";
}

export function isLiteral(value) {
  return typeof value === "string" && value.trim() !== "" && !isEnvReference(value);
}

/** Splits camelCase, snake_case and kebab-case names into lowercase words. */
function nameWords(name) {
  return String(name)
    .slice(0, 128)
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

export function isSecretName(name) {
  const words = nameWords(name);
  return (
    words.some((word) => SECRET_WORDS.has(word)) ||
    words.join("").includes("apikey") ||
    words.join("").includes("accesstoken") ||
    words.join("").includes("clientsecret") ||
    words.join("").includes("privatekey")
  );
}

function entropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/** Value-shape heuristics for credentials that appear under innocuous names. */
export function looksSecret(rawValue) {
  if (typeof rawValue !== "string" || !isLiteral(rawValue)) return false;
  const value = rawValue.trim().slice(0, VALUE_LIMIT);
  if (/^(?:bearer|basic)[ \t]+\S/iu.test(value)) return true;
  const lower = value.toLowerCase();
  if (TOKEN_PREFIXES.some((prefix) => lower.startsWith(prefix) && value.length >= prefix.length + 8)) {
    return true;
  }
  if (JWT_LIKE.test(value)) return true;
  if (!TOKEN_CHARSET.test(value) || UUID.test(value)) return false;
  if (/^[/~.]/u.test(value) || (value.includes("/") && !value.endsWith("="))) return false;
  return /[a-z]/iu.test(value) && /\d/u.test(value) && entropy(value) >= 3.5;
}

function urlFindings(rawValue, location) {
  const value = rawValue.trim().slice(0, VALUE_LIMIT);
  if (!URL_PREFIX.test(value)) return [];
  let url;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  const findings = [];
  if (url.username || url.password) findings.push(`${location}.userinfo`);
  let index = 0;
  for (const [name, parameter] of url.searchParams) {
    if (index++ >= 50) break;
    if ((isSecretName(name) && isLiteral(parameter)) || looksSecret(parameter)) {
      findings.push(`${location}.query.${text(name, 64)}`);
    }
  }
  const segments = url.pathname.split("/").slice(0, 50);
  if (segments.some((segment) => segment.length >= 24 && looksSecret(decodeSafe(segment)))) {
    findings.push(`${location}.path`);
  }
  return findings;
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function argFindings(args) {
  const findings = [];
  const list = args.slice(0, MAX_ENTRIES);
  list.forEach((arg, index) => {
    if (typeof arg !== "string" || !arg.trim()) return;
    const location = `args[${index}]`;
    if (looksSecret(arg) || urlFindings(arg, location).length) {
      findings.push(location);
      return;
    }
    if (arg.length > ARG_PARSE_LIMIT) return;
    if (arg.startsWith("-")) {
      const separator = arg.indexOf("=");
      const flag = separator > 0 ? arg.slice(0, separator) : arg;
      if (!isSecretName(flag.replace(/^-+/u, ""))) return;
      if (separator > 0) {
        if (isLiteral(arg.slice(separator + 1))) findings.push(location);
      } else {
        const next = list[index + 1];
        if (typeof next === "string" && !next.startsWith("-") && isLiteral(next)) {
          findings.push(`args[${index + 1}]`);
        }
      }
      return;
    }
    const previous = String(list[index - 1] || "").toLowerCase();
    const keyValue = arg.match(KEY_VALUE_ARG);
    if (keyValue) {
      const assigned = arg.slice(keyValue[0].length);
      const secretContext = ENV_FLAGS.has(previous) || isSecretName(keyValue[1]);
      if ((secretContext && isLiteral(assigned)) || looksSecret(assigned)) {
        findings.push(location);
      }
      return;
    }
    const header = arg.match(HEADER_ARG);
    if (header) {
      const headerValue = arg.slice(header[0].length);
      const headerContext =
        HEADER_FLAGS.has(previous) || isSecretName(header[1]) || /^x-/iu.test(header[1]);
      if (headerContext && !/^[/\\]/u.test(headerValue) && isLiteral(headerValue)) {
        findings.push(location);
      }
    }
  });
  return findings;
}

/**
 * Classifies literal fields. `all` follows the conservative rule (every literal header or
 * env value counts); `likely` keeps only fields whose name or value shape indicates a
 * credential, which is what a UI should highlight.
 */
export function secretFieldReport(rawConfig) {
  const all = [];
  const likely = [];
  const add = (location, isLikely) => {
    if (all.length >= MAX_FIELDS) return;
    all.push(location);
    if (isLikely) likely.push(location);
  };
  function walk(value, location, key, depth, inSecretGroup) {
    if (all.length >= MAX_FIELDS || depth > MAX_DEPTH) return;
    if (typeof value === "string") {
      if (NAME_ONLY_KEYS.test(key)) return;
      const urls = urlFindings(value, location);
      if (urls.length) {
        urls.forEach((url) => add(url, true));
        return;
      }
      if (!isLiteral(value)) return;
      const likelySecret = isSecretName(key) || looksSecret(value);
      if (inSecretGroup || likelySecret) add(location, likelySecret);
      return;
    }
    if (Array.isArray(value)) {
      if (key === "args" && depth === 1) {
        argFindings(value).forEach((arg) => add(arg, true));
        return;
      }
      value.slice(0, MAX_ENTRIES).forEach((item, index) => {
        walk(item, `${location}[${index}]`, key, depth + 1, inSecretGroup);
      });
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value).slice(0, MAX_ENTRIES)) {
      if (NAME_ONLY_KEYS.test(childKey)) continue;
      const childLocation = location ? `${location}.${text(childKey, 64)}` : text(childKey, 64);
      walk(
        child,
        childLocation,
        childKey,
        depth + 1,
        inSecretGroup || SECRET_GROUPS.has(childKey.toLowerCase()),
      );
    }
  }
  walk(rawConfig, "", "", 0, false);
  const clean = (list) => [...new Set(list)].map((field) => text(field, 128));
  return { all: clean(all), likely: clean(likely) };
}

/** Returns the locations (never values) of literal secret-looking fields. */
export function secretFieldNames(rawConfig) {
  return secretFieldReport(rawConfig).all;
}
