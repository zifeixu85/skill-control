import { cp, lstat, mkdir, readlink, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentHash, createDirLink } from "./fs-links.mjs";
import { assertSafeWrite } from "./home-guard.mjs";

/**
 * Reversible file operations for library plans. Every operation checks the home guard,
 * never deletes a real folder (removals move it into a backup or trash folder) and
 * returns an undo function; `runOps` rolls a whole item back when one step fails.
 */

export class LibraryError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
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
    throw new LibraryError(500, "跨卷复制后内容校验失败，已取消。");
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
      if (await exists(op.to)) throw new LibraryError(409, `${context.display(op.to)} 已存在，已停止。`);
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
      if (!(await isLink(op.path))) throw new LibraryError(409, `${context.display(op.path)} 不是链接，已停止。`);
      const linkTarget = await readlink(op.path);
      await unlink(op.path);
      return async () => {
        if (!(await exists(op.path))) await symlink(linkTarget, op.path, "dir");
      };
    }
    case "link": {
      await guard(op.path);
      if (await exists(op.path)) throw new LibraryError(409, `${context.display(op.path)} 已存在，已停止。`);
      await mkdir(path.dirname(op.path), { recursive: true });
      const result = await createDirLink({ linkPath: op.path, relativeTarget: op.relativeTarget, absoluteTarget: op.absoluteTarget, platform: context.platform, fsImpl: context.fsImpl });
      op.result = result;
      return async () => {
        if (await isLink(op.path)) await unlink(op.path);
        else if (result.mode === "copy") await rename(op.path, path.join(context.backupGroup, "undo-copy", path.basename(op.path)));
      };
    }
    case "write": {
      await guard(op.path);
      const existed = await exists(op.path);
      if (existed) {
        await guard(op.backup);
        await mkdir(path.dirname(op.backup), { recursive: true });
        await cp(op.path, op.backup, { errorOnExist: true, force: false });
      }
      await mkdir(path.dirname(op.path), { recursive: true });
      const temporary = `${op.path}.skill-control-${process.pid}-${Date.now()}`;
      await writeFile(temporary, op.content, { mode: op.mode || 0o644 });
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
