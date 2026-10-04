import { readdir, readFile, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { classifyPath } from "./fs-links.mjs";
import { isStrictlyWithin } from "./fs-safe.mjs";
import { assertSafeWrite } from "./home-guard.mjs";

/**
 * ~/.agent-skill-manager/trash/<trashId>/ holds removed skill folders (or the link they
 * were) plus manifest.json. Library removals, single-Agent uninstalls and restores that
 * move a created folder aside all use it; anything in it can be put back.
 */

export class TrashError extends Error {
  constructor(statusCode, message, code = null) {
    super(message);
    this.statusCode = statusCode;
    // Machine-readable reason for the UI (see docs/ARCHITECTURE.md, "Error codes").
    if (code) this.code = code;
  }
}

const TRASH_ID = /^[\w.@-]{1,200}$/u;
export const trashRoot = (stateDirectory) => path.join(stateDirectory, "trash");

export async function listTrash(stateDirectory, display = (value) => value) {
  const root = trashRoot(stateDirectory);
  const items = [];
  for (const name of (await readdir(root).catch(() => [])).filter((entry) => !entry.includes(".restored-")).sort().reverse()) {
    try {
      const manifest = JSON.parse(await readFile(path.join(root, name, "manifest.json"), "utf8"));
      items.push({
        trashId: manifest.trashId,
        name: manifest.name,
        source: manifest.source || "library",
        agentId: manifest.agentId || null,
        kind: manifest.kind,
        originalPath: display(manifest.originalPath),
        removedAt: manifest.removedAt,
        links: (manifest.links || []).length,
      });
    } catch {
      // Not a trash entry.
    }
  }
  return items;
}

export async function readTrashManifest(stateDirectory, trashId) {
  if (!TRASH_ID.test(String(trashId || ""))) throw new TrashError(400, "回收站条目无效。", "invalid-request");
  try {
    return JSON.parse(await readFile(path.join(trashRoot(stateDirectory), trashId, "manifest.json"), "utf8"));
  } catch {
    throw new TrashError(404, "回收站中没有这个条目。", "not-found");
  }
}

/**
 * Puts an entry back at its original path, which must still lie inside one of
 * `allowedRoots` and be free, then recreates the links recorded with it.
 */
export async function restoreTrash({ trashId, stateDirectory, homeDirectory, allowedRoots, display = (value) => value, stamp }) {
  const manifest = await readTrashManifest(stateDirectory, trashId);
  const root = path.join(trashRoot(stateDirectory), trashId);
  if (!allowedRoots.some((allowed) => isStrictlyWithin(allowed, manifest.originalPath))) {
    throw new TrashError(400, "原位置不在任何 Agent 技能目录或技能库内。", "refused");
  }
  if ((await classifyPath(manifest.originalPath, null)).kind !== "absent") throw new TrashError(409, "原位置已有同名条目，请先处理。", "conflict");
  await assertSafeWrite(manifest.originalPath, homeDirectory);
  if (manifest.kind === "real") await rename(path.join(root, manifest.name), manifest.originalPath);
  else if (manifest.linkTarget) await symlink(manifest.linkTarget, manifest.originalPath, "dir");
  const restored = [];
  for (const link of manifest.links || []) {
    if (!allowedRoots.some((allowed) => isStrictlyWithin(allowed, link.path))) continue;
    if ((await classifyPath(link.path, null)).kind !== "absent") continue;
    await assertSafeWrite(link.path, homeDirectory);
    await symlink(link.target, link.path, "dir");
    restored.push(display(link.path));
  }
  await rename(root, `${root}.restored-${stamp}`);
  return { trashId, name: manifest.name, path: display(manifest.originalPath), links: restored };
}

/** The ops that move `target` into a new trash entry (stash + manifest). */
export function trashOps({ stateDirectory, trashId, name, target, kind, linkTarget = null, links = [], source, agentId = null, removedAt }) {
  const root = path.join(trashRoot(stateDirectory), trashId);
  return [
    kind === "real" ? { op: "stash", path: target, to: path.join(root, name) } : { op: "unlink", path: target },
    {
      op: "write",
      path: path.join(root, "manifest.json"),
      content: `${JSON.stringify({ trashId, name, source, agentId, originalPath: target, kind, linkTarget, links, removedAt }, null, 2)}\n`,
      backup: path.join(root, "manifest.previous.json"),
    },
  ];
}
