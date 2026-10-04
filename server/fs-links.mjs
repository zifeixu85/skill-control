import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

/**
 * Link creation and on-disk classification for the library. Links point at the library
 * through a relative path where possible. On Windows without symlink rights the
 * fallback is a junction, then a copy (which records the source hash for re-copying).
 */

/** lstat-based class of a destination: absent, link-to-library, foreign-link, broken-link, real-dir, real-file. */
export async function classifyPath(target, libraryEntry, { fsImpl = fs } = {}) {
  let info;
  try {
    info = await fsImpl.lstat(target);
  } catch {
    return { kind: "absent" };
  }
  if (info.isSymbolicLink()) {
    const linkTarget = await fsImpl.readlink(target);
    let real = null;
    try {
      real = await fsImpl.realpath(target);
    } catch {
      return { kind: "broken-link", linkTarget };
    }
    const realLibrary = libraryEntry ? await fsImpl.realpath(libraryEntry).catch(() => null) : null;
    return { kind: realLibrary && real === realLibrary ? "link-to-library" : "foreign-link", linkTarget, real };
  }
  if (info.isDirectory()) return { kind: "real-dir" };
  return { kind: "real-file" };
}

/** Content hash of a folder: sorted relative paths and bytes; .git, node_modules and .DS_Store ignored. */
export async function contentHash(directory, { maxFiles = 3_000, maxBytes = 200_000_000 } = {}) {
  const files = [];
  let bytes = 0;
  async function walk(current, relative) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if ([".git", "node_modules", ".DS_Store"].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(full, childRelative);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        if (files.length >= maxFiles) throw new Error("too-many-files");
        files.push({ childRelative, full, link: entry.isSymbolicLink() });
      }
    }
  }
  try {
    await walk(directory, "");
  } catch {
    return null;
  }
  files.sort((left, right) => (left.childRelative < right.childRelative ? -1 : left.childRelative > right.childRelative ? 1 : 0));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.childRelative);
    hash.update("\0");
    if (file.link) {
      hash.update(`link:${await fs.readlink(file.full)}`);
    } else {
      const content = await fs.readFile(file.full);
      bytes += content.length;
      if (bytes > maxBytes) return null;
      hash.update(content);
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Creates `linkPath` → `relativeTarget` (resolving to `absoluteTarget`). Returns the mode
 * used: "symlink", "junction" (Windows, absolute target) or "copy" (with sourceHash).
 */
export async function createDirLink({ linkPath, relativeTarget, absoluteTarget, platform = process.platform, fsImpl = fs, hashImpl = contentHash }) {
  try {
    await fsImpl.symlink(relativeTarget, linkPath, "dir");
    return { mode: "symlink" };
  } catch (error) {
    if (platform !== "win32") throw error;
  }
  try {
    await fsImpl.symlink(absoluteTarget, linkPath, "junction");
    return { mode: "junction" };
  } catch {
    // No junction either (e.g. another volume): fall back to a copy.
  }
  await fsImpl.cp(absoluteTarget, linkPath, { recursive: true, dereference: true, errorOnExist: true, force: false });
  return { mode: "copy", sourceHash: await hashImpl(absoluteTarget) };
}

/** Relative link target from the folder containing `linkPath` to `target`. */
export const relativeLinkTarget = (linkPath, target) => path.relative(path.dirname(linkPath), target);
