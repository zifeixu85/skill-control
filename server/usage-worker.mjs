import { parentPort, workerData } from "node:worker_threads";
import { runUsageIndex } from "./usage-index.mjs";

if (!parentPort) throw new Error("用量索引线程缺少父进程通信通道。");

let lastProgressAt = 0;
try {
  const result = await runUsageIndex({
    homeDirectory: workerData.homeDirectory,
    indexPath: workerData.indexPath,
    budgetMs: workerData.budgetMs,
    onProgress(progress) {
      const now = Date.now();
      if (now - lastProgressAt < 250) return;
      lastProgressAt = now;
      parentPort.postMessage({ type: "progress", progress });
    },
  });
  parentPort.postMessage({ type: "done", result });
} catch (error) {
  parentPort.postMessage({ type: "error", error: String(error?.message || error).slice(0, 300) });
}
