import { parentPort, workerData } from "node:worker_threads";
import { scanAll } from "./local-server.mjs";

if (!parentPort) {
  throw new Error("扫描线程缺少父进程通信通道。");
}

try {
  const scan = await scanAll(workerData.config, {
    persistentCache: true,
    forceFingerprints: workerData.forceFingerprints === true,
  });
  parentPort.postMessage({ ok: true, scan });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error?.message || String(error),
    stack: error?.stack || "",
  });
}
