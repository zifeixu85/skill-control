import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { readYamlFile } from "./config-files.mjs";
import { compactHomePath, homeVariants, object, readBoundedJson, readBoundedText, text } from "./fs-safe.mjs";
import { readMcpSources } from "./mcp-inventory.mjs";
import { resolveRaccoonInstall } from "./office-raccoon.mjs";
import { resolveOpenClawInstall } from "./openclaw.mjs";
import { isEnvReference, isLiteral, isSecretName, secretFieldReport } from "./secret-fields.mjs";

/**
 * GET /api/secrets: which services' credentials are kept where, by whom, and whether they
 * changed. Values never leave the parsers below: each one is classified (plaintext /
 * env-ref / keychain / credential-file / oauth) and, when at least 16 characters long,
 * reduced to an 8-hex-digit HMAC-SHA256 fingerprint with a random local salt
 * (~/.agent-skill-manager/secret-salt, 0600) that only tells "changed or not". The macOS
 * keychain is never read; tools that keep their secret there are noted. The change
 * snapshot keeps ids, key names and fingerprints only.
 */

const CONFIG_LIMIT = 2_000_000;
const CLAUDE_STATE_LIMIT = 30_000_000;
const LINE_FILE_LIMIT = 512_000;
const ITEM_LIMIT = 2_000;
const SKILL_DIR_LIMIT = 3_000;
const CHANGE_LIMIT = 200;
const MAX_DEPTH = 6;
const FINGERPRINT_MIN = 16;
// Same rule as the config masker: a name field holds an upper-case variable name; anything
// else there is treated as a value someone pasted into it.
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const SECRET_GROUPS = new Set(["env", "headers", "http_headers", "environment"]);
export const STORAGE_TYPES = ["plaintext", "env-ref", "keychain", "credential-file", "oauth"];

/** Service names for common key prefixes and hosts (best effort, for grouping). */
const SERVICES = [
  [/openai/iu, "OpenAI"], [/anthropic|claude/iu, "Anthropic"], [/github|^gh[_-]|\bgh\b/iu, "GitHub"], [/gemini|google|gcp/iu, "Google"],
  [/azure/iu, "Azure"], [/aws|amazon/iu, "AWS"], [/slack/iu, "Slack"], [/notion/iu, "Notion"], [/stripe/iu, "Stripe"],
  [/feishu|lark/iu, "飞书"], [/deepseek/iu, "DeepSeek"], [/moonshot|kimi/iu, "Kimi"], [/zhipu|glm|bigmodel/iu, "智谱"],
  [/dashscope|qwen|aliyun|alibaba/iu, "阿里云"], [/tavily/iu, "Tavily"], [/brave/iu, "Brave"], [/serp/iu, "SerpAPI"],
  [/firecrawl/iu, "Firecrawl"], [/\bexa\b|exa_/iu, "Exa"], [/supabase/iu, "Supabase"], [/postgres|database_url|pg_/iu, "PostgreSQL"],
  [/redis/iu, "Redis"], [/mongo/iu, "MongoDB"], [/cloudflare|\bcf_/iu, "Cloudflare"], [/vercel/iu, "Vercel"],
  [/huggingface|^hf_/iu, "Hugging Face"], [/replicate/iu, "Replicate"], [/elevenlabs/iu, "ElevenLabs"], [/minimax/iu, "MiniMax"],
  [/openrouter/iu, "OpenRouter"], [/groq/iu, "Groq"], [/mistral/iu, "Mistral"], [/xai|grok/iu, "xAI"], [/telegram/iu, "Telegram"],
  [/discord/iu, "Discord"], [/wechat|weixin/iu, "微信"], [/dingtalk/iu, "钉钉"], [/npm/iu, "npm"], [/docker/iu, "Docker"],
  [/figma/iu, "Figma"], [/linear/iu, "Linear"], [/jira|atlassian/iu, "Atlassian"], [/sentry/iu, "Sentry"], [/volc|doubao|ark_/iu, "火山引擎"],
];

/** A service name from key names, hosts or tool names; else `fallback` (the MCP or product). */
export function guessService(hints, fallback = null) {
  for (const hint of hints.filter(Boolean)) {
    const found = SERVICES.find(([pattern]) => pattern.test(String(hint)));
    if (found) return found[1];
  }
  return text(String(fallback || hints.find(Boolean) || "未知服务"), 60);
}

/** Words that make a secret-sounding name a setting (session patterns, token timeouts …). */
const SETTING_WORDS = /(?:^|_)(?:patterns?|timeout|ttl|mode|policy|path|dir|file|url|endpoint|domain|type|kind|format|enabled|count|limit|lifetime|seconds|ms|debug|level|id|source|provider|name|header|prefix|scope|region|version)(?:_|$)/iu;
const strongSecretName = (key) => isSecretName(key) && !SETTING_WORDS.test(String(key).replace(/([a-z0-9])([A-Z])/gu, "$1_$2"));
const TOKEN_SHAPE = /^(?:(?:bearer|basic)\s+\S{8,}|(?:sk-|sk_live_|sk_test_|ghp_|gho_|ghs_|github_pat_|xox[abps]-|glpat-|npm_|hf_|AKIA|AIza)\S{8,}|eyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{0,})/u;

/** The salt for fingerprints; created once with 0600 permissions. */
async function loadSalt(stateDirectory) {
  const file = path.join(stateDirectory, "secret-salt");
  try {
    const value = (await readFile(file, "utf8")).trim();
    if (/^[a-f0-9]{64}$/u.test(value)) return value;
  } catch {
    // Created below.
  }
  const salt = randomBytes(32).toString("hex");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(file, `${salt}\n`, { encoding: "utf8", mode: 0o600 });
  return salt;
}

/**
 * The only place a value is looked at: returns its storage kind and fingerprint. The value
 * itself is dropped here.
 */
function classify(value, salt, { literal = "plaintext", fingerprint = true } = {}) {
  if (typeof value !== "string" || !value.trim()) return null;
  if (isEnvReference(value)) return { storage: "env-ref" };
  if (!isLiteral(value)) return null;
  const trimmed = value.trim();
  return {
    storage: literal,
    ...(fingerprint && trimmed.length >= FINGERPRINT_MIN ? { fingerprint: createHmac("sha256", salt).update(trimmed).digest("hex").slice(0, 8) } : {}),
  };
}

const itemId = (...parts) => createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 16);

function createCollector(context) {
  const items = new Map();
  return {
    items,
    add({ file, keyPath, keyName, service, storage, fingerprint = null, agents = [], usedBy = [], modifiedAt = null, note = null }) {
      if (items.size >= ITEM_LIMIT || !storage) return;
      const location = `${context.display(file)}${keyPath ? ` · ${keyPath}` : ""}`;
      const id = itemId(location, keyName);
      const existing = items.get(id);
      if (existing) {
        for (const agent of agents) if (!existing.agents.includes(agent)) existing.agents.push(agent);
        for (const user of usedBy) if (!existing.usedBy.some((item) => item.kind === user.kind && item.name === user.name)) existing.usedBy.push(user);
        return;
      }
      items.set(id, {
        id,
        service: text(service, 60) || "未知服务",
        keyName: text(keyName, 120),
        location: text(location, 400),
        storage,
        agents: [...agents],
        usedBy: [...usedBy],
        ...(fingerprint ? { fingerprint } : {}),
        modifiedAt,
        ...(note ? { note } : {}),
      });
    },
  };
}

const fileTime = async (file) => {
  const info = await stat(file).catch(() => null);
  return info ? new Date(info.mtimeMs).toISOString() : null;
};

// ---------------------------------------------------------------------------
// Structured configuration (JSON / TOML / YAML)

/**
 * Secret-looking string fields of a parsed object: secret-named keys, values that look like
 * credentials, and anything under env / headers. `*_env_var` and `env_http_headers` name
 * environment variables (env-ref). Calls `found(keyPath, keyName, classification)`.
 */
const plausibleSecret = (value) => {
  const trimmed = value.trim();
  return trimmed.length >= 8 && !/\s/u.test(trimmed) && !/^(?:[/~.]|https?:\/\/)/iu.test(trimmed) && !/^(?:true|false|null|none|default|auto)$/iu.test(trimmed);
};

function walkObject(value, { salt, found, keyPath = "", key = "", depth = 0, inGroup = false }) {
  if (depth > MAX_DEPTH || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (/_env(?:_vars?)?$/iu.test(key) || key === "env_var") {
      if (ENV_NAME.test(value)) found(keyPath, value, { storage: "env-ref" });
      else if (plausibleSecret(value)) found(keyPath, key, { ...classify(value, salt), storage: "plaintext", pasted: true });
      return;
    }
    // A secret-sounding name with a short, spaced, path or URL value is a setting, not a secret;
    // other names count only for values shaped like a known token.
    if (!(TOKEN_SHAPE.test(value.trim()) || (strongSecretName(key) && (isEnvReference(value) || plausibleSecret(value))))) return;
    const classification = classify(value, salt);
    if (classification) found(keyPath, key, classification);
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 200).forEach((item, index) => walkObject(item, { salt, found, keyPath: `${keyPath}[${index}]`, key, depth: depth + 1, inGroup }));
    return;
  }
  if (typeof value !== "object") return;
  for (const [childKey, child] of Object.entries(value).slice(0, 300)) {
    const childPath = keyPath ? `${keyPath}.${text(childKey, 80)}` : text(childKey, 80);
    if (childKey === "env_http_headers" && child && typeof child === "object") {
      for (const [header, variable] of Object.entries(child).slice(0, 100)) {
        if (typeof variable !== "string") continue;
        if (ENV_NAME.test(variable)) found(`${childPath}.${text(header, 80)}`, variable, { storage: "env-ref" });
        else if (plausibleSecret(variable)) found(`${childPath}.${text(header, 80)}`, text(header, 80), { ...classify(variable, salt), storage: "plaintext", pasted: true });
      }
      continue;
    }
    walkObject(child, { salt, found, keyPath: childPath, key: childKey, depth: depth + 1, inGroup: inGroup || SECRET_GROUPS.has(childKey.toLowerCase()) });
  }
}

/** Value at a secret-fields location ("env.TOKEN", "args[2]", "url.query.key" → the url). */
function valueAt(config, location) {
  if (location.startsWith("url")) return typeof config.url === "string" ? config.url : config.httpUrl;
  let current = config;
  for (const part of location.split(/\.(?![^[]*\])/u)) {
    const match = part.match(/^(.*?)\[(\d+)\]$/u);
    current = match ? object(current)[match[1]]?.[Number(match[2])] : object(current)[part];
  }
  return current;
}

/** MCP servers of every Agent (readMcpSources): literal secrets in env / headers / args / url, plus env references. */
async function mcpSecrets(context, collector) {
  const { entries } = await readMcpSources(context.homeDirectory).catch(() => ({ entries: [] }));
  const times = new Map();
  for (const entry of entries.slice(0, 1_000)) {
    const config = object(entry.config);
    const file = entry.source.startsWith("~/") ? path.join(context.homeDirectory, entry.source.slice(2)) : entry.source;
    if (!times.has(file)) times.set(file, await fileTime(file));
    const base = entry.projectPath ? `projects.${context.display(entry.projectPath)}.mcpServers.${entry.name}` : `mcpServers.${entry.name}`;
    const common = { file, agents: [entry.agentId], usedBy: [{ kind: "mcp", name: text(entry.name, 80) }], modifiedAt: times.get(file) };
    const seen = new Set();
    for (const location of secretFieldReport(config).likely) {
      const classification = classify(String(valueAt(config, location) ?? ""), context.salt) || { storage: "plaintext" };
      const keyName = location.replace(/^(?:env|headers|http_headers|environment)\./u, "").replace(/^url\./u, "url ");
      seen.add(location);
      collector.add({ ...common, keyPath: `${base}.${location}`, keyName, service: guessService([keyName, entry.name, typeof config.url === "string" ? config.url : ""], entry.name), ...classification });
    }
    walkObject(config, {
      salt: context.salt,
      found: (keyPath, keyName, classification) => {
        // Literals are reported by secretFieldReport above; this adds env references and values
        // pasted into a variable-name field (bearer_token_env_var = "<the token>").
        if (seen.has(keyPath) || (classification.storage !== "env-ref" && !classification.pasted)) return;
        collector.add({ ...common, keyPath: `${base}.${keyPath}`, keyName, service: guessService([keyName, entry.name], entry.name), ...classification });
      },
    });
  }
}

async function objectSecrets(context, collector, { file, value, agents, usedBy = [], basePath = "", fallback = null }) {
  const modifiedAt = await fileTime(file);
  walkObject(value, {
    salt: context.salt,
    keyPath: basePath,
    found: (keyPath, keyName, classification) =>
      collector.add({ file, keyPath, keyName, service: guessService([keyName, keyPath], fallback || usedBy[0]?.name), agents, usedBy, modifiedAt, ...classification }),
  });
}

// ---------------------------------------------------------------------------
// Line files (.env, .npmrc, .netrc, ~/.aws/credentials)

/** KEY=VALUE lines; `fingerprint: false` lists names only (skill folders). */
async function envFileSecrets(context, collector, file, { agents = [], usedBy = [], fallback = null, fingerprint = true } = {}) {
  const read = await readBoundedText(file, LINE_FILE_LIMIT);
  if (read.status !== "ok") return;
  const modifiedAt = await fileTime(file);
  read.text.split("\n").slice(0, 5_000).forEach((line, index) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]{0,127})\s*=\s*(.*)$/u);
    if (!match) return;
    const raw = match[2].trim().replace(/^(["'])(.*)\1$/u, "$2");
    // Only credential-like entries: settings such as timeouts or debug flags are left out.
    if (!TOKEN_SHAPE.test(raw) && !(strongSecretName(match[1]) && (isEnvReference(raw) || plausibleSecret(raw)))) return;
    const classification = classify(raw, context.salt, { fingerprint });
    if (classification) collector.add({ file, keyPath: `第 ${index + 1} 行`, keyName: match[1], service: guessService([match[1]], fallback || usedBy[0]?.name), agents, usedBy, modifiedAt, ...classification });
  });
}

async function npmrcSecrets(context, collector) {
  const file = path.join(context.homeDirectory, ".npmrc");
  const read = await readBoundedText(file, LINE_FILE_LIMIT);
  if (read.status !== "ok") return;
  const modifiedAt = await fileTime(file);
  read.text.split("\n").slice(0, 2_000).forEach((line, index) => {
    const match = line.match(/^\s*((?:\/\/([^/:\s]+)[^:\s]*:)?(_authToken|_auth|_password|password|token))\s*=\s*(.+)$/u);
    if (!match) return;
    const classification = classify(match[4].trim(), context.salt, { literal: "credential-file" });
    if (classification) collector.add({ file, keyPath: `第 ${index + 1} 行`, keyName: match[3], service: `npm（${text(match[2] || "registry.npmjs.org", 80)}）`, usedBy: [{ kind: "cli", name: "npm" }], modifiedAt, ...classification });
  });
}

async function netrcSecrets(context, collector) {
  const file = path.join(context.homeDirectory, ".netrc");
  const read = await readBoundedText(file, LINE_FILE_LIMIT);
  if (read.status !== "ok") return;
  const modifiedAt = await fileTime(file);
  let machine = null;
  read.text.split("\n").slice(0, 2_000).forEach((line, index) => {
    const tokens = line.trim().split(/\s+/u);
    for (let at = 0; at < tokens.length - 1; at += 1) {
      if (tokens[at] === "machine" || tokens[at] === "default") machine = tokens[at] === "default" ? "default" : tokens[at + 1];
      if (tokens[at] === "password" || tokens[at] === "account") {
        const classification = classify(tokens[at + 1], context.salt, { literal: "credential-file" });
        if (classification) collector.add({ file, keyPath: `第 ${index + 1} 行`, keyName: `${tokens[at]}（${text(machine || "?", 80)}）`, service: guessService([machine], machine), usedBy: [{ kind: "cli", name: "netrc" }], modifiedAt, ...classification });
      }
    }
  });
}

async function awsSecrets(context, collector) {
  const file = path.join(context.homeDirectory, ".aws", "credentials");
  const read = await readBoundedText(file, LINE_FILE_LIMIT);
  if (read.status !== "ok") return;
  const modifiedAt = await fileTime(file);
  let profile = "default";
  read.text.split("\n").slice(0, 2_000).forEach((line, index) => {
    const section = line.match(/^\s*\[([^\]]{1,80})\]/u);
    if (section) profile = section[1];
    const match = line.match(/^\s*(aws_secret_access_key|aws_session_token|aws_access_key_id)\s*=\s*(.+)$/u);
    if (!match) return;
    const classification = classify(match[2].trim(), context.salt, { literal: "credential-file" });
    if (classification) collector.add({ file, keyPath: `[${text(profile, 80)}] 第 ${index + 1} 行`, keyName: match[1], service: "AWS", usedBy: [{ kind: "cli", name: "aws" }], modifiedAt, ...classification });
  });
}

// ---------------------------------------------------------------------------
// CLI credential stores

async function ghSecrets(context, collector) {
  const file = path.join(context.homeDirectory, ".config", "gh", "hosts.yml");
  const config = await readYamlFile(file, LINE_FILE_LIMIT);
  if (config.status !== "ok") return;
  const modifiedAt = await fileTime(file);
  for (const [host, entry] of Object.entries(object(config.value)).slice(0, 20)) {
    const value = object(entry);
    const usedBy = [{ kind: "cli", name: "gh" }];
    const classification = classify(typeof value.oauth_token === "string" ? value.oauth_token : "", context.salt, { literal: "oauth" });
    if (classification) collector.add({ file, keyPath: `${text(host, 80)}.oauth_token`, keyName: "oauth_token", service: "GitHub", usedBy, modifiedAt, ...classification });
    else collector.add({ file, keyPath: text(host, 80), keyName: "登录令牌", service: "GitHub", usedBy, modifiedAt, storage: "keychain", note: "gh 把登录令牌存在系统钥匙串里（这里不读取）" });
  }
}

async function dockerSecrets(context, collector) {
  const file = path.join(context.homeDirectory, ".docker", "config.json");
  const config = await readBoundedJson(file, CONFIG_LIMIT);
  if (config.status !== "ok") return;
  const modifiedAt = await fileTime(file);
  const value = object(config.value);
  const usedBy = [{ kind: "cli", name: "docker" }];
  for (const [registry, entry] of Object.entries(object(value.auths)).slice(0, 50)) {
    for (const field of ["auth", "identitytoken", "password"]) {
      const classification = classify(typeof object(entry)[field] === "string" ? entry[field] : "", context.salt, { literal: "credential-file" });
      if (classification) collector.add({ file, keyPath: `auths.${text(registry, 120)}.${field}`, keyName: field, service: `Docker（${text(registry, 80)}）`, usedBy, modifiedAt, ...classification });
    }
  }
  const stores = [
    ...(typeof value.credsStore === "string" ? [["credsStore", value.credsStore]] : []),
    ...Object.entries(object(value.credHelpers)).slice(0, 50).map(([registry, helper]) => [`credHelpers.${text(registry, 120)}`, helper]),
  ];
  for (const [keyPath, helper] of stores) {
    if (typeof helper !== "string") continue;
    collector.add({ file, keyPath, keyName: "登录凭据", service: "Docker", usedBy, modifiedAt, storage: /osxkeychain|desktop|keychain/iu.test(helper) ? "keychain" : "credential-file", note: `由凭据助手 ${text(helper, 40)} 保存（这里不读取）` });
  }
}

async function larkSecrets(context, collector) {
  const file = path.join(context.homeDirectory, ".lark-cli", "config.json");
  const config = await readBoundedJson(file, CONFIG_LIMIT);
  if (config.status !== "ok") return;
  const modifiedAt = await fileTime(file);
  const usedBy = [{ kind: "cli", name: "lark-cli" }];
  (Array.isArray(object(config.value).apps) ? config.value.apps : []).slice(0, 20).forEach((app, index) => {
    const secret = object(app).appSecret;
    if (typeof secret === "string") {
      const classification = classify(secret, context.salt);
      if (classification) collector.add({ file, keyPath: `apps[${index}].appSecret`, keyName: "appSecret", service: "飞书", usedBy, modifiedAt, ...classification });
    } else if (secret && typeof secret === "object") {
      collector.add({ file, keyPath: `apps[${index}].appSecret`, keyName: "appSecret", service: "飞书", usedBy, modifiedAt, storage: object(secret).source === "keychain" ? "keychain" : "credential-file", note: "主凭据在系统钥匙串里（这里不读取）" });
    }
  });
}

// ---------------------------------------------------------------------------
// Agent configuration beyond MCP

const PROFILE_FIELDS = ["key", "apiKey", "token", "access", "refresh"];

/**
 * OpenClaw / QClaw credentials (its docs: auth-credential-semantics, openclaw-agent-runtime):
 * current logins live in SQLite auth stores (agents/<id>/agent/openclaw-agent.sqlite and
 * state/openclaw.sqlite), which are noted but never opened; legacy JSON files that doctor
 * still imports (auth-profiles.json, per-agent auth.json, credentials/oauth.json) are parsed.
 */
async function openClawCredentials(context, collector, stateDir, agentId) {
  const usedBy = [];
  const agentsDir = path.join(stateDir, "agents");
  const agentDirs = (await readdir(agentsDir, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).slice(0, 30).map((entry) => path.join(agentsDir, entry.name, "agent"));
  for (const file of [path.join(stateDir, "state", "openclaw.sqlite"), ...agentDirs.map((directory) => path.join(directory, "openclaw-agent.sqlite"))]) {
    const modifiedAt = await fileTime(file);
    if (!modifiedAt) continue;
    collector.add({ file, keyPath: "", keyName: "模型登录凭据", service: agentId === "qclaw" ? "QClaw" : "OpenClaw", agents: [agentId], usedBy, modifiedAt, storage: "credential-file", note: "API key 和 OAuth 登录存在这个 SQLite 认证库里（这里不读取）" });
  }
  const legacy = [path.join(stateDir, "auth-profiles.json"), path.join(stateDir, "credentials", "oauth.json"), ...agentDirs.flatMap((directory) => [path.join(directory, "auth-profiles.json"), path.join(directory, "auth.json")])];
  for (const file of legacy) {
    const read = await readBoundedJson(file, CONFIG_LIMIT);
    if (read.status !== "ok") continue;
    const modifiedAt = await fileTime(file);
    const root = object(read.value);
    const oauthFile = path.basename(file) === "oauth.json";
    // { profiles: { id: {...} } }, a flat { id: {...} } map, or one credential object.
    const entries = PROFILE_FIELDS.some((field) => typeof root[field] === "string") ? [["", root]] : Object.entries(object(root.profiles || root)).slice(0, 100);
    for (const [profileId, raw] of entries) {
      const profile = object(raw);
      const field = PROFILE_FIELDS.find((name) => typeof profile[name] === "string");
      if (!field) continue;
      const kind = oauthFile || profile.type === "oauth" || field === "access" || field === "refresh" ? "oauth" : "credential-file";
      const classification = classify(profile[field], context.salt, { literal: kind });
      const keyName = text(profileId || field, 80);
      if (classification) collector.add({ file, keyPath: profileId ? `profiles.${keyName}.${field}` : field, keyName, service: guessService([profile.provider, profileId], profile.provider || profileId || (agentId === "qclaw" ? "QClaw" : "OpenClaw")), agents: [agentId], usedBy, modifiedAt, note: "旧版文件；openclaw doctor --fix 会把它导入 SQLite 认证库", ...classification });
    }
  }
}

/** MCP sections are inventoried once, through readMcpSources. */
const withoutKey = (value, key) => Object.fromEntries(Object.entries(object(value)).filter(([name]) => name !== key));

async function agentConfigSecrets(context, collector) {
  const home = context.homeDirectory;
  const claudeSettings = path.join(home, ".claude", "settings.json");
  const settings = await readBoundedJson(claudeSettings, CONFIG_LIMIT);
  if (settings.status === "ok") await objectSecrets(context, collector, { file: claudeSettings, value: { env: object(settings.value).env }, agents: ["claude"], fallback: "Claude Code" });
  const claudeState = path.join(home, ".claude.json");
  const state = await readBoundedJson(claudeState, CLAUDE_STATE_LIMIT);
  if (state.status === "ok") await objectSecrets(context, collector, { file: claudeState, value: { env: object(state.value).env }, agents: ["claude"], fallback: "Claude Code" });
  for (const [agentId, file, fallback] of [["gemini", path.join(home, ".gemini", ".env"), "Gemini CLI"], ["workbuddy", path.join(home, ".workbuddy", ".env"), "WorkBuddy"], ["hermes", path.join(home, ".hermes", ".env"), "Hermes"]]) {
    await envFileSecrets(context, collector, file, { agents: [agentId], fallback });
  }
  const gemini = await readBoundedJson(path.join(home, ".gemini", "settings.json"), CONFIG_LIMIT);
  if (gemini.status === "ok") {
    const rest = withoutKey(gemini.value, "mcpServers");
    await objectSecrets(context, collector, { file: path.join(home, ".gemini", "settings.json"), value: rest, agents: ["gemini"], fallback: "Gemini CLI" });
  }
  const workbuddy = await readBoundedJson(path.join(home, ".workbuddy", "settings.json"), CONFIG_LIMIT);
  if (workbuddy.status === "ok") await objectSecrets(context, collector, { file: path.join(home, ".workbuddy", "settings.json"), value: { env: object(workbuddy.value).env }, agents: ["workbuddy"], fallback: "WorkBuddy" });
  const hermes = await readYamlFile(path.join(home, ".hermes", "config.yaml"));
  if (hermes.status === "ok") {
    const rest = withoutKey(hermes.value, "mcp_servers");
    await objectSecrets(context, collector, { file: path.join(home, ".hermes", "config.yaml"), value: rest, agents: ["hermes"], fallback: "Hermes" });
  }
  for (const agentId of ["openclaw", "qclaw"]) {
    const install = await resolveOpenClawInstall(agentId, home).catch(() => null);
    if (!install?.available) continue;
    if (install.configPath && install.configStatus === "ok") {
      const rest = withoutKey(install.config, "mcp");
      await objectSecrets(context, collector, { file: install.configPath, value: rest, agents: [agentId], fallback: agentId === "qclaw" ? "QClaw" : "OpenClaw" });
    }
    await openClawCredentials(context, collector, install.stateDir, agentId);
  }
  const raccoon = await resolveRaccoonInstall(home).catch(() => null);
  if (raccoon?.available) {
    const yaml = await readYamlFile(path.join(raccoon.configDir, "config.yaml"));
    if (yaml.status === "ok") await objectSecrets(context, collector, { file: path.join(raccoon.configDir, "config.yaml"), value: yaml.value, agents: ["office-raccoon"], fallback: "办公小浣熊" });
    const mcp = await readBoundedJson(path.join(raccoon.configDir, "mcp.json"), CONFIG_LIMIT);
    if (mcp.status === "ok") {
      for (const [name, server] of Object.entries(object(object(mcp.value).mcpServers)).slice(0, 100)) {
        await objectSecrets(context, collector, { file: path.join(raccoon.configDir, "mcp.json"), value: server, basePath: `mcpServers.${text(name, 80)}`, agents: ["office-raccoon"], usedBy: [{ kind: "mcp", name: text(name, 80) }] });
      }
    }
  }
}

/** .env* files directly inside skill folders: key names only, never fingerprints. */
async function skillEnvSecrets(context, collector, skillDirectories) {
  for (const { directory, name, agentIds } of skillDirectories.slice(0, SKILL_DIR_LIMIT)) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.slice(0, 200)) {
      if (!entry.isFile() || !/^\.env(?:\.[\w-]{1,40})?$/u.test(entry.name) || /\.(?:example|sample|template|dist)$/u.test(entry.name)) continue;
      await envFileSecrets(context, collector, path.join(directory, entry.name), { agents: agentIds, usedBy: [{ kind: "skill", name }], fingerprint: false });
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot and changes

async function compareWithSnapshot(stateDirectory, items, now) {
  const file = path.join(stateDirectory, "secret-snapshot.json");
  let snapshot = null;
  try {
    snapshot = JSON.parse(await readFile(file, "utf8"));
  } catch {
    snapshot = null;
  }
  const previous = object(snapshot?.items);
  const changes = Array.isArray(snapshot?.changes) ? snapshot.changes.filter((change) => change && typeof change.id === "string").slice(0, CHANGE_LIMIT) : [];
  const at = new Date(now).toISOString();
  const next = {};
  const fresh = [];
  for (const item of items) {
    const before = object(previous[item.id]);
    const known = Boolean(previous[item.id]);
    const changed = known && (before.fingerprint || null) !== (item.fingerprint || null);
    const record = {
      keyName: item.keyName,
      fingerprint: item.fingerprint || null,
      firstSeenAt: known ? before.firstSeenAt || at : at,
      changedAt: changed ? at : known ? before.changedAt || before.firstSeenAt || at : at,
    };
    next[item.id] = record;
    // The first inventory is the baseline: nothing counts as added.
    if (snapshot && !known) fresh.push({ id: item.id, kind: "added", at, keyName: item.keyName });
    if (changed) fresh.push({ id: item.id, kind: "changed", at, keyName: item.keyName });
    item.firstSeenAt = record.firstSeenAt;
    item.changedAt = record.changedAt;
  }
  for (const [id, before] of Object.entries(previous)) {
    if (!next[id]) fresh.push({ id, kind: "removed", at, keyName: text(object(before).keyName, 120) });
  }
  const allChanges = [...fresh, ...changes].slice(0, CHANGE_LIMIT);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, items: next, changes: allChanges })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
  return allChanges;
}

/**
 * The inventory. `skillDirectories`: [{ directory, name, agentIds }] from the scan (skill
 * folders whose `.env*` files are listed by key name).
 */
export async function buildSecretsInventory({ homeDirectory = homedir(), homes = [homeDirectory], stateDirectory, skillDirectories = [], now = Date.now() } = {}) {
  const allHomes = [...new Set([...homes, ...(await homeVariants(homeDirectory))])];
  const context = { homeDirectory, salt: await loadSalt(stateDirectory), display: (value) => compactHomePath(value, allHomes) };
  const collector = createCollector(context);
  await mcpSecrets(context, collector);
  await agentConfigSecrets(context, collector);
  await skillEnvSecrets(context, collector, skillDirectories);
  await ghSecrets(context, collector);
  await npmrcSecrets(context, collector);
  await netrcSecrets(context, collector);
  await awsSecrets(context, collector);
  await dockerSecrets(context, collector);
  await larkSecrets(context, collector);
  const items = [...collector.items.values()].sort(
    (left, right) => left.service.localeCompare(right.service) || left.location.localeCompare(right.location) || left.keyName.localeCompare(right.keyName),
  );
  const changes = await compareWithSnapshot(stateDirectory, items, now);
  const byStorage = Object.fromEntries(STORAGE_TYPES.map((storage) => [storage, items.filter((item) => item.storage === storage).length]));
  return {
    generatedAt: new Date(now).toISOString(),
    items,
    changes: changes.slice(0, 50).map(({ id, kind, at, keyName }) => ({ id, kind, at, ...(keyName ? { keyName } : {}) })),
    summary: { total: items.length, plaintext: byStorage.plaintext, byStorage },
  };
}

