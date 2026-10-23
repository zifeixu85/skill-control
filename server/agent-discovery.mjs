import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { readAppBundle } from "./config-files.mjs";
import { compactHomePath, isWithin, text } from "./fs-safe.mjs";

/**
 * GET /api/agents/discover: places that look like an Agent's skill folder but belong to no
 * known Agent. Looks for `skills/<name>/SKILL.md` under ~/.* and ~/Library/Application
 * Support/* (up to two levels below each), at app bundles in /Applications and
 * ~/Applications that no known Agent claims (Info.plist only, matched to ~/.<name> and the
 * like), and at ~/.local/bin entries that link into an app or launch something with its own
 * ~/.<name> folder. Bounded in entries, depth and time; links that leave the home
 * directory are not followed; nothing is executed.
 */

const ENTRY_LIMIT = 500;
const SKILL_LIMIT = 1_000;
const CANDIDATE_LIMIT = 40;
const DEFAULT_BUDGET_MS = 3_000;
/** Dot folders that are caches, toolchains or credentials, never Agents. */
const SKIPPED_DOT_DIRS = new Set([
  ".Trash", ".cache", ".npm", ".nvm", ".git", ".ssh", ".gnupg", ".docker", ".cargo", ".rustup", ".pyenv", ".bun", ".deno",
  ".gradle", ".m2", ".android", ".cocoapods", ".zsh_sessions", ".vscode", ".vscode-insiders", ".oh-my-zsh", ".local",
  ".agent-skill-manager", ".agents", ".pnpm-store", ".yarn", ".node-gyp", ".lldb", ".ipython", ".jupyter", ".conda",
]);

const slug = (value) =>
  String(value || "")
    .replace(/^\./u, "")
    .toLowerCase()
    .replace(/\.app$/u, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);

const guess = (value) => {
  const name = String(value || "").replace(/^\./u, "").replace(/\.app$/u, "");
  return text(name.charAt(0).toUpperCase() + name.slice(1), 48) || name;
};

async function directoryEntries(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true })).slice(0, ENTRY_LIMIT);
  } catch {
    return [];
  }
}

/** A real directory inside the home (links are followed only when they stay inside). */
async function isInsideDirectory(candidate, homeDirectory, realHome) {
  const info = await lstat(candidate).catch(() => null);
  if (!info) return false;
  if (info.isDirectory()) return true;
  if (!info.isSymbolicLink()) return false;
  const real = await realpath(candidate).catch(() => null);
  return Boolean(real && (isWithin(realHome, real) || isWithin(homeDirectory, real)) && (await stat(real).catch(() => null))?.isDirectory());
}

async function countSkills(skillsDirectory) {
  let count = 0;
  for (const entry of await directoryEntries(skillsDirectory)) {
    if (entry.name.startsWith(".") || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    if ((await stat(path.join(skillsDirectory, entry.name, "SKILL.md")).catch(() => null))?.isFile()) count += 1;
    if (count >= SKILL_LIMIT) break;
  }
  return count;
}

/** `<base>/skills` and `<base>/<child>/skills` folders with at least one skill. */
async function skillFoldersUnder(base, context) {
  const found = [];
  const check = async (directory) => {
    if (context.now() > context.deadline) return;
    const skills = path.join(directory, "skills");
    if (!(await isInsideDirectory(skills, context.homeDirectory, context.realHome))) return;
    const count = await countSkills(skills);
    if (count) found.push({ skillsPath: skills, skillCount: count });
  };
  await check(base);
  for (const entry of await directoryEntries(base)) {
    if (context.now() > context.deadline) break;
    if (entry.name === "skills" || entry.name === "node_modules" || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
    const child = path.join(base, entry.name);
    if (context.isAgentHome(child)) continue;
    if (await isInsideDirectory(child, context.homeDirectory, context.realHome)) await check(child);
  }
  return found;
}

/** Apps no known Agent claims: name, bundle id and the folders that would belong to them. */
async function unknownApps(applicationDirectories, knownApps) {
  const apps = [];
  for (const directory of applicationDirectories) {
    for (const entry of await directoryEntries(directory)) {
      if (!entry.name.endsWith(".app") || knownApps.names.has(entry.name)) continue;
      const appPath = path.join(directory, entry.name);
      const bundle = await readAppBundle(appPath).catch(() => null);
      if (!bundle || knownApps.bundleIds.has(bundle.bundleId)) continue;
      apps.push({ appPath, name: entry.name.replace(/\.app$/u, ""), bundleId: bundle.bundleId || null, version: bundle.version || null });
      if (apps.length >= 300) return apps;
    }
  }
  return apps;
}

/** ~/.local/bin leads: links into an .app bundle, and launchers whose name has a ~/.<name> folder. */
async function localBinLeads(homeDirectory) {
  const leads = [];
  const bin = path.join(homeDirectory, ".local", "bin");
  for (const entry of await directoryEntries(bin)) {
    if (entry.name.startsWith(".") || /\.(?:bak|old)$/u.test(entry.name)) continue;
    const file = path.join(bin, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(file).catch(() => null);
      const absolute = target ? path.resolve(bin, target) : null;
      // The innermost bundle (pcsuite.app/…/VClaw.app → VClaw.app).
      const appMatch = absolute?.match(/^(.*\/[^/]+\.app)(?:\/|$)/u);
      if (appMatch) {
        leads.push({ command: entry.name, appPath: appMatch[1] });
        continue;
      }
    }
    leads.push({ command: entry.name, appPath: null });
  }
  return leads;
}

/**
 * `known`: { roots: absolute skill folders of known Agents, ids, apps: { names, bundleIds } };
 * the folder holding each root's `skills` (e.g. ~/.codex, ~/.config/opencode) is that Agent's
 * home and is not searched. `ignored`: candidate paths ("~/…") the user dismissed.
 */
export async function discoverAgents({ homeDirectory, homes = [homeDirectory], known, ignored = [], applicationDirectories = [], budgetMs = DEFAULT_BUDGET_MS, now = () => Date.now() }) {
  const agentHomes = new Set(known.roots.filter((root) => path.basename(root) === "skills").map((root) => path.resolve(path.dirname(root))));
  const context = {
    homeDirectory,
    realHome: await realpath(homeDirectory).catch(() => homeDirectory),
    now,
    deadline: now() + budgetMs,
    isAgentHome: (directory) => agentHomes.has(path.resolve(directory)),
  };
  const display = (value) => compactHomePath(value, homes);
  const knownRoots = await Promise.all(known.roots.map(async (root) => (await realpath(root).catch(() => root))));
  const ignoredSet = new Set(ignored);
  const candidates = new Map();
  const isKnown = async (skillsPath) => {
    const real = await realpath(skillsPath).catch(() => skillsPath);
    return knownRoots.some((root) => real === root || isWithin(root, real) || isWithin(real, root));
  };
  const add = async (base, found, details) => {
    const pathText = display(found.skillsPath);
    if (ignoredSet.has(pathText) || (await isKnown(found.skillsPath))) return;
    let id = slug(details.id || path.basename(base)) || "agent";
    if (known.ids.has(id)) return;
    const existing = candidates.get(pathText);
    if (existing) {
      Object.assign(existing, details.appPath && !existing.appPath ? { appPath: display(details.appPath), guessName: details.guessName || existing.guessName } : {});
      return;
    }
    let suffix = 2;
    while ([...candidates.values()].some((item) => item.id === id)) id = `${slug(details.id || path.basename(base))}-${suffix++}`;
    candidates.set(pathText, {
      id,
      guessName: details.guessName || guess(path.basename(base)),
      path: pathText,
      skillCount: found.skillCount,
      ...(details.appPath ? { appPath: display(details.appPath) } : {}),
      reason: details.reason,
    });
  };

  // 1. ~/.* and ~/Library/Application Support/*.
  for (const entry of await directoryEntries(homeDirectory)) {
    if (now() > context.deadline || candidates.size >= CANDIDATE_LIMIT) break;
    const base = path.join(homeDirectory, entry.name);
    if (!entry.name.startsWith(".") || SKIPPED_DOT_DIRS.has(entry.name) || context.isAgentHome(base)) continue;
    if (!(await isInsideDirectory(base, homeDirectory, context.realHome))) continue;
    for (const found of await skillFoldersUnder(base, context)) {
      await add(base, found, { reason: `${display(found.skillsPath)} 下有 ${found.skillCount} 个技能，不属于已知的 Agent` });
    }
  }
  const support = path.join(homeDirectory, "Library", "Application Support");
  for (const entry of await directoryEntries(support)) {
    if (now() > context.deadline || candidates.size >= CANDIDATE_LIMIT) break;
    const base = path.join(support, entry.name);
    if (entry.name.startsWith(".") || context.isAgentHome(base)) continue;
    if (!(await isInsideDirectory(base, homeDirectory, context.realHome))) continue;
    for (const found of await skillFoldersUnder(base, context)) {
      await add(base, found, { reason: `应用数据 ${display(found.skillsPath)} 下有 ${found.skillCount} 个技能` });
    }
  }

  // 2. Apps (and ~/.local/bin links into apps) matched to their own folders.
  const apps = await unknownApps(applicationDirectories, known.apps);
  const leads = await localBinLeads(homeDirectory);
  const appByPath = new Map(apps.map((app) => [app.appPath, app]));
  for (const lead of leads) {
    if (lead.appPath && !appByPath.has(lead.appPath)) {
      const bundle = await readAppBundle(lead.appPath).catch(() => null);
      if (bundle && !known.apps.bundleIds.has(bundle.bundleId)) {
        const app = { appPath: lead.appPath, name: path.basename(lead.appPath, ".app"), bundleId: bundle.bundleId || null, version: bundle.version || null, via: lead.command };
        apps.push(app);
        appByPath.set(lead.appPath, app);
      }
    } else if (lead.appPath) {
      appByPath.get(lead.appPath).via = lead.command;
    }
  }
  for (const app of apps) {
    if (now() > context.deadline || candidates.size >= CANDIDATE_LIMIT) break;
    const names = [...new Set([app.name, app.bundleId?.split(".").at(-1), app.via].filter(Boolean))];
    const clues = [
      ...new Set(
        names
          .flatMap((name) => [slug(name) ? path.join(homeDirectory, `.${slug(name)}`) : null, path.join(support, name)])
          .concat(app.bundleId ? [path.join(support, app.bundleId)] : [])
          // Never the home or Application Support folder itself (a name with no Latin letters).
          .filter((clue) => clue && clue !== homeDirectory && clue !== support && path.basename(clue) !== "."),
      ),
    ];
    let matched = false;
    for (const clue of clues) {
      if (!(await isInsideDirectory(clue, homeDirectory, context.realHome))) continue;
      for (const found of await skillFoldersUnder(clue, context)) {
        matched = true;
        await add(clue, found, { id: app.name, guessName: app.name, appPath: app.appPath, reason: `应用 ${app.name}${app.version ? ` ${app.version}` : ""} 的 ${display(found.skillsPath)} 下有 ${found.skillCount} 个技能` });
      }
    }
    // A command-line link into an app is a lead even before the app has skills.
    if (!matched && app.via) {
      const pathText = display(app.appPath);
      if (!ignoredSet.has(pathText) && !known.ids.has(slug(app.name)) && !candidates.has(pathText)) {
        candidates.set(pathText, {
          id: slug(app.name) || slug(app.bundleId?.split(".").at(-1)) || "app",
          guessName: app.name,
          path: pathText,
          skillCount: 0,
          appPath: pathText,
          reason: `~/.local/bin/${app.via} 指向 ${app.name}.app，还没有找到它的技能目录`,
        });
      }
    }
  }
  // 3. Launchers in ~/.local/bin with a ~/.<name>/skills folder found above get the lead noted.
  for (const lead of leads.filter((item) => !item.appPath)) {
    const candidate = [...candidates.values()].find((item) => item.id === slug(lead.command));
    if (candidate && !candidate.launcher) candidate.launcher = `~/.local/bin/${lead.command}`;
  }
  return {
    candidates: [...candidates.values()].sort((left, right) => right.skillCount - left.skillCount || left.id.localeCompare(right.id)),
    truncated: now() > context.deadline || candidates.size >= CANDIDATE_LIMIT,
  };
}
