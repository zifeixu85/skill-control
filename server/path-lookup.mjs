import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Finds command-line tools the way a shell would, without running anything: the
 * service's PATH plus folders GUI-launched agents often miss (Homebrew, ~/.local/bin,
 * every nvm Node version …). Tools found only under nvm are flagged, because an agent
 * started from the Dock does not load nvm.
 */

const BIN_NAME = /^[\w.+-]{1,64}$/u;

export async function defaultSearchDirectories({ homeDirectory = homedir(), envPath = process.env.PATH || "" } = {}) {
  const fromPath = envPath.split(path.delimiter).filter((entry) => entry && path.isAbsolute(entry));
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    path.join(homeDirectory, ".local", "bin"),
    path.join(homeDirectory, ".cargo", "bin"),
    path.join(homeDirectory, ".bun", "bin"),
    path.join(homeDirectory, ".volta", "bin"),
    path.join(homeDirectory, ".npm-global", "bin"),
    path.join(homeDirectory, "Library", "pnpm"),
    path.join(homeDirectory, ".claude", "local"),
  ];
  const nvmRoot = path.join(homeDirectory, ".nvm", "versions", "node");
  let nvm = [];
  try {
    nvm = (await readdir(nvmRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .slice(0, 50)
      .map((entry) => path.join(nvmRoot, entry.name, "bin"));
  } catch {
    nvm = [];
  }
  const isNvm = (directory) => directory.startsWith(`${path.join(homeDirectory, ".nvm")}${path.sep}`);
  const directories = [...new Set([...fromPath, ...extra, ...nvm])];
  return directories.map((directory) => ({ directory, nvm: isNvm(directory) }));
}

async function isExecutable(file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Returns a resolver: name → { found, nvmOnly } (absolute paths are checked directly). */
export function createCommandLookup(directories) {
  const cache = new Map();
  return async function lookup(command) {
    if (typeof command !== "string" || !command) return { found: false, nvmOnly: false, checked: false };
    if (path.isAbsolute(command)) return { found: await isExecutable(command), nvmOnly: false, checked: true };
    if (!BIN_NAME.test(command)) return { found: false, nvmOnly: false, checked: false };
    if (cache.has(command)) return cache.get(command);
    let inNvm = false;
    let elsewhere = false;
    for (const { directory, nvm } of directories) {
      if (nvm && inNvm) continue;
      if (!(await isExecutable(path.join(directory, command)))) continue;
      if (!nvm) {
        elsewhere = true;
        break;
      }
      inNvm = true;
    }
    const result = { found: inNvm || elsewhere, nvmOnly: inNvm && !elsewhere, checked: true };
    cache.set(command, result);
    return result;
  };
}

/**
 * Absolute path of a command for running it with execFile: the first match outside nvm,
 * else the first nvm match. Returns null when the name is not a plain command name.
 */
export async function findCommand(command, directories) {
  if (typeof command !== "string" || !BIN_NAME.test(command)) return null;
  let fallback = null;
  for (const { directory, nvm } of directories) {
    const candidate = path.join(directory, command);
    if (!(await isExecutable(candidate))) continue;
    if (!nvm) return candidate;
    fallback ||= candidate;
  }
  return fallback;
}
