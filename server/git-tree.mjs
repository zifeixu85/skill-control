import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

/**
 * Git object hashes of a folder without git: the tree SHA-1 that `skills` (vercel) stores
 * as `skillFolderHash`, and the SHA-256 folder hash of its project `skills-lock.json`.
 * Both read files only; nothing is executed.
 */

const ENTRY_LIMIT = 20_000;
const FILE_LIMIT = 50 * 1024 * 1024;

/** Paths the `skills` installer never copies; upstream listings are filtered the same way. */
export const INSTALL_EXCLUDED_DIRS = new Set([".git", "__pycache__", "__pypackages__"]);
export const INSTALL_EXCLUDED_FILES = new Set(["metadata.json"]);

const sha1 = (...parts) => {
  const hash = createHash("sha1");
  for (const part of parts) hash.update(part);
  return hash.digest();
};

export const gitBlobSha = (content) => sha1(Buffer.from(`blob ${content.length}\0`), content);

/** Git's tree ordering: names compare as bytes, directories as if followed by "/". */
function treeObject(entries) {
  const sorted = [...entries].sort((left, right) => Buffer.compare(left.sortKey, right.sortKey));
  const body = Buffer.concat(
    sorted.flatMap((entry) => [Buffer.from(`${entry.mode} `), entry.name, Buffer.from([0]), entry.sha]),
  );
  return sha1(Buffer.from(`tree ${body.length}\0`), body);
}

const entry = (mode, name, sha, isTree) => {
  const nameBuffer = Buffer.from(name);
  return { mode, name: nameBuffer, sha, sortKey: isTree ? Buffer.concat([nameBuffer, Buffer.from("/")]) : nameBuffer };
};

/**
 * Tree SHA-1 of a folder on disk, as `git write-tree` would compute it for its contents:
 * empty folders are omitted, symlinks hash their target, the owner execute bit selects
 * 100755. `exclude(relativePath, isDirectory)` drops entries (".git" is always dropped).
 */
export async function localTreeSha(directory, { exclude = () => false } = {}) {
  let budget = ENTRY_LIMIT;
  async function visit(current, relative) {
    const entries = [];
    for (const dirent of await readdir(current, { withFileTypes: true })) {
      if ((budget -= 1) < 0) throw new Error("目录内容过多，无法计算哈希。");
      const name = dirent.name;
      const childRelative = relative ? `${relative}/${name}` : name;
      const full = path.join(current, name);
      const info = await lstat(full);
      if (name === ".git" || exclude(childRelative, info.isDirectory())) continue;
      if (info.isSymbolicLink()) {
        entries.push(entry("120000", name, gitBlobSha(Buffer.from(await readlink(full))), false));
      } else if (info.isDirectory()) {
        const child = await visit(full, childRelative);
        if (child) entries.push(entry("40000", name, child, true));
      } else if (info.isFile()) {
        if (info.size > FILE_LIMIT) throw new Error("文件过大，无法计算哈希。");
        entries.push(entry(info.mode & 0o100 ? "100755" : "100644", name, gitBlobSha(await readFile(full)), false));
      }
    }
    return entries.length ? treeObject(entries) : null;
  }
  const sha = await visit(directory, "");
  return (sha || treeObject([])).toString("hex");
}

export const installExclude = (relativePath, isDirectory) => {
  const name = relativePath.split("/").at(-1);
  return isDirectory ? INSTALL_EXCLUDED_DIRS.has(name) : INSTALL_EXCLUDED_FILES.has(name);
};

/** The folder part of a `skillPath` ("skills/x/SKILL.md" → "skills/x", "SKILL.md" → ""). */
export function skillFolderOf(skillPath) {
  let folder = String(skillPath || "").replace(/\\/gu, "/");
  if (folder.toLowerCase().endsWith("/skill.md")) folder = folder.slice(0, -9);
  else if (folder.toLowerCase().endsWith("skill.md")) folder = folder.slice(0, -8);
  return folder.replace(/\/+$/u, "");
}

/**
 * Tree SHA-1 of `folder` rebuilt from a recursive GitHub tree listing
 * ({ path, mode, type, sha }), keeping only entries `keep` accepts. With no filter it
 * equals the folder's own tree SHA.
 */
export function treeShaFromListing(listing, folder, { exclude = () => false } = {}) {
  const prefix = folder ? `${folder}/` : "";
  const root = { children: new Map() };
  for (const item of listing) {
    if (typeof item?.path !== "string" || (prefix && !item.path.startsWith(prefix))) continue;
    if (item.type === "tree") continue;
    const parts = item.path.slice(prefix.length).split("/");
    let skip = false;
    for (let index = 0; index < parts.length; index += 1) {
      const isLeaf = index === parts.length - 1;
      if (exclude(parts.slice(0, index + 1).join("/"), !isLeaf)) skip = true;
    }
    if (skip || parts.some((part) => !part)) continue;
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.children.has(part)) node.children.set(part, { children: new Map() });
      node = node.children.get(part);
    }
    node.children.set(parts.at(-1), { mode: item.mode, sha: Buffer.from(item.sha, "hex"), isTree: false });
  }
  const build = (node) => {
    const entries = [];
    for (const [name, child] of node.children) {
      if (child.children) {
        const sha = build(child);
        if (sha) entries.push(entry("40000", name, sha, true));
      } else {
        entries.push(entry(child.mode === "040000" ? "40000" : child.mode, name, child.sha, false));
      }
    }
    return entries.length ? treeObject(entries) : null;
  };
  const sha = build(root);
  return sha ? sha.toString("hex") : null;
}

/** `skills-lock.json` v1 computedHash: SHA-256 over sorted relative paths and contents. */
export async function sha256FolderHash(directory) {
  const files = [];
  let budget = ENTRY_LIMIT;
  async function collect(current) {
    for (const dirent of await readdir(current, { withFileTypes: true })) {
      if ((budget -= 1) < 0) throw new Error("目录内容过多，无法计算哈希。");
      const full = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        if (dirent.name === ".git" || dirent.name === "node_modules") continue;
        await collect(full);
      } else if (dirent.isFile()) {
        const info = await lstat(full);
        if (info.size > FILE_LIMIT) throw new Error("文件过大，无法计算哈希。");
        files.push({ relativePath: path.relative(directory, full).split(path.sep).join("/"), content: await readFile(full) });
      }
    }
  }
  await collect(directory);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }
  return hash.digest("hex");
}
