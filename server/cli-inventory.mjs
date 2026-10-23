import { lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { readAppBundle } from "./config-files.mjs";
import { compactHomeInText, compactHomePath, homeVariants, object, readBoundedJson, readBoundedText, readBoundedToml, scrubTokens, text } from "./fs-safe.mjs";
import { AGENT_APPS } from "./agent-icons.mjs";
import { AGENT_DISPLAY_NAMES, agentPathSource, loadAllowRules } from "./cli-tools.mjs";
import { findSkillMentions } from "./skill-mentions.mjs";

/**
 * Generic inventory of user-installed command-line tools (v0.2 §12). Nothing is executed:
 * entries are listed from known bin folders, kinds come from the first bytes of the file
 * (shebang or executable magic), owners from package.json / dist-info / .app Info.plist /
 * Homebrew Cellar paths, descriptions from a script's first comment lines (first 512 bytes
 * only, redacted). Homebrew commands are listed only when a skill or an Agent's allow rule
 * names them. Backups (*.bak, *.old) are hidden and counted.
 */

const ENTRY_LIMIT = 400;
const PREFIX_ENTRY_LIMIT = 5_000;
const TOOL_LIMIT = 1_500;
const HEAD_BYTES = 512;
const DESCRIPTION_LIMIT = 200;
const SKILL_NAME_LIMIT = 20;
const NAME = /^[\w.+-]{1,64}$/u;
const BACKUP = /\.(?:bak|old|orig|backup)\d*$|~$/iu;
const BUNDLED_NPM = new Set(["npm", "corepack"]);
const GENERIC_TOOLS = new Set(["uv", "uvx", "python", "python3", "pip", "pip3", "pipx", "pnpm", "pnpx", "npm", "npx", "node", "corepack", "yarn", "yarnpkg", "bun", "bunx", "deno", "cargo", "rustc", "rustup", "go", "git", "brew"]);
const isGeneric = (name) => GENERIC_TOOLS.has(name) || /^(?:python|pip)\d+(?:\.\d+)?$/u.test(name);
/** Agent and AI command-line tools known by name. */
const KNOWN_AI_COMMANDS = new Set([
  "claude", "codex", "gemini", "openclaw", "hermes", "hermes-agent", "hermes-acp", "opencode", "cursor-agent", "qwen", "aider", "goose", "kimi", "iflow", "amp", "crush", "qodercli", "codebuddy",
  "lark-cli", "coze", "ollama", "llm", "copilot", "droid", "kiro", "workbuddy", "qclaw", "lumiclaw", "moticlaw", "lumilab", "agent-browser", "getnote",
]);

/** Agent / AI command-line tools known by name (deep cards use this when nothing else is known). */
export const isKnownAiCommand = (name) => KNOWN_AI_COMMANDS.has(name);
const AI_PACKAGES = new Set(["@openai/codex", "@anthropic-ai/claude-code", "@google/gemini-cli", "openclaw", "@larksuite/cli", "@coze/cli", "@getnote/cli", "@qwen-code/qwen-code", "opencode-ai"]);
const AI_KEYWORDS = new Set(["ai", "agent", "agents", "llm", "llms", "mcp"]);
const AI_APP_NAME = /(?:AI|GPT|Claw|Agent|LLM|Copilot|Claude|Codex|Gemini)/u;
const MACHO = new Set(["feedfacf", "cffaedfe", "feedface", "cefaedfe", "cafebabe", "bebafeca"]);

const appBundleIds = new Set(Object.values(AGENT_APPS).flatMap((spec) => spec.bundleIds));
const appNames = new Set(Object.values(AGENT_APPS).flatMap((spec) => spec.names.map((name) => name.replace(/\.app$/u, ""))));

/** Folders to list, in PATH-like order (the first copy of a name is the preferred one). */
export function inventorySources(homeDirectory, { systemPrefixes = [], nvmVersions = [] } = {}) {
  const home = (...parts) => path.join(homeDirectory, ...parts);
  return [
    { source: "local-bin", directory: home(".local", "bin") },
    ...nvmVersions.map((version) => ({ source: "npm", directory: home(".nvm", "versions", "node", version, "bin"), prefix: home(".nvm", "versions", "node", version), label: `nvm ${version}` })),
    ...systemPrefixes.map((prefix) => ({ source: "prefix", directory: path.join(prefix, "bin"), prefix, label: prefix })),
    { source: "npm", directory: home(".npm-global", "bin"), prefix: home(".npm-global") },
    { source: "npm", directory: home(".hermes", "node", "bin"), prefix: home(".hermes", "node"), label: "Hermes 自带 node" },
    { source: "pnpm", directory: home("Library", "pnpm") },
    { source: "bun", directory: home(".bun", "bin") },
    { source: "cargo", directory: home(".cargo", "bin") },
    { source: "go", directory: home("go", "bin") },
    { source: "deno", directory: home(".deno", "bin") },
  ];
}

async function nvmVersionsOf(homeDirectory) {
  const names = await readdir(path.join(homeDirectory, ".nvm", "versions", "node")).catch(() => []);
  const parse = (value) => value.replace(/^v/u, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  return names
    .filter((name) => /^v\d{1,3}\.\d{1,4}\.\d{1,4}$/u.test(name))
    .sort((left, right) => {
      const [a, b] = [parse(left), parse(right)];
      return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
    })
    .slice(0, 20);
}

async function readHead(file) {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return Buffer.alloc(0);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** script (with the shebang's interpreter) / binary / other. */
export function fileKindOf(head) {
  if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) {
    const line = head.toString("utf8").split("\n", 1)[0].slice(2).trim();
    const parts = line.split(/\s+/u).filter(Boolean);
    let program = path.basename(parts[0] || "");
    if (program === "env") program = parts.slice(1).find((part) => !part.startsWith("-") && !part.includes("=")) || "";
    program = path.basename(program);
    return { kind: "script", interpreter: NAME.test(program) ? program.slice(0, 32) : null };
  }
  const magic = head.subarray(0, 4).toString("hex");
  if (MACHO.has(magic) || magic === "7f454c46") return { kind: "binary", interpreter: null };
  return { kind: "other", interpreter: null };
}

const NOISE = /^(?:-\*-|.*coding[:=]|vim?:|eslint|shellcheck|@ts-|prettier|jshint|spdx|copyright|generated by|@flow)/iu;

/** The first comment lines after the shebang (at most 3), redacted and capped. */
export function scriptDescription(head, homes) {
  const lines = head.toString("utf8").replace(/�/gu, "").split(/\r?\n/u).slice(1);
  const picked = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (picked.length) break;
      continue;
    }
    const match = line.match(/^(?:#(?!!)|\/\/+|\/\*+|\*+(?!\/)|--)\s?(.*?)\s*(?:\*+\/)?$/u);
    if (!match) break;
    const content = match[1].trim();
    if (!content || /^[-=#*/~_.\s]+$/u.test(content) || NOISE.test(content)) continue;
    picked.push(content);
    if (picked.length >= 3) break;
  }
  if (!picked.length) return null;
  const cleaned = scrubTokens(compactHomeInText(picked.join(" "), homes)).replace(/[\u0000-\u001f\u007f]/gu, " ");
  return text(cleaned, DESCRIPTION_LIMIT) || null;
}

const cleanVersion = (value) => (typeof value === "string" && /^v?\d{1,6}(?:\.\d{1,9}){0,3}(?:[-+][\w.-]{1,40})?$/u.test(value.trim()) ? value.trim().replace(/^v/u, "") : null);

/** name/version from a venv's dist-info folder (uv tools, pipx). */
async function distInfo(venvRoot, wanted) {
  const normalize = (value) => value.toLowerCase().replace(/[-_.]+/gu, "_");
  for (const python of (await readdir(path.join(venvRoot, "lib")).catch(() => [])).filter((name) => /^python\d/u.test(name)).slice(0, 4)) {
    const entries = await readdir(path.join(venvRoot, "lib", python, "site-packages")).catch(() => []);
    for (const entry of entries.slice(0, 3_000)) {
      const match = entry.match(/^([^-]{1,100})-([^-]{1,40})\.dist-info$/u);
      if (match && normalize(match[1]) === normalize(wanted)) return { name: wanted, version: cleanVersion(match[2]) };
    }
  }
  return { name: wanted, version: null };
}

/** The package.json that owns a file inside node_modules. */
async function npmPackageOf(real) {
  let current = path.dirname(real);
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = path.dirname(current);
    const inModules = path.basename(parent) === "node_modules" || (path.basename(parent).startsWith("@") && path.basename(path.dirname(parent)) === "node_modules");
    if (inModules) {
      const pkg = await readBoundedJson(path.join(current, "package.json"), 512_000);
      const value = object(pkg.value);
      if (pkg.status === "ok" && typeof value.name === "string") {
        return {
          root: current,
          name: text(value.name, 120),
          version: cleanVersion(String(value.version || "")),
          keywords: Array.isArray(value.keywords) ? value.keywords.filter((item) => typeof item === "string").slice(0, 50) : [],
          description: typeof value.description === "string" ? value.description : null,
        };
      }
    }
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** `"ripgrep 14.1.0 (registry+…)" = ["rg"]` lines of ~/.cargo/.crates.toml → command → crate. */
async function cargoCrates(homeDirectory) {
  const read = await readBoundedToml(path.join(homeDirectory, ".cargo", ".crates.toml"), 1_000_000);
  const map = new Map();
  for (const [key, bins] of Object.entries(object(object(read.value).v1))) {
    const [name, version] = key.split(" ");
    for (const bin of Array.isArray(bins) ? bins : []) if (typeof bin === "string") map.set(bin, { name: text(name, 80), version: cleanVersion(version || "") });
  }
  return map;
}

/** Who installed the command, from where its real file lives. */
async function ownerOf(entry, context) {
  const { real } = entry;
  const app = real.match(/^(.*\/[^/]+\.app)(?:\/|$)/u)?.[1];
  if (app) {
    const bundle = await readAppBundle(app).catch(() => null);
    return { type: "app", name: path.basename(app, ".app"), version: bundle?.version || null, bundleId: bundle?.bundleId || null, appPath: app };
  }
  const native = real.match(/\/([\w.-]{1,64})\/versions\/([^/]{1,40})$/u);
  if (native && cleanVersion(native[2])) return { type: "native", name: native[1], version: cleanVersion(native[2]) };
  for (const home of context.homeRoots) {
    const uvTools = path.join(home, ".local", "share", "uv", "tools") + path.sep;
    if (!real.startsWith(uvTools)) continue;
    const tool = real.slice(uvTools.length).split(path.sep)[0];
    return { type: "uv", ...(await distInfo(path.join(uvTools, tool), tool)) };
  }
  const uvPython = real.match(/\/uv\/python\/cpython-(\d{1,2}\.\d{1,3}(?:\.\d{1,3})?)[^/]*\//u);
  if (uvPython) return { type: "uv", name: "cpython", version: uvPython[1] };
  for (const venvs of context.homeRoots.flatMap((home) => [path.join(home, ".local", "pipx", "venvs"), path.join(home, ".local", "share", "pipx", "venvs")])) {
    if (real.startsWith(venvs + path.sep)) {
      const venv = real.slice(venvs.length + 1).split(path.sep)[0];
      return { type: "pipx", ...(await distInfo(path.join(venvs, venv), venv)) };
    }
  }
  // Homebrew keeps every formula at <prefix>/Cellar/<formula>/<version>/ (casks: Caskroom).
  const brew = real.match(/\/(?:Cellar|Caskroom)\/([\w@.+-]{1,80})\/([^/]{1,40})\//u);
  if (brew) return { type: "homebrew", name: brew[1], version: brew[2] };
  let pkgFile = real;
  if (entry.source === "pnpm" && entry.fileKind === "script") {
    // pnpm global shims are small sh scripts: exec node "$basedir/global/5/node_modules/<pkg>/…".
    const shim = await readBoundedText(real, 16_000);
    const inner = shim.text?.match(/global\/\d{1,3}\/node_modules\/((?:@[\w.-]{1,80}\/)?[\w.-]{1,100})\/([^"'\s]{1,200})/u);
    if (inner) pkgFile = path.join(path.dirname(entry.file), "global", shim.text.match(/global\/(\d{1,3})\//u)[1], "node_modules", inner[1], inner[2]);
  }
  if (pkgFile.includes(`${path.sep}node_modules${path.sep}`)) {
    const pkg = await npmPackageOf(pkgFile);
    if (pkg) {
      const manager = pkgFile.includes(`${path.sep}.bun${path.sep}`) ? "bun" : entry.source === "pnpm" ? "pnpm" : "npm";
      return { type: "npm", name: pkg.name, version: pkg.version, manager, keywords: pkg.keywords, packageDescription: pkg.description };
    }
  }
  if (entry.source === "cargo") {
    const crate = (await context.crates()).get(entry.name);
    if (crate) return { type: "cargo", ...crate };
  }
  return null;
}

/** One folder entry → an executable command, or null (folders, non-executables, broken links). */
async function readEntry(directory, name, source) {
  const file = path.join(directory, name);
  const info = await lstat(file).catch(() => null);
  if (!info || info.isDirectory()) return null;
  const real = await realpath(file).catch(() => null);
  if (!real) return null;
  const resolved = await stat(real).catch(() => null);
  if (!resolved?.isFile() || !(resolved.mode & 0o111)) return null;
  const link = info.isSymbolicLink() ? await readlink(file).catch(() => null) : null;
  const head = await readHead(real);
  const { kind: fileKind, interpreter } = fileKindOf(head);
  return {
    name,
    file,
    real,
    source: source.source,
    sourceLabel: source.label || null,
    prefix: source.prefixReal || source.prefix || null,
    isLink: Boolean(link),
    target: link ? path.resolve(directory, link) : null,
    fileKind,
    interpreter,
    head,
    size: resolved.size,
    mtime: new Date(resolved.mtimeMs).toISOString(),
  };
}

async function listNames(source) {
  const limit = source.source === "prefix" ? PREFIX_ENTRY_LIMIT : ENTRY_LIMIT;
  const names = (await readdir(source.directory).catch(() => [])).filter((name) => NAME.test(name) && !name.startsWith(".")).sort();
  return { source, names: names.slice(0, limit), truncated: names.length > limit };
}

/** uv tool entry points from each tool's uv-receipt.toml (when installed outside ~/.local/bin). */
async function uvEntryPoints(homeDirectory) {
  const root = path.join(homeDirectory, ".local", "share", "uv", "tools");
  const files = [];
  for (const tool of (await readdir(root).catch(() => [])).slice(0, 200)) {
    const receipt = await readBoundedToml(path.join(root, tool, "uv-receipt.toml"), 256_000);
    for (const point of Array.isArray(object(object(receipt.value).tool).entrypoints) ? receipt.value.tool.entrypoints : []) {
      const installPath = object(point)["install-path"];
      if (typeof installPath === "string" && path.isAbsolute(installPath) && NAME.test(path.basename(installPath))) files.push(installPath);
    }
  }
  return files;
}

function aiReasonsOf(tool, { referenced, owner }) {
  const reasons = [];
  if (referenced) reasons.push("skill-reference");
  if (KNOWN_AI_COMMANDS.has(tool.name) || (owner?.type === "npm" && AI_PACKAGES.has(owner.name))) reasons.push("known-ai-cli");
  if (owner?.type === "app" && (appBundleIds.has(owner.bundleId) || appNames.has(owner.name) || AI_APP_NAME.test(owner.name))) reasons.push("ai-app");
  if (owner?.type === "npm" && owner.keywords?.some((keyword) => keyword.toLowerCase().split(/[\s_/-]+/u).some((part) => AI_KEYWORDS.has(part)))) reasons.push("npm-keywords");
  if (tool.source === "local-bin" && !isGeneric(tool.name)) reasons.push("local-bin");
  return reasons;
}

/** For each Agent: its PATH and allow rules, read once. */
async function agentContexts(agents, homeDirectory, launchctlPath) {
  const contexts = [];
  for (const agentId of agents) {
    const source = await agentPathSource(agentId, homeDirectory, { launchctlPath }).catch(() => null);
    if (!source) continue;
    contexts.push({ agentId, pathSource: source.via, path: source.path || [], rules: await loadAllowRules(agentId, homeDirectory).catch(() => null) });
  }
  return contexts;
}

/** First executable `name` on a PATH (directory listings cached across Agents). */
function createResolver() {
  const listings = new Map();
  const executables = new Map();
  const listing = async (directory) => {
    if (!listings.has(directory)) listings.set(directory, new Set(await readdir(directory).catch(() => [])));
    return listings.get(directory);
  };
  const executable = async (file) => {
    if (!executables.has(file)) {
      const info = await stat(file).catch(() => null);
      executables.set(file, Boolean(info?.isFile() && info.mode & 0o111) ? await realpath(file).catch(() => file) : null);
    }
    return executables.get(file);
  };
  return async (name, entries) => {
    for (const directory of entries.slice(0, 80)) {
      if (!(await listing(directory)).has(name)) continue;
      const real = await executable(path.join(directory, name));
      if (real) return { file: path.join(directory, name), real };
    }
    return null;
  };
}

/**
 * Lists the tools. Options: homeDirectory, homes, stateDirectory (skill-mention cache),
 * skillFiles [{ file, name }], agents (ids with a PATH source), agentNames, launchctlPath,
 * systemPrefixes (Homebrew / system node; empty in tests), sources (override for tests).
 */
export async function inventoryCliTools({
  homeDirectory,
  homes = [homeDirectory],
  stateDirectory = null,
  skillFiles = [],
  agents = [],
  agentNames = {},
  launchctlPath = null,
  systemPrefixes = [],
  sources = null,
}) {
  const displayHomes = [...new Set([...homes, ...(await homeVariants(homeDirectory))])];
  const display = (value) => (value ? compactHomePath(value, displayHomes) : null);
  const listed = sources || inventorySources(homeDirectory, { systemPrefixes, nvmVersions: await nvmVersionsOf(homeDirectory) });
  // Real paths (/private/var/… for /var/…) so "inside this prefix" compares like with like.
  const list = await Promise.all(listed.map(async (source) => (source.prefix ? { ...source, prefixReal: await realpath(source.prefix).catch(() => source.prefix) } : source)));
  const homeRoots = [...new Set([homeDirectory, await realpath(homeDirectory).catch(() => homeDirectory)])];
  let truncated = false;
  let hiddenBackups = 0;
  const agentList = await agentContexts(agents, homeDirectory, launchctlPath);
  const agentCommands = new Set(agentList.flatMap((agent) => [...(agent.rules?.commands || [])]));
  const listings = [];
  for (const source of list) {
    const listing = await listNames(source);
    truncated ||= listing.truncated;
    listings.push(listing);
  }
  const uvFiles = await uvEntryPoints(homeDirectory);
  // Mentions first, so Homebrew's hundreds of commands are read only when something names them.
  const mentions = await findSkillMentions({
    skillFiles,
    names: [...new Set([...listings.flatMap((listing) => listing.names), ...uvFiles.map((file) => path.basename(file))])].filter((name) => !BACKUP.test(name)),
    cacheFile: stateDirectory ? path.join(stateDirectory, "cli-skill-mentions.json") : null,
  });
  truncated ||= mentions.truncated;
  const named = (name) => mentions.byName.has(name) || agentCommands.has(name);
  const entries = [];
  for (const { source, names } of listings) {
    for (const name of names) {
      if (source.source === "prefix" && !named(name)) {
        // Unnamed system commands: only npm packages (a cheap readlink decides).
        const link = await readlink(path.join(source.directory, name)).catch(() => null);
        if (!link?.includes(`node_modules${path.sep}`)) continue;
      }
      const entry = await readEntry(source.directory, name, source);
      if (entry) entries.push(entry);
    }
  }
  for (const file of uvFiles) {
    if (entries.some((entry) => entry.file === file)) continue;
    const entry = await readEntry(path.dirname(file), path.basename(file), { source: "uv" });
    if (entry) entries.push(entry);
  }

  let crates = null;
  const context = { homeRoots, crates: async () => (crates ||= await cargoCrates(homeDirectory)) };
  // One row per command name + real file; later copies of the same file become links.
  const rows = new Map();
  for (const entry of entries) {
    if (BACKUP.test(entry.name)) {
      hiddenBackups += 1;
      continue;
    }
    const key = `${entry.name}\u0000${entry.real}`;
    if (rows.has(key)) {
      const row = rows.get(key);
      if (row.links.length < 5) row.links.push(entry.file);
      continue;
    }
    let source = entry.source;
    if (source === "npm" || source === "prefix") {
      // Package folders only: node itself, npm and corepack ship with Node.
      const modules = entry.prefix ? path.join(entry.prefix, "lib", "node_modules") + path.sep : null;
      const inModules = Boolean(modules && entry.real.startsWith(modules));
      if (source === "npm" && !inModules) continue;
      if (inModules && BUNDLED_NPM.has(entry.real.slice(modules.length).split(path.sep)[0])) continue;
      source = inModules ? "npm" : "homebrew";
    }
    rows.set(key, { ...entry, source, links: [] });
    if (rows.size >= TOOL_LIMIT) {
      truncated = true;
      break;
    }
  }

  const resolve = createResolver();

  const tools = [];
  const counts = new Map();
  for (const row of rows.values()) {
    const referencedBy = mentions.byName.get(row.name) || [];
    // Homebrew has hundreds of commands: only the ones a skill or an Agent names.
    if (row.source === "homebrew" && !referencedBy.length && !agentCommands.has(row.name)) continue;
    const owner = await ownerOf(row, context).catch(() => null);
    const reasons = aiReasonsOf(row, { referenced: referencedBy.length > 0, owner });
    const description = row.fileKind === "script" ? scriptDescription(row.head, displayHomes) : null;
    const availability = [];
    for (const agent of agentList) {
      const found = await resolve(row.name, agent.path);
      const same = found && (found.real === row.real || found.file === row.file);
      availability.push({
        agentId: agent.agentId,
        agentName: agentNames[agent.agentId] || AGENT_DISPLAY_NAMES[agent.agentId] || agent.agentId,
        available: Boolean(same),
        detail: same ? `${agent.pathSource}：${display(found.file)}` : found ? `会先找到另一份：${display(found.file)}` : `${agent.pathSource} 里找不到`,
        allowed: agent.rules ? agent.rules.check(row.name) : "n/a",
      });
    }
    const index = (counts.get(row.name) || 0) + 1;
    counts.set(row.name, index);
    const packageDescription = owner?.packageDescription ? text(scrubTokens(compactHomeInText(owner.packageDescription, displayHomes)), DESCRIPTION_LIMIT) : null;
    tools.push({
      id: index === 1 ? row.name : `${row.name}~${index}`,
      name: row.name,
      path: display(row.file),
      source: row.source,
      ...(row.sourceLabel ? { sourceLabel: compactHomeInText(row.sourceLabel, displayHomes) } : {}),
      kind: row.isLink ? "symlink" : row.fileKind,
      fileKind: row.fileKind,
      ...(row.interpreter ? { interpreter: row.interpreter } : {}),
      ...(row.target ? { target: display(row.target) } : {}),
      ...(row.links.length ? { links: row.links.map(display) } : {}),
      owner: owner ? { type: owner.type, name: owner.name || null, version: owner.version || null, ...(owner.manager && owner.manager !== "npm" ? { manager: owner.manager } : {}), ...(owner.bundleId ? { bundleId: owner.bundleId } : {}) } : null,
      description: description || packageDescription || null,
      size: row.size,
      mtime: row.mtime,
      referencedBySkills: referencedBy.slice(0, SKILL_NAME_LIMIT),
      referencedCount: referencedBy.length,
      aiRelated: reasons.length > 0,
      aiReasons: reasons,
      agents: availability,
    });
  }
  tools.sort((left, right) => Number(right.aiRelated) - Number(left.aiRelated) || left.name.localeCompare(right.name, "en"));
  const tally = (key) => tools.reduce((result, tool) => ({ ...result, [key(tool)]: (result[key(tool)] || 0) + 1 }), {});
  return {
    tools,
    summary: {
      total: tools.length,
      aiRelated: tools.filter((tool) => tool.aiRelated).length,
      referencedBySkills: tools.filter((tool) => tool.referencedCount > 0).length,
      hiddenBackups,
      bySource: tally((tool) => tool.source),
      byKind: tally((tool) => tool.kind),
      skillFilesScanned: mentions.scanned,
      truncated,
    },
  };
}
