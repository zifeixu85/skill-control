import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";

/**
 * One lock for every library write, shared by the app and the `skill-control` CLI: an
 * exclusive lock file (`library.lock`, created with O_EXCL) in the state folder that holds
 * the owner's pid, host, label and start time. A lock whose process is gone, or that is
 * older than `staleMs`, is taken over. Nested calls in the same async context reuse the
 * lock they already hold; separate calls in one process queue behind each other.
 */

export const LOCK_FILE = "library.lock";
const POLL_MS = 100;
const held = new AsyncLocalStorage();
const queues = new Map();

export class StateLockError extends Error {
  constructor(message, owner) {
    super(message);
    this.statusCode = 409;
    this.code = "locked";
    this.owner = owner || null;
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

async function readOwner(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function tryAcquire(file, record, { staleMs, now }) {
  try {
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const owner = await readOwner(file);
  const started = Date.parse(owner?.at || "");
  const sameHost = !owner?.host || owner.host === record.host;
  const stale = !owner || !Number.isFinite(started) || now() - started > staleMs || (sameHost && Number.isInteger(owner.pid) && !alive(owner.pid));
  if (stale) {
    // Only remove the lock we judged stale (another waiter may have replaced it meanwhile).
    const again = await readOwner(file);
    if (!again || again.token === owner?.token) await rm(file, { force: true });
  }
  return false;
}

/** Runs `task` while holding the library lock of `stateDirectory`. */
export async function withStateLock(stateDirectory, task, { label = "skill-control", timeoutMs = 30_000, staleMs = 10 * 60_000, now = () => Date.now() } = {}) {
  const file = path.join(stateDirectory, LOCK_FILE);
  if (held.getStore()?.has(file)) return task();
  // In-process queue first, so one process never polls against itself.
  const previous = queues.get(file) || Promise.resolve();
  let release;
  const mine = new Promise((resolve) => (release = resolve));
  const chained = previous.then(() => mine);
  queues.set(file, chained);
  await previous;
  const record = { pid: process.pid, host: hostname(), label, at: new Date(now()).toISOString(), token: randomUUID() };
  try {
    await mkdir(stateDirectory, { recursive: true });
    const deadline = now() + timeoutMs;
    while (!(await tryAcquire(file, record, { staleMs, now }))) {
      if (now() > deadline) {
        const owner = await readOwner(file);
        throw new StateLockError(`另一个进程正在修改技能库（${owner?.label || "未知"}，进程 ${owner?.pid ?? "?"}），请稍后再试。`, owner);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    try {
      const files = new Set([...(held.getStore() || []), file]);
      return await held.run(files, task);
    } finally {
      const owner = await readOwner(file);
      if (owner?.token === record.token) await rm(file, { force: true });
    }
  } finally {
    release();
    if (queues.get(file) === chained) queues.delete(file);
  }
}
