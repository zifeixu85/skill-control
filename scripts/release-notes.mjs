import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Release workflow helper: docs/releases/vX.Y.Z.md may start with front matter
 *
 *   ---
 *   prerelease: true
 *   ---
 *
 * `prerelease: true` publishes the GitHub Release as a pre-release. The body after the
 * front matter becomes the release notes.
 *
 * Usage: node scripts/release-notes.mjs <notes.md> <body-output.md>
 * Prints `found=…` and `prerelease=…` lines for $GITHUB_OUTPUT.
 */

const KNOWN_KEYS = new Set(["prerelease"]);

/** { prerelease, body } from a notes file; front matter is optional and strictly checked. */
export function splitReleaseNotes(text) {
  const normalized = String(text).replace(/^﻿/u, "").replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---\n")) return { prerelease: false, body: normalized.trim() };
  const end = normalized.indexOf("\n---\n", 3);
  const closing = end >= 0 ? end : normalized.endsWith("\n---") ? normalized.length - 4 : -1;
  if (closing < 0) throw new Error("Release notes front matter is not closed with ---.");
  const meta = {};
  for (const line of normalized.slice(4, closing).split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/u.exec(line);
    if (!match || !KNOWN_KEYS.has(match[1])) throw new Error(`Unknown release notes front matter: ${line}`);
    if (match[2] !== "true" && match[2] !== "false") throw new Error(`${match[1]} must be true or false.`);
    meta[match[1]] = match[2] === "true";
  }
  return { prerelease: meta.prerelease === true, body: normalized.slice(closing + 5).trim() };
}

async function main([notesFile, bodyFile]) {
  if (!notesFile || !bodyFile) throw new Error("Usage: node scripts/release-notes.mjs <notes.md> <body-output.md>");
  let text;
  try {
    text = await readFile(notesFile, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    process.stdout.write("found=false\nprerelease=false\n");
    return;
  }
  const { prerelease, body } = splitReleaseNotes(text);
  if (!body) throw new Error(`${notesFile} has no release notes after the front matter.`);
  await writeFile(bodyFile, `${body}\n`, "utf8");
  process.stdout.write(`found=true\nprerelease=${prerelease}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[release-notes] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
