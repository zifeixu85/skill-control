import { stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { loadUsageIndex, runUsageIndex } from "./usage-index.mjs";

/**
 * Keeps the usage index fresh without blocking requests: indexing runs in a worker thread
 * in budgeted slices, back to back until every file is indexed, and again when a request
 * finds the index older than `staleMs`. Requests always answer from the last saved index.
 */
export function createUsageService({
  homeDirectory,
  indexPath,
  budgetMs = 3_000,
  staleMs = 60_000,
  continueDelayMs = 200,
  watchdogMs = 60_000,
  useWorker = true,
} = {}) {
  const status = {
    state: "idle",
    indexedFiles: 0,
    totalFiles: 0,
    indexedBytes: 0,
    totalBytes: 0,
    lastRunAt: null,
    lastRunMs: null,
    updatedAt: null,
    error: null,
  };
  let running = null;
  let continueTimer = null;
  let lastFinishedAt = 0;
  let cached = { index: null, mtimeMs: -1 };

  const applyProgress = (progress) => {
    status.indexedFiles = progress.indexedFiles ?? status.indexedFiles;
    status.totalFiles = progress.files ?? status.totalFiles;
    status.indexedBytes = progress.indexedBytes ?? status.indexedBytes;
    status.totalBytes = progress.bytes ?? status.totalBytes;
  };

  function runInWorker() {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./usage-worker.mjs", import.meta.url), {
        workerData: { homeDirectory, indexPath, budgetMs },
      });
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        callback(value);
      };
      const watchdog = setTimeout(() => {
        worker.terminate().catch(() => {});
        finish(reject, new Error("用量索引超时，已停止本轮。"));
      }, watchdogMs);
      worker.on("message", (message) => {
        if (message?.type === "progress") applyProgress(message.progress);
        else if (message?.type === "done") finish(resolve, message.result);
        else if (message?.type === "error") finish(reject, new Error(message.error));
      });
      worker.once("error", (error) => finish(reject, error));
      worker.once("exit", (code) => finish(reject, new Error(`用量索引线程异常退出（${code}）。`)));
    });
  }

  async function runSlice() {
    status.state = "indexing";
    status.lastRunAt = new Date().toISOString();
    const started = Date.now();
    try {
      const result = useWorker
        ? await runInWorker().catch(() => runUsageIndex({ homeDirectory, indexPath, budgetMs, onProgress: applyProgress }))
        : await runUsageIndex({ homeDirectory, indexPath, budgetMs, onProgress: applyProgress });
      applyProgress(result);
      status.state = result.state;
      status.error = null;
      status.updatedAt = new Date().toISOString();
    } catch (error) {
      status.state = "error";
      status.error = String(error?.message || error).slice(0, 300);
    } finally {
      status.lastRunMs = Date.now() - started;
      lastFinishedAt = Date.now();
      running = null;
    }
    if (status.state === "partial") {
      continueTimer = setTimeout(() => {
        continueTimer = null;
        start();
      }, continueDelayMs);
      continueTimer.unref?.();
    }
    return { ...status };
  }

  function start() {
    if (!running) running = runSlice();
    return running;
  }

  /** Starts a slice when the index is unfinished or stale; never waits for it. */
  function ensureFresh() {
    if (running || continueTimer) return;
    if (status.state !== "complete" || Date.now() - lastFinishedAt > staleMs) start();
  }

  async function getIndex() {
    let mtimeMs = -1;
    try {
      mtimeMs = (await stat(indexPath)).mtimeMs;
    } catch {
      mtimeMs = -1;
    }
    if (!cached.index || cached.mtimeMs !== mtimeMs) cached = { index: await loadUsageIndex(indexPath), mtimeMs };
    return cached.index;
  }

  /** Runs slices until complete (tests and first-run tooling). */
  async function runToCompletion(maxSlices = 1_000) {
    for (let slice = 0; slice < maxSlices; slice += 1) {
      if (continueTimer) {
        clearTimeout(continueTimer);
        continueTimer = null;
      }
      const result = await start();
      if (result.state !== "partial") return result;
    }
    return { ...status };
  }

  function stop() {
    if (continueTimer) clearTimeout(continueTimer);
    continueTimer = null;
  }

  return { status: () => ({ ...status }), ensureFresh, getIndex, runToCompletion, stop };
}
