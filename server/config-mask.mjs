import { compactHomeInText, MASK, scrubTokens } from "./fs-safe.mjs";
import { isEnvReference } from "./secret-fields.mjs";

export { MASK, scrubTokens };

/**
 * Default-deny masking for structured configuration shown by /api/config-detail.
 *
 * Key names are always shown. A scalar VALUE is shown only when it matches a safe class:
 * booleans, short integers, known enum words, pure environment references, hostnames,
 * URLs reduced to scheme + host + non-token path segments, local paths without
 * credential characters, identifiers under known identifier keys, and free text under
 * known descriptive keys (passed through the redactor). Everything else becomes MASK.
 * Secret-looking keys mask their whole subtree; command lines and argument lists are
 * tokenized so values that follow credential flags are masked.
 */

const STRING_LIMIT = 8_192;
const MAX_DEPTH = 10;
const MAX_ENTRIES = 300;

const SAFE_ENUMS = new Set([
  "debug", "info", "warn", "warning", "error", "trace", "fatal", "silent", "verbose",
  "production", "development", "test", "staging",
  "stdio", "http", "https", "sse", "streamable-http", "streamable_http", "streamablehttp", "ws",
  "never", "on-request", "on-failure", "untrusted",
  "danger-full-access", "workspace-write", "read-only",
  "minimal", "low", "medium", "high", "xhigh",
  "file", "keyring", "auto", "prompt", "approve", "deny", "allow", "ask",
  "default", "acceptedits", "plan", "bypasspermissions", "dontask",
  "user", "project", "local", "managed", "command", "agent", "team",
  "json", "text", "markdown", "dark", "light", "system", "none", "inherit", "all", "core",
  "true", "false", "on", "off", "yes", "no", "enabled", "disabled",
]);
// Values under these keys may be shown when they are plain, non-token identifiers.
const IDENTIFIER_KEYS = new Set([
  "model", "type", "transport", "name", "version", "scope", "category", "categoryid",
  "enabled", "provider", "default", "id", "agentname", "plugin", "expertype", "experttype",
  "language", "locale", "mode", "kind", "server", "tool", "event", "matcher", "role_id",
]);
// Values under these keys (and their children) are human text; shown after redaction.
const DESCRIPTIVE_KEYS = new Set([
  "description", "displayname", "shortdescription", "longdescription", "displaydescription",
  "profession", "license", "keywords", "tags", "category", "developername", "title", "label",
  "defaultprompt", "defaultinitprompt", "quickprompts", "capabilities", "role", "summary",
  "note", "notes", "zh", "en", "zh-cn",
]);
// Manifest-relative paths (skills, agents, icons …).
const PATH_KEYS = new Set([
  "skills", "agents", "commands", "hooks", "mcpservers", "apps", "avatar", "logo", "logodark",
  "composericon", "icon", "lspservers", "outputstyles", "screenshots", "cwd", "path",
  "profilepath", "working_dir", "external_dirs", "dir", "directory", "root",
]);
const LIST_OF_NAMES_KEYS = new Set([
  "enabled_tools", "disabled_tools", "includetools", "excludetools", "allowedtools", "tools", "scopes",
]);
const URL_KEYS = new Set(["url", "httpurl", "serverurl", "homepage", "repository", "websiteurl"]);
const VERSION_KEYS = new Set(["version"]);
const ARG_KEYS = /^(?:args|argv|arguments)$|_args$/iu;
const COMMAND_KEYS = /^(?:command|cmd|exec|run|script)$/iu;
const ENV_GROUPS = new Set(["env", "environment", "envs", "env_vars_values"]);
const NAME_ONLY_KEY = /(?:_env_var|_env_vars)$|^(?:env_vars|env_http_headers)$/iu;

const SECRET_SUBSTRINGS = [
  "secret", "token", "credential", "cookie", "session", "header", "password", "passwd",
  "passphrase", "private", "hmac", "creds", "apikey", "accesskey",
];
const SECRET_WORDS = new Set([
  "pass", "pwd", "pw", "pat", "dsn", "key", "keys", "salt", "cred", "sig", "signature", "oauth",
  "oauth2", "authz", "authn",
]);

const VALUE_FLAGS = new Set([
  "-e", "-p", "-u", "-h", "--user", "--pass", "--password", "--passphrase", "--token",
  "--api-key", "--apikey", "--key", "--secret", "--header", "--headers", "--env",
  "--environment", "--database-url", "--db-url", "--url", "--dsn", "--cookie", "--auth",
  "--connection-string", "--conn", "--client-secret",
]);
const ENV_FLAGS = new Set(["-e", "--env", "--environment"]);
const HEADER_FLAGS = new Set(["-h", "--header", "--headers"]);

/** camelCase / snake_case / kebab-case → lower-case words. */
function keyWords(key) {
  return String(key)
    .slice(0, 128)
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

export function isSecretKey(key) {
  const words = keyWords(key);
  const joined = words.join("");
  if (SECRET_SUBSTRINGS.some((part) => joined.includes(part))) return true;
  return words.some(
    (word) =>
      SECRET_WORDS.has(word) ||
      (word.startsWith("auth") && !/^authors?$/u.test(word)) ||
      word === "authorization",
  );
}

const lower = (key) => String(key).toLowerCase();

/** Long or mixed letter/digit runs without separators look like generated tokens. */
export function isTokenLike(part) {
  return (
    (part.length >= 8 && /[A-Za-z]/u.test(part) && /\d/u.test(part)) ||
    (part.length >= 24 && /^[A-Za-z0-9+/=_-]+$/u.test(part))
  );
}

const hasTokenLikePart = (value) => value.split(/[-._/+:@~*\\]+/u).some(isTokenLike);

function isPlainWord(value) {
  return (
    /^[\p{L}\p{N}@./~][\p{L}\p{N}@._/+~*:-]{0,127}$/u.test(value) &&
    !hasTokenLikePart(value) &&
    scrubTokens(value) === value
  );
}

function isIdentifier(value) {
  return /^[\p{L}\p{N}][\p{L}\p{N}._:/-]{0,63}$/u.test(value) && !hasTokenLikePart(value);
}

const isHostname = (value) =>
  value === "localhost" ||
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/iu.test(value);
const isHostPort = (value) => {
  const match = value.match(/^(.{1,253}):(\d{1,5})$/u);
  return Boolean(match) && isHostname(match[1]);
};
const isInteger = (value) => /^-?\d{1,6}$/u.test(value);
const isColor = (value) => /^#[0-9a-f]{3,8}$/iu.test(value);
const URL_PATTERN = /^([a-z][a-z0-9+.-]{1,31}):\/\/(.*)$/isu;

/** Any scheme://…: userinfo, query, fragment, ;params and token-like path segments masked. */
export function maskAnyUrl(rawValue) {
  const value = String(rawValue).trim().slice(0, STRING_LIMIT);
  const match = value.match(URL_PATTERN);
  if (!match) return MASK;
  const scheme = match[1].toLowerCase();
  const rest = match[2];
  const authorityEnd = rest.search(/[/?#;]/u);
  const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
  const remainder = authorityEnd < 0 ? "" : rest.slice(authorityEnd);
  const at = authority.lastIndexOf("@");
  const hostPart = at >= 0 ? authority.slice(at + 1) : authority;
  const bareHost = hostPart.replace(/:\d{1,5}$/u, "");
  const host =
    isHostname(bareHost) ||
    (/^[a-z0-9-]{1,63}$/iu.test(bareHost) && !isTokenLike(bareHost)) ||
    /^\[[0-9a-f:.]{2,45}\](?::\d{1,5})?$/iu.test(hostPart)
      ? hostPart
      : MASK;
  const pathEnd = remainder.search(/[?#]/u);
  const pathPart = (pathEnd < 0 ? remainder : remainder.slice(0, pathEnd)).split(";")[0];
  const segments = pathPart
    .split("/")
    .slice(0, 64)
    .map((segment) => {
      if (!segment) return segment;
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        return MASK;
      }
      return /^[A-Za-z0-9._~-]{1,64}$/u.test(decoded) && !hasTokenLikePart(decoded) ? segment : MASK;
    });
  const query = /[?]/u.test(remainder) ? `?${MASK}` : "";
  const fragment = /#/u.test(remainder) ? `#${MASK}` : "";
  const hadParams = pathPart !== (pathEnd < 0 ? remainder : remainder.slice(0, pathEnd));
  return `${scheme}://${at >= 0 ? `${MASK}@` : ""}${host}${segments.join("/")}${hadParams ? `;${MASK}` : ""}${query}${fragment}`;
}

const isUrlLike = (value) => URL_PATTERN.test(String(value).trim());

/** Absolute, ~/ or Windows paths without credential characters; token-like segments masked. */
function maskPath(value, { relative = false } = {}) {
  const windows = value.match(/^([A-Za-z]:)([\\/].*)$/u);
  const body = windows ? windows[2] : value;
  const absolute = windows || value.startsWith("/") || value.startsWith("~/") || value === "~";
  const relativeOk = relative && /^(?:\.{1,2}\/|[\w@-])/u.test(value) && !value.includes("..");
  if (!absolute && !relativeOk) return null;
  if (/[@=?:]/u.test(body) || /["'`$<>|;&\n\r\t]/u.test(body)) return null;
  const masked = body
    .split(/([\\/])/u)
    .map((segment) => (segment === "/" || segment === "\\" || !isTokenLike(segment) ? segment : MASK))
    .join("");
  return `${windows ? windows[1] : ""}${masked}`;
}

/** Classifies one scalar string. Returns the value to show (possibly partly masked). */
function maskString(raw, context, homes) {
  const value = String(raw).slice(0, STRING_LIMIT);
  if (context.secret) return isEnvReference(value) ? value : MASK;
  if (context.names) return /^[A-Z_][A-Z0-9_]{0,127}$/u.test(value) ? value : MASK;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (isEnvReference(trimmed)) return trimmed;
  if (context.descriptive) return scrubTokens(compactHomeInText(value, homes));
  if (/^(?:true|false)$/iu.test(trimmed) || isInteger(trimmed) || isColor(trimmed)) return trimmed;
  if (SAFE_ENUMS.has(trimmed.toLowerCase())) return trimmed;
  if (isUrlLike(trimmed)) return maskAnyUrl(trimmed);
  const key = lower(context.key);
  const pathValue = maskPath(compactHomeInText(trimmed, homes), { relative: PATH_KEYS.has(key) });
  if (pathValue !== null) return pathValue;
  if (isHostname(trimmed) || isHostPort(trimmed)) return trimmed;
  if (COMMAND_KEYS.test(key)) return maskCommandLine(trimmed, homes);
  if (VERSION_KEYS.has(key) && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(trimmed)) return trimmed;
  if ((IDENTIFIER_KEYS.has(key) || context.nameList) && isIdentifier(trimmed)) return trimmed;
  return MASK;
}

// ---------------------------------------------------------------------------
// Command lines and argument lists

/** Splits on whitespace, honouring simple '…' and "…" quotes. */
export function tokenizeCommand(value) {
  const tokens = [];
  let current = "";
  let quote = null;
  let quoted = false;
  const input = String(value).slice(0, STRING_LIMIT);
  for (const character of input) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      quoted = true;
    } else if (/\s/u.test(character)) {
      if (current || quoted) tokens.push({ value: current, quoted });
      current = "";
      quoted = false;
    } else {
      current += character;
    }
  }
  if (current || quoted) tokens.push({ value: current, quoted });
  return tokens;
}

const secretFlag = (flag) => VALUE_FLAGS.has(flag.toLowerCase()) || isSecretKey(flag.replace(/^-+/u, ""));

function maskHeaderLike(value) {
  const header = value.match(/^([A-Za-z][A-Za-z0-9_-]{0,63}):\s*([\s\S]*)$/u);
  return header ? `${header[1]}: ${isEnvReference(header[2]) ? header[2] : MASK}` : MASK;
}

function maskAssignment(token, homes, { forceMask = false } = {}) {
  const match = token.match(/^([A-Za-z_][A-Za-z0-9_.-]{0,127})=([\s\S]*)$/u);
  if (!match) return null;
  const [, name, assigned] = match;
  if (forceMask || isSecretKey(name)) return `${name}=${isEnvReference(assigned) ? assigned : MASK}`;
  return `${name}=${maskString(assigned, { env: true, key: name }, homes)}`;
}

/** Masks a sequence of shell-like tokens; state (value-taking flags) carries across. */
function maskTokenSequence(tokens, homes) {
  const output = [];
  let pending = null;
  for (const rawToken of tokens) {
    const token = rawToken.slice(0, STRING_LIMIT);
    if (pending) {
      const mode = pending;
      pending = null;
      if (mode === "header") output.push(maskHeaderLike(token));
      else if (mode === "env") output.push(maskAssignment(token, homes, { forceMask: true }) || MASK);
      else output.push(isEnvReference(token) ? token : MASK);
      continue;
    }
    if (/^-{1,2}[A-Za-z0-9]/u.test(token)) {
      const equals = token.indexOf("=");
      if (equals > 0) {
        const flag = token.slice(0, equals);
        const value = token.slice(equals + 1);
        const lowerFlag = flag.toLowerCase();
        if (ENV_FLAGS.has(lowerFlag)) output.push(`${flag}=${maskAssignment(value, homes, { forceMask: true }) || MASK}`);
        else if (HEADER_FLAGS.has(lowerFlag)) output.push(`${flag}=${maskHeaderLike(value)}`);
        else if (secretFlag(flag)) output.push(`${flag}=${isEnvReference(value) ? value : MASK}`);
        else output.push(`${flag}=${maskArgToken(value, homes)}`);
        continue;
      }
      const glued = token.match(/^-([epuH])(.+)$/u);
      if (glued) {
        const value = glued[2];
        if (glued[1] === "e") output.push(`-e${maskAssignment(value, homes, { forceMask: true }) || MASK}`);
        else if (glued[1] === "H") output.push(`-H${maskHeaderLike(value)}`);
        else output.push(`-${glued[1]}${MASK}`);
        continue;
      }
      const lowerFlag = token.toLowerCase();
      if (ENV_FLAGS.has(lowerFlag)) pending = "env";
      else if (HEADER_FLAGS.has(lowerFlag)) pending = "header";
      else if (secretFlag(token)) pending = "value";
      output.push(isPlainWord(token.replace(/^-+/u, "")) ? token : MASK);
      continue;
    }
    output.push(maskArgToken(token, homes));
  }
  return output;
}

/** One argument without flag context. */
function maskArgToken(token, homes) {
  if (!token) return token;
  if (isEnvReference(token)) return token;
  const assignment = maskAssignment(token, homes);
  if (assignment) return assignment;
  if (isUrlLike(token)) return maskAnyUrl(token);
  const pathValue = maskPath(compactHomeInText(token, homes), { relative: true });
  if (pathValue !== null) return pathValue;
  const pair = token.match(/^([A-Za-z][A-Za-z0-9_-]{0,63}):\s*([\s\S]+)$/u);
  if (pair && !pair[2].startsWith("//")) {
    const [, name, value] = pair;
    if (isSecretKey(name) || /\s/u.test(token)) return `${name}: ${isEnvReference(value) ? value : MASK}`;
    if (isInteger(value) || isHostname(value) || isPlainWord(value)) return token;
    return `${name}:${MASK}`;
  }
  if (isInteger(token) || isHostname(token) || isHostPort(token) || SAFE_ENUMS.has(token.toLowerCase())) return token;
  return isPlainWord(token) ? token : MASK;
}

function renderTokens(original, masked) {
  return masked
    .map((value, index) => (original[index]?.quoted || /\s/u.test(value) ? `'${value}'` : value))
    .join(" ");
}

/**
 * Masks a command line string such as "npx -y pkg --token X" or "TOKEN=x node srv.js".
 * NAME=value assignments anywhere in a command line are masked unconditionally.
 */
export function maskCommandLine(value, homes = []) {
  const tokens = tokenizeCommand(value);
  const values = tokens.map((token) => token.value);
  const masked = maskTokenSequence(values, homes).map((token, index) =>
    /^[A-Za-z_]\w*=/u.test(values[index]) && !/^-/u.test(values[index])
      ? maskAssignment(values[index], homes, { forceMask: true })
      : token,
  );
  return renderTokens(tokens, masked);
}

/** Masks an argv array; elements that contain spaces are tokenized as well. */
export function maskArgs(values, homes = []) {
  const list = values.slice(0, MAX_ENTRIES);
  const flat = [];
  const shape = [];
  for (const element of list) {
    if (typeof element !== "string") {
      shape.push({ type: "raw", value: element });
      continue;
    }
    const header = element.match(/^([A-Za-z][A-Za-z0-9_-]{0,63}):\s+\S/u);
    if (header && !/^[A-Za-z]:[\\/]/u.test(element)) {
      flat.push(element);
      shape.push({ type: "header", index: flat.length - 1 });
      continue;
    }
    if (/\s/u.test(element.trim()) && !/^--?[A-Za-z][\w-]{0,63}=/u.test(element)) {
      const tokens = tokenizeCommand(element);
      const start = flat.length;
      flat.push(...tokens.map((token) => token.value));
      shape.push({ type: "tokens", start, tokens });
      continue;
    }
    flat.push(element);
    shape.push({ type: "single", index: flat.length - 1 });
  }
  const masked = maskTokenSequence(flat, homes);
  return shape.map((item) => {
    if (item.type === "raw") return typeof item.value === "number" || typeof item.value === "boolean" ? item.value : MASK;
    if (item.type === "header") {
      const previous = flat[item.index - 1]?.toLowerCase();
      return HEADER_FLAGS.has(previous) ? masked[item.index] : maskHeaderLike(flat[item.index]);
    }
    if (item.type === "single") return masked[item.index];
    const slice = masked.slice(item.start, item.start + item.tokens.length).map((token, index) =>
      /^[A-Za-z_]\w*=/u.test(item.tokens[index].value)
        ? maskAssignment(item.tokens[index].value, homes, { forceMask: true })
        : token,
    );
    return renderTokens(item.tokens, slice);
  });
}

// ---------------------------------------------------------------------------
// Deep walker

function childContext(parent, key) {
  const name = lower(key);
  if (parent.secret) return { ...parent, key };
  if (parent.names || NAME_ONLY_KEY.test(key)) return { names: true, key };
  if (isSecretKey(key)) return { secret: true, key };
  if (ENV_GROUPS.has(name)) return { env: true, key };
  if (DESCRIPTIVE_KEYS.has(name) || (parent.key && lower(parent.key) === "author" && name === "name")) {
    return { descriptive: true, key };
  }
  return { env: parent.env, names: parent.names, descriptive: parent.descriptive, nameList: LIST_OF_NAMES_KEYS.has(name), key };
}

function maskNode(value, context, homes, depth) {
  if (depth > MAX_DEPTH) return MASK;
  if (value === null || value === undefined || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return !context.secret && Number.isInteger(value) && Math.abs(value) < 1_000_000 ? value : MASK;
  }
  if (typeof value === "string") {
    if (!context.secret && !context.env && !context.names && URL_KEYS.has(lower(context.key)) && isUrlLike(value)) {
      return maskAnyUrl(value);
    }
    return maskString(value, context, homes);
  }
  if (value instanceof Date) return context.secret ? MASK : value.toISOString();
  if (Array.isArray(value)) {
    if (!context.secret && !context.names && !context.descriptive && ARG_KEYS.test(lower(context.key))) {
      return maskArgs(value, homes);
    }
    if (context.env && !context.secret) {
      return value.slice(0, MAX_ENTRIES).map((item) =>
        typeof item === "string" ? maskAssignment(item, homes, { forceMask: false }) || maskString(item, context, homes) : maskNode(item, context, homes, depth + 1),
      );
    }
    return value.slice(0, MAX_ENTRIES).map((item) => maskNode(item, context, homes, depth + 1));
  }
  if (typeof value !== "object") return MASK;
  const result = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_ENTRIES)) {
    result[key] = maskNode(child, childContext(context, key), homes, depth + 1);
  }
  return result;
}

/** Deep, default-deny masked copy of any structured configuration value. */
export function maskConfig(value, { homes = [], key = "" } = {}) {
  return maskNode(value, { key }, homes, 0);
}

/** One MCP server definition (any agent's format). */
export function maskServerConfig(config, options = {}) {
  return maskConfig(config, options);
}

/** A single identifier (model, provider …): shown only when plain and not token-like. */
export function safeIdentifier(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  return isIdentifier(value.trim()) ? value.trim() : MASK;
}

/** Backwards-compatible name: URLs are reduced the same way everywhere. */
export const maskUrl = maskAnyUrl;
