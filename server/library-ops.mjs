import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readlink, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentHash, createDirLink } from "./fs-links.mjs";
import { assertSafeWrite } from "./home-guard.mjs";

/**
 * Reversible file operations for library plans. Every operation checks the home guard,
 * never deletes a real folder (removals move it into a backup or trash folder) and
 * returns an undo function; `runOps` rolls a whole item back when one step fails.
 */

export class LibraryError extends Error {
  constructor(statusCode, message, code = null) {
    super(message);
    this.statusCode = statusCode;
    // Machine-readable reason for the UI (see docs/ARCHITECTURE.md, "Error codes").
    if (code) this.code = code;
  }
}

async function isLink(target) {
  return (await lstat(target).catch(() => null))?.isSymbolicLink() || false;
}

async function exists(target) {
  return Boolean(await lstat(target).catch(() => null));
}

/** Rename, or copy + verify + move the original aside when crossing volumes. */
async function moveDirectory(from, to, asideFor) {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
  }
  await cp(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
  if ((await contentHash(from)) !== (await contentHash(to))) {
    await rm(to, { recursive: true, force: true });
    throw new LibraryError(500, "跨卷复制后内容校验失败，已取消。", "integrity");
  }
  await mkdir(path.dirname(asideFor), { recursive: true });
  await rename(from, asideFor);
}

/** Executes one op; returns its undo. */
async function runOp(op, context) {
  const guard = (target) => assertSafeWrite(target, context.homeDirectory);
  switch (op.op) {
    case "backup": {
      await guard(op.to);
      await mkdir(path.dirname(op.to), { recursive: true });
      await cp(op.from, op.to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true });
      return async () => {};
    }
    case "move": {
      await guard(op.from);
      await guard(op.to);
      if (await exists(op.to)) throw new LibraryError(409, `${context.display(op.to)} 已存在，已停止。`, "stale-plan");
      await mkdir(path.dirname(op.to), { recursive: true });
      const aside = path.join(context.backupGroup, "cross-volume", path.basename(op.from));
      await moveDirectory(op.from, op.to, aside);
      return async () => {
        if (!(await exists(op.from))) await rename(op.to, op.from);
      };
    }
    case "stash": {
      // "Delete" = move into the backup folder; never rm -rf a real folder.
      await guard(op.path);
      await guard(op.to);
      await mkdir(path.dirname(op.to), { recursive: true });
      await rename(op.path, op.to);
      return async () => {
        if (!(await exists(op.path))) await rename(op.to, op.path);
      };
    }
    case "unlink": {
      await guard(op.path);
      if (!(await isLink(op.path))) throw new LibraryError(409, `${context.display(op.path)} 不是链接，已停止。`, "stale-plan");
      const linkTarget = await readlink(op.path);
      op.linkTarget = linkTarget;
      await unlink(op.path);
      return async () => {
        if (!(await exists(op.path))) await symlink(linkTarget, op.path, "dir");
      };
    }
    case "link": {
      await guard(op.path);
      if (await exists(op.path)) throw new LibraryError(409, `${context.display(op.path)} 已存在，已停止。`, "stale-plan");
      await mkdir(path.dirname(op.path), { recursive: true });
      const result = await createDirLink({ linkPath: op.path, relativeTarget: op.relativeTarget, absoluteTarget: op.absoluteTarget, platform: context.platform, fsImpl: context.fsImpl });
      op.result = result;
      return async () => {
        if (await isLink(op.path)) await unlink(op.path);
        else if (result.mode === "copy") await rename(op.path, path.join(context.backupGroup, "undo-copy", path.basename(op.path)));
      };
    }
    case "backup-file": {
      // A snapshot of a file that a following command (e.g. `hermes config set`) changes.
      await guard(op.to);
      await mkdir(path.dirname(op.to), { recursive: true });
      op.existed = await exists(op.from);
      if (op.existed) await cp(op.from, op.to, { errorOnExist: true, force: false });
      return async () => {};
    }
    case "write": {
      await guard(op.path);
      const existed = await exists(op.path);
      op.existed = existed;
      if (existed) {
        await guard(op.backup);
        await mkdir(path.dirname(op.backup), { recursive: true });
        await cp(op.path, op.backup, { errorOnExist: true, force: false });
      }
      await mkdir(path.dirname(op.path), { recursive: true });
      const temporary = `${op.path}.skill-control-${process.pid}-${Date.now()}`;
      // Restores write a backup's bytes back (contentFrom); edits carry their new content.
      await writeFile(temporary, op.contentFrom ? await readFile(op.contentFrom) : op.content, { mode: op.mode || 0o644 });
      await rename(temporary, op.path);
      return async () => {
        if (existed) await cp(op.backup, op.path, { force: true });
        else await rm(op.path, { force: true });
      };
    }
    case "command": {
      const outcome = await context.run(op.file, op.args, { timeoutMs: 60_000, env: context.commandEnv() });
      op.outcome = { exitCode: outcome.exitCode };
      if (outcome.exitCode !== 0) throw new LibraryError(500, `命令执行失败（退出码 ${outcome.exitCode}）。`);
      return async () => {};
    }
    default:
      throw new LibraryError(500, `未知操作 ${op.op}。`);
  }
}

/** What is at `target` now: a link target, a folder's content hash, a file's hash, or null. */
export async function fingerprint(target) {
  const info = await lstat(target).catch(() => null);
  if (!info) return null;
  if (info.isSymbolicLink()) return `link:${await readlink(target)}`;
  if (info.isDirectory()) return contentHash(target);
  return `file:${createHash("sha256").update(await readFile(target)).digest("hex")}`;
}

/** The path whose state an executed op leaves behind (checked before undoing it). */
const resultPath = (op) => ({ move: op.to, stash: op.to, link: op.path, write: op.path, unlink: op.path, command: op.restoreFile?.path })[op.op] || null;

/**
 * A serializable record of an executed op for history (no file contents), with the
 * fingerprint of what it left behind.
 */
export async function recordOp(op, display) {
  if (op.op === "backup") return null;
  const record = { op: op.op };
  for (const key of ["path", "from", "to", "backup"]) if (op[key]) record[key] = display(op[key]);
  if (op.relativeTarget) record.relativeTarget = op.relativeTarget;
  // Absolute link targets are stored home-compacted (and expanded again on restore).
  if (op.linkTarget) record.linkTarget = path.isAbsolute(op.linkTarget) ? display(op.linkTarget) : op.linkTarget;
  if (op.existed !== undefined) record.existed = op.existed;
  if (op.result?.mode) record.mode = op.result.mode;
  if (op.restoreFile) record.restoreFile = { path: display(op.restoreFile.path), backup: display(op.restoreFile.backup) };
  const target = resultPath(op);
  record.afterHash = target ? await fingerprint(target) : null;
  return record;
}

/** Whether `reverseOp` can undo a recorded op automatically. */
export function isReversible(record) {
  if (!record) return false;
  if (record.op === "command") return Boolean(record.restoreFile);
  return ["move", "stash", "unlink", "link", "write"].includes(record.op);
}

/**
 * The op that undoes a recorded op, and the condition to check first: `expect` is the
 * fingerprint the path must still have (null = must be absent). Returns null when the op
 * needs no undo (snapshots, backups).
 */
export function reverseOp(record, { expand, backupGroup }) {
  const p = (value) => (value ? expand(value) : value);
  switch (record.op) {
    case "move":
      return { op: { op: "move", from: p(record.to), to: p(record.from) }, check: p(record.to), expect: record.afterHash, free: p(record.from) };
    case "stash":
      return { op: { op: "move", from: p(record.to), to: p(record.path) }, check: p(record.to), expect: record.afterHash, free: p(record.path) };
    case "unlink": {
      const linkPath = p(record.path);
      const target = record.linkTarget?.startsWith("~/") ? expand(record.linkTarget) : record.linkTarget;
      return { op: { op: "link", path: linkPath, relativeTarget: target, absoluteTarget: path.resolve(path.dirname(linkPath), target) }, free: linkPath };
    }
    case "link":
      return record.mode === "copy"
        ? { op: { op: "stash", path: p(record.path), to: path.join(backupGroup, "undo-copy", path.basename(p(record.path))) }, check: p(record.path), expect: record.afterHash }
        : { op: { op: "unlink", path: p(record.path) }, check: p(record.path), expect: record.afterHash };
    case "write":
      return record.existed
        ? { op: { op: "write", path: p(record.path), contentFrom: p(record.backup), backup: path.join(backupGroup, "files", path.basename(p(record.path))) }, check: p(record.path), expect: record.afterHash, needs: p(record.backup) }
        : { op: { op: "stash", path: p(record.path), to: path.join(backupGroup, "removed", path.basename(p(record.path))) }, check: p(record.path), expect: record.afterHash };
    case "command":
      if (!record.restoreFile) return { unsupported: "这条命令没有保存执行前的配置快照，无法自动撤销。" };
      return {
        op: { op: "write", path: p(record.restoreFile.path), contentFrom: p(record.restoreFile.backup), backup: path.join(backupGroup, "files", path.basename(p(record.restoreFile.path))) },
        check: p(record.restoreFile.path),
        expect: record.afterHash,
        needs: p(record.restoreFile.backup),
      };
    default:
      return null;
  }
}

/** Runs ops in order; on failure undoes the completed ones in reverse and rethrows. */
export async function runOps(ops, context) {
  const undo = [];
  try {
    for (const op of ops) undo.push(await runOp(op, context));
  } catch (error) {
    for (const step of undo.reverse()) await step().catch(() => {});
    throw error;
  }
  return async () => {
    for (const step of [...undo].reverse()) await step().catch(() => {});
  };
}
