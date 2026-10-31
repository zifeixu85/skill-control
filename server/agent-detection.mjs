import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { AGENT_APPS } from "./agent-icons.mjs";
import { applicationDirectoriesFor, readAppBundle } from "./config-files.mjs";
import { hermesHomeFor } from "./hermes.mjs";
import { raccoonAppDataDir } from "./office-raccoon.mjs";
import { createCommandLookup, defaultSearchDirectories } from "./path-lookup.mjs";

/**
 * Whether an Agent is installed, from the product's own files, commands and apps (v0.3,
 * review issues 3 and 8). Skill folders never count: Skill Control, `npx skills` and other
 * tools create them for Agents that are not installed, and the shared library
 * ~/.agents/skills belongs to no Agent.
 *
 * Per Agent:
 * - `files`: product files or folders whose existence is enough (settings, sessions, binaries);
 * - `homes`: the product's home folders, which count when they hold anything besides `skills`
 *   (a home with only a skills folder was made by a skills tool, not by the product);
 * - `commands`: command names on the search path;
 * - `apps`: an app bundle from agent-icons' AGENT_APPS (name and bundle id);
 * - `extensions`: VS Code-style extension id prefixes (Cline, Roo Code).
 */
export const INSTALL_EVIDENCE = {
  codex: { files: ["~/.codex/config.toml", "~/.codex/sessions", "~/.codex/auth.json", "~/.codex/history.jsonl"], commands: ["codex"], apps: true },
  claude: { files: ["~/.claude/settings.json", "~/.claude/projects", "~/.claude.json", "~/.claude/local/claude", "~/.local/bin/claude"], commands: ["claude"] },
  workbuddy: { homes: ["~/.workbuddy"], apps: true },
  cursor: { homes: ["~/.cursor"], commands: ["cursor-agent"], apps: true },
  smartorder: { files: ["~/.smartorder/config.toml"], apps: true },
  gemini: { homes: ["~/.gemini"], commands: ["gemini"] },
  kiro: { homes: ["~/.kiro"], commands: ["kiro-cli"], apps: true },
  trae: { homes: ["~/.trae", "~/.trae-cn"], apps: true },
  opencode: { homes: ["~/.config/opencode", "~/.local/share/opencode"], commands: ["opencode"] },
  windsurf: { homes: ["~/.windsurf", "~/.codeium/windsurf"], apps: true },
  cline: { homes: ["~/.cline"], commands: ["cline"], extensions: ["saoudrizwan.claude-dev-"] },
  "roo-code": { homes: ["~/.roo", "~/.roo-code"], extensions: ["rooveterinaryinc.roo-cline-"] },
  codebuddy: { homes: ["~/.codebuddy"], commands: ["codebuddy"] },
  "qwen-code": { homes: ["~/.qwen", "~/.qwen-code"], commands: ["qwen"] },
  copilot: { homes: ["~/.copilot"], commands: ["copilot"] },
  hermes: { homes: ["<hermes>"], commands: ["hermes"], apps: true },
  openclaw: { homes: ["~/.openclaw", "~/.clawdbot", "~/.moltbot"], commands: ["openclaw"] },
  qclaw: { files: ["~/.qclaw/qclaw.json"], apps: true },
  "office-raccoon": { files: ["<raccoon>/settings.json", "~/.box-agent/config"], apps: true },
};

/** Entries a skills tool may create inside a product home; anything else means the product ran. */
const SKILL_ONLY_ENTRIES = new Set(["skills", ".DS_Store"]);
const EXTENSION_DIRECTORIES = ["~/.vscode/extensions", "~/.vscode-insiders/extensions", "~/.cursor/extensions", "~/.windsurf/extensions"];

function expand(entry, homeDirectory) {
  if (entry === "<hermes>") return hermesHomeFor(homeDirectory);
  if (entry.startsWith("<raccoon>/")) return path.join(raccoonAppDataDir(homeDirectory), entry.slice("<raccoon>/".length));
  return entry.startsWith("~/") ? path.join(homeDirectory, entry.slice(2)) : entry;
}

const compact = (file, homeDirectory) => (file === homeDirectory ? "~" : file.startsWith(`${homeDirectory}${path.sep}`) ? `~/${file.slice(homeDirectory.length + 1)}` : file);

async function exists(file) {
  return Boolean(await stat(file).catch(() => null));
}

async function homeInUse(directory) {
  const entries = await readdir(directory).catch(() => null);
  return Boolean(entries?.some((name) => !SKILL_ONLY_ENTRIES.has(name)));
}

/**
 * Where commands are looked up: SKILL_MANAGER_COMMAND_DIRS when set (tests, sandboxes); the
 * normal search path for the real home; only folders inside any other (fake) home.
 */
export async function detectionCommandDirectories(homeDirectory = homedir(), env = process.env) {
  const pinned = String(env.SKILL_MANAGER_COMMAND_DIRS || "")
    .split(path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry));
  if (pinned.length) return pinned.map((directory) => ({ directory, nvm: false }));
  const all = await defaultSearchDirectories({ homeDirectory, envPath: env.PATH || "" });
  return homeDirectory === homedir() ? all : all.filter(({ directory }) => directory.startsWith(`${homeDirectory}${path.sep}`));
}

/**
 * Detects every Agent in INSTALL_EVIDENCE (or `agentIds`). Returns a Map agentId →
 * { installed, evidence: ["~/.claude.json", "command:claude", "app:Codex.app", …] } with
 * the first matching evidence of each kind (home paths compacted to "~").
 */
export async function detectInstalledAgents({
  homeDirectory = homedir(),
  env = process.env,
  agentIds = Object.keys(INSTALL_EVIDENCE),
  applicationDirectories = applicationDirectoriesFor(homeDirectory, env),
  commandDirectories = null,
} = {}) {
  const lookup = createCommandLookup(commandDirectories || (await detectionCommandDirectories(homeDirectory, env)));
  let extensionNames = null;
  const extensions = async () => {
    if (!extensionNames) {
      const lists = await Promise.all(EXTENSION_DIRECTORIES.map((entry) => readdir(expand(entry, homeDirectory)).catch(() => [])));
      extensionNames = lists.flat().map((name) => name.toLowerCase());
    }
    return extensionNames;
  };
  const results = new Map();
  await Promise.all(
    agentIds.map(async (agentId) => {
      const spec = INSTALL_EVIDENCE[agentId];
      if (!spec) return;
      const evidence = [];
      for (const entry of spec.files || []) {
        const file = expand(entry, homeDirectory);
        if (await exists(file)) {
          evidence.push(compact(file, homeDirectory));
          break;
        }
      }
      for (const entry of spec.homes || []) {
        const directory = expand(entry, homeDirectory);
        if (await homeInUse(directory)) {
          evidence.push(compact(directory, homeDirectory));
          break;
        }
      }
      for (const command of spec.commands || []) {
        if ((await lookup(command)).found) {
          evidence.push(`command:${command}`);
          break;
        }
      }
      if (spec.apps && AGENT_APPS[agentId]) {
        const app = await findApp(AGENT_APPS[agentId], applicationDirectories);
        if (app) evidence.push(`app:${app}`);
      }
      if (spec.extensions?.length) {
        const names = await extensions();
        const match = spec.extensions.find((prefix) => names.some((name) => name.startsWith(prefix)));
        if (match) evidence.push(`extension:${match.replace(/-$/u, "")}`);
      }
      results.set(agentId, { installed: evidence.length > 0, evidence });
    }),
  );
  return results;
}

async function findApp(spec, applicationDirectories) {
  for (const directory of applicationDirectories) {
    for (const name of spec.names) {
      const bundle = await readAppBundle(path.join(directory, name)).catch(() => null);
      if (bundle && (!spec.bundleIds.length || spec.bundleIds.includes(bundle.bundleId))) return name;
    }
  }
  return null;
}

/** "present" when any of the Agent's skill folders exists, else "missing" (installed, no skills folder yet). */
export async function skillsDirectoryState(paths, homeDirectory = homedir()) {
  const found = await Promise.all(paths.map((entry) => exists(expand(entry, homeDirectory))));
  return found.some(Boolean) ? "present" : "missing";
}
