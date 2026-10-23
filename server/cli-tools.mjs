import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { compactHomePath, exists, homeVariants, object, readBoundedJson, readBoundedText } from "./fs-safe.mjs";
import { readYamlFile } from "./config-files.mjs";
import { readAgentSwitches } from "./library-agents.mjs";

/**
 * CLI tool cards (docs §3): every copy of a CLI and its version, which copy each Agent
 * actually finds (from that Agent's own PATH source: shell snapshot, launchd plist or the
 * GUI default), workspace and keychain readiness, allow rules and sandbox network. Only
 * files are read; secrets are never opened beyond the kind of credential source.
 */

export const CLI_DESCRIPTORS = [
  {
    id: "lark-cli",
    name: "飞书 CLI（lark-cli）",
    command: "lark-cli",
    npmPackage: "@larksuite/cli",
    nativeBinary: path.join("bin", "lark-cli"),
    bundled: [{ path: [".hermes", "node", "bin", "lark-cli"], via: "Hermes 自带" }],
    skillPrefix: "lark-",
    stateDir: ".lark-cli",
    workspaces: { local: "", hermes: "hermes", openclaw: "openclaw" },
    allowRules: true,
  },
  { id: "gh", name: "GitHub CLI（gh）", command: "gh" },
  { id: "uv", name: "uv", command: "uv" },
];

const GUI_DEFAULT_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** Agents and where their PATH comes from. */
export const AGENT_PATH_SOURCES = {
  codex: { kind: "shell-snapshot", dir: [".codex", "shell_snapshots"], sandbox: true },
  claude: { kind: "shell-snapshot", dir: [".claude", "shell-snapshots"] },
  workbuddy: { kind: "shell-snapshot", dir: [".workbuddy", "shell-snapshots"] },
  hermes: { kind: "launchd", plist: ["Library", "LaunchAgents", "ai.hermes.gateway.plist"], workspace: "hermes" },
  openclaw: { kind: "gui", workspace: "openclaw" },
  qclaw: { kind: "gui", workspace: "openclaw" },
  gemini: { kind: "terminal" },
  cursor: { kind: "terminal" },
  opencode: { kind: "terminal" },
};

/** PATH entries from a zsh/bash snapshot: `export PATH=…` or zsh `export -T PATH path=( … )`. */
export function pathFromSnapshot(text, homeDirectory) {
  const unquote = (value) => value.replace(/^\$?'(.*)'$/su, "$1").replace(/^"(.*)"$/su, "$1");
  const expandHome = (value) => (value === "~" ? homeDirectory : value.startsWith("~/") ? path.join(homeDirectory, value.slice(2)) : value.replace(/^\$HOME(?=\/|$)/u, homeDirectory));
  let found = null;
  for (const match of text.matchAll(/^export -T PATH path=\(\s*(.*?)\s*\)\s*$/gmu)) found = match[1].split(/\s+/u).map(unquote);
  for (const match of text.matchAll(/^(?:export |declare -x )?PATH=("[^"\n]*"|'[^'\n]*'|[^\s;]+)\s*$/gmu)) found = unquote(match[1]).split(":");
  return found ? found.filter(Boolean).map(expandHome) : null;
}

async function newestFile(directory) {
  let best = null;
  for (const name of (await readdir(directory).catch(() => [])).slice(0, 2_000)) {
    if (!name.endsWith(".sh")) continue;
    const info = await stat(path.join(directory, name)).catch(() => null);
    if (info?.isFile() && (!best || info.mtimeMs > best.mtimeMs)) best = { file: path.join(directory, name), mtimeMs: info.mtimeMs };
  }
  return best;
}

/** PATH and env keys from an XML launchd plist (values other than PATH are never returned). */
export async function readPlistEnvironment(file) {
  const read = await readBoundedText(file, 512_000);
  if (read.status !== "ok" || !read.text.startsWith("<?xml")) return null;
  const block = read.text.match(/<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/u)?.[1] || "";
  const keys = [...block.matchAll(/<key>([\w.-]{1,80})<\/key>/gu)].map((match) => match[1]);
  const pathValue = block.match(/<key>PATH<\/key>\s*<string>([^<]{0,8000})<\/string>/u)?.[1] || null;
  return { keys, path: pathValue ? pathValue.split(":").filter(Boolean) : null };
}

/** Where each Agent looks for commands, and the lark-cli workspace it ends up in. */
export async function agentPathSource(agentId, homeDirectory, { launchctlPath = null } = {}) {
  const source = AGENT_PATH_SOURCES[agentId];
  if (!source) return null;
  if (source.kind === "shell-snapshot") {
    const newest = await newestFile(path.join(homeDirectory, ...source.dir));
    const text = newest ? (await readBoundedText(newest.file, 4_000_000)).text : null;
    return { kind: source.kind, via: newest ? "shell snapshot" : "无 shell snapshot", path: text ? pathFromSnapshot(text, homeDirectory) : null, workspace: "local", sandbox: Boolean(source.sandbox) };
  }
  if (source.kind === "launchd") {
    const file = path.join(homeDirectory, ...source.plist);
    const environment = await readPlistEnvironment(file);
    return {
      kind: source.kind,
      via: environment ? "launchd plist" : "plist 不存在",
      plist: file,
      path: environment?.path || GUI_DEFAULT_PATH,
      workspace: environment?.keys.includes("HERMES_HOME") ? "hermes" : "local",
    };
  }
  if (source.kind === "gui") {
    return { kind: source.kind, via: launchctlPath?.length ? "launchctl PATH" : "图形界面默认 PATH", path: launchctlPath?.length ? launchctlPath : GUI_DEFAULT_PATH, workspace: source.workspace };
  }
  // Terminal tools: the newest shell snapshot of any Agent approximates the login shell.
  let newest = null;
  for (const candidate of Object.values(AGENT_PATH_SOURCES).filter((item) => item.kind === "shell-snapshot")) {
    const file = await newestFile(path.join(homeDirectory, ...candidate.dir));
    if (file && (!newest || file.mtimeMs > newest.mtimeMs)) newest = file;
  }
  const text = newest ? (await readBoundedText(newest.file, 4_000_000)).text : null;
  return { kind: "terminal", via: "终端（参考最新 shell snapshot）", path: text ? pathFromSnapshot(text, homeDirectory) : null, workspace: "local" };
}

async function isExecutableFile(file) {
  const info = await stat(file).catch(() => null);
  return Boolean(info?.isFile() && info.mode & 0o111);
}

/** Version and kind of a binary, from its npm package (never by running it). */
async function describeBinary(file, descriptor, homeDirectory, via) {
  const real = await realpath(file).catch(() => null);
  let version = null;
  let kind = "manual";
  let packageRoot = null;
  if (descriptor.npmPackage && real) {
    let current = path.dirname(real);
    for (let depth = 0; depth < 6; depth += 1) {
      const pkg = await readBoundedJson(path.join(current, "package.json"), 256_000);
      if (pkg.status === "ok" && object(pkg.value).name === descriptor.npmPackage) {
        version = typeof pkg.value.version === "string" ? pkg.value.version.slice(0, 40) : null;
        packageRoot = current;
        kind = current.includes(`${path.sep}lib${path.sep}node_modules${path.sep}`) || current.includes(`${path.sep}node_modules${path.sep}`) ? "npm-global" : "manual";
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const wrapper = await readWrapperTarget(file);
  if (wrapper) kind = "wrapper";
  return { file, real, version, kind: via === "bundled" ? "bundled" : kind, packageRoot, wrapperTarget: wrapper };
}

/** `#!/bin/sh` + `exec "<target>" "$@"` wrappers written by the lark-cli fix. */
export async function readWrapperTarget(file) {
  const read = await readBoundedText(file, 4_096);
  if (read.status !== "ok" || !read.text.startsWith("#!/bin/sh")) return null;
  return read.text.match(/^exec "([^"]{1,1000})" "\$@"\s*$/mu)?.[1] || null;
}

/** The native (Go) executable inside an npm package: not a script starting with "#!". */
async function nativeBinaryOf(packageRoot, descriptor) {
  if (!packageRoot || !descriptor.nativeBinary) return null;
  const candidate = path.join(packageRoot, descriptor.nativeBinary);
  if (!(await isExecutableFile(candidate))) return null;
  const handle = await open(candidate, "r").catch(() => null);
  if (!handle) return null;
  const head = Buffer.alloc(4);
  await handle.read(head, 0, 4, 0).finally(() => handle.close());
  return head.subarray(0, 2).toString() === "#!" ? null : candidate;
}

async function findBinaries(descriptor, homeDirectory, searchDirectories) {
  const seen = new Set();
  const binaries = [];
  const add = async (file, via) => {
    if (!(await isExecutableFile(file))) return;
    const described = await describeBinary(file, descriptor, homeDirectory, via);
    const key = described.real || file;
    if (seen.has(key)) return;
    seen.add(key);
    binaries.push({ ...described, via });
  };
  for (const { directory, nvm } of searchDirectories) await add(path.join(directory, descriptor.command), nvm ? "nvm" : "PATH");
  for (const bundled of descriptor.bundled || []) await add(path.join(homeDirectory, ...bundled.path), "bundled");
  return binaries;
}

/** First directory on `entries` holding the command. */
async function resolveOnPath(command, entries) {
  for (const directory of entries || []) {
    const candidate = path.join(directory, command);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const COMMAND_NAME = "[\\w.+-]{1,64}";
const stringsOf = (list) => (Array.isArray(list) ? list.filter((item) => typeof item === "string").slice(0, 5_000) : []);
const namesFrom = (items, pattern) => new Set(items.flatMap((item) => [...item.matchAll(pattern)].map((match) => match[1])));
const NO_RULES = { check: () => "n/a", commands: new Set() };

/**
 * An Agent's allow rules, read once: `check(command)` → present / missing / n/a, and
 * `commands`, the command names the rules mention (for "tools an Agent refers to").
 */
export async function loadAllowRules(agentId, homeDirectory) {
  switch (agentId) {
    case "claude": {
      const settings = await readBoundedJson(path.join(homeDirectory, ".claude", "settings.json"), 2_000_000);
      const permissions = object(object(settings.value).permissions);
      const allow = stringsOf(permissions.allow);
      const everything = permissions.defaultMode === "bypassPermissions" || allow.some((item) => /^Bash(?:\(\*\))?$/u.test(item));
      return {
        check: (command) => (everything || allow.some((item) => new RegExp(`^Bash\\(${escapeRegExp(command)}(?:[ :]\\*)?\\)$`, "u").test(item)) ? "present" : "missing"),
        commands: namesFrom(allow, new RegExp(`^Bash\\((${COMMAND_NAME})(?=[ :)])`, "gu")),
      };
    }
    case "codex": {
      const texts = [];
      for (const name of (await readdir(path.join(homeDirectory, ".codex", "rules")).catch(() => [])).filter((file) => file.endsWith(".rules")).slice(0, 50)) {
        texts.push((await readBoundedText(path.join(homeDirectory, ".codex", "rules", name), 1_000_000)).text || "");
      }
      return {
        check: (command) => (texts.some((value) => new RegExp(`prefix_rule\\(\\s*pattern\\s*=\\s*\\[\\s*"${escapeRegExp(command)}"`, "u").test(value)) ? "present" : "missing"),
        commands: namesFrom(texts, new RegExp(`prefix_rule\\(\\s*pattern\\s*=\\s*\\[\\s*"(${COMMAND_NAME})"`, "gu")),
      };
    }
    case "gemini": {
      const settings = await readBoundedJson(path.join(homeDirectory, ".gemini", "settings.json"), 2_000_000);
      const allowed = stringsOf(object(object(settings.value).tools).allowed);
      return {
        check: (command) => (allowed.some((item) => new RegExp(`^run_shell_command(?:\\(${escapeRegExp(command)}\\))?$`, "u").test(item)) ? "present" : "missing"),
        commands: namesFrom(allowed, new RegExp(`^run_shell_command\\((${COMMAND_NAME})`, "gu")),
      };
    }
    case "cursor": {
      const config = await readBoundedJson(path.join(homeDirectory, ".cursor", "cli-config.json"), 2_000_000);
      if (config.status === "missing") return NO_RULES;
      const allow = stringsOf(object(object(config.value).permissions).allow);
      return {
        check: (command) => (allow.some((item) => new RegExp(`^Shell\\(${escapeRegExp(command)}\\)$`, "u").test(item)) ? "present" : "missing"),
        commands: namesFrom(allow, new RegExp(`^Shell\\((${COMMAND_NAME})`, "gu")),
      };
    }
    case "opencode": {
      const config = await readBoundedJson(path.join(homeDirectory, ".config", "opencode", "opencode.json"), 2_000_000);
      if (config.status === "missing") return NO_RULES;
      const bash = object(object(config.value).permission).bash;
      const keys = Object.keys(object(bash)).slice(0, 5_000);
      return {
        check: (command) => (bash === "allow" || object(bash)[`${command} *`] === "allow" ? "present" : "missing"),
        commands: namesFrom(keys, new RegExp(`^(${COMMAND_NAME})(?= |$)`, "gu")),
      };
    }
    case "hermes": {
      const config = await readYamlFile(path.join(homeDirectory, ".hermes", "config.yaml"));
      const list = stringsOf(object(config.value).command_allowlist);
      return {
        check: (command) => (list.some((item) => new RegExp(`^${escapeRegExp(command)}(?:\\s|$)`, "u").test(item)) ? "present" : "missing"),
        commands: namesFrom(list, new RegExp(`^(${COMMAND_NAME})(?=\\s|$)`, "gu")),
      };
    }
    default:
      return NO_RULES;
  }
}

async function allowRuleState(agentId, homeDirectory, command) {
  return (await loadAllowRules(agentId, homeDirectory)).check(command);
}

/** Workspace readiness: config existence and the kind of secret source — never the secret. */
async function workspaceState(descriptor, homeDirectory, workspace) {
  if (!descriptor.workspaces) return { configured: null, secretSource: null, masterKeyFile: false };
  const root = path.join(homeDirectory, descriptor.stateDir, descriptor.workspaces[workspace] || "");
  const config = await readBoundedJson(path.join(root, "config.json"), 512_000);
  const app = Array.isArray(object(config.value).apps) ? object(config.value.apps[0]) : {};
  const source = object(app.appSecret).source;
  return {
    configured: config.status === "ok" && Boolean(app.appId),
    secretSource: typeof source === "string" && /^[\w-]{1,32}$/u.test(source) ? source : typeof app.appSecret === "string" ? "inline" : null,
    masterKeyFile: (await exists(path.join(root, "master.key.file"))) || (await exists(path.join(homeDirectory, descriptor.stateDir, "master.key.file"))),
  };
}

/** Display names for Agents when the config does not provide one. */
export const AGENT_DISPLAY_NAMES = {
  codex: "Codex",
  claude: "Claude Code",
  workbuddy: "WorkBuddy",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  hermes: "Hermes Agent",
  openclaw: "OpenClaw",
  qclaw: "QClaw",
};

export async function detectCliTools({ homeDirectory, homes = [homeDirectory], searchDirectories, agents = [], agentNames = {}, library = null, latest = {}, launchctlPath = null }) {
  const displayHomes = [...new Set([...homes, ...(await homeVariants(homeDirectory))])];
  const display = (value) => (value ? compactHomePath(value, displayHomes) : null);
  const tools = [];
  for (const descriptor of CLI_DESCRIPTORS) {
    const binaries = await findBinaries(descriptor, homeDirectory, searchDirectories);
    if (!binaries.length && descriptor.id !== "lark-cli") continue;
    const versionOf = async (file) => {
      const real = await realpath(file).catch(() => file);
      return binaries.find((binary) => binary.real === real || binary.file === file)?.version ?? (await describeBinary(file, descriptor, homeDirectory, "PATH")).version;
    };
    const representative = library?.entries?.find((entry) => entry.name.startsWith(descriptor.skillPrefix || "\0"));
    const agentRows = [];
    for (const agentId of agents) {
      const source = await agentPathSource(agentId, homeDirectory, { launchctlPath });
      if (!source) continue;
      const resolved = await resolveOnPath(descriptor.command, source.path);
      const row = { agentId, agentName: agentNames[agentId] || AGENT_DISPLAY_NAMES[agentId] || agentId, pathSource: source.via, resolves: resolved ? { path: display(resolved), version: await versionOf(resolved) } : null };
      if (descriptor.id === "lark-cli") {
        const workspace = await workspaceState(descriptor, homeDirectory, source.workspace);
        const switches = agentId === "codex" ? await readAgentSwitches("codex", homeDirectory) : {};
        const sandboxed = agentId === "codex" && switches.sandboxMode !== "danger-full-access";
        const allowRule = descriptor.allowRules ? await allowRuleState(agentId, homeDirectory, descriptor.command) : "n/a";
        Object.assign(row, {
          workspace: source.workspace,
          workspaceConfigured: Boolean(workspace.configured),
          secretSource: workspace.secretSource,
          keychainReachable: !workspace.configured ? "unknown" : workspace.secretSource !== "keychain" || workspace.masterKeyFile || !sandboxed ? "yes" : "needs-downgrade",
          skill: representative ? { name: representative.name, inLibrary: true, visible: representative.fanout?.[agentId]?.state === "visible" } : { name: null, inLibrary: false, visible: false },
          allowRule,
          sandboxNetwork: agentId !== "codex" ? "n/a" : !sandboxed || switches.networkAccess || allowRule === "present" ? "ok" : "blocked",
          ...(source.plist ? { plist: display(source.plist) } : {}),
        });
      }
      agentRows.push(row);
    }
    const versions = [...new Set(binaries.map((binary) => binary.version).filter(Boolean))];
    const npmGlobal = binaries.find((binary) => binary.kind === "npm-global");
    tools.push({
      id: descriptor.id,
      name: descriptor.name,
      binaries: binaries.map((binary) => ({ path: display(binary.file), version: binary.version, kind: binary.kind, via: binary.via, ...(binary.wrapperTarget ? { target: display(binary.wrapperTarget) } : {}) })),
      latest: latest[descriptor.id] || null,
      versionSkew: versions.length > 1,
      agents: agentRows,
      internal: { descriptor, binaries, displayHomes, nativeBinary: npmGlobal ? await nativeBinaryOf(npmGlobal.packageRoot, descriptor) : null },
    });
  }
  return tools;
}

export const readTextFile = (file) => readFile(file, "utf8").catch(() => null);
