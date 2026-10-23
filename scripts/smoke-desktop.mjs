import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");
// SKILL_CONTROL_SMOKE_RELEASE_DIR points at another electron-builder output directory.
const RELEASE_DIRECTORY = path.resolve(
  PROJECT_DIRECTORY,
  process.env.SKILL_CONTROL_SMOKE_RELEASE_DIR || "release",
);
const SMOKE_TIMEOUT_MS = 60_000;

// Never the default manager port (a running copy may own it) nor 49152.
const RESERVED_PORTS = new Set([43110, 49152]);

async function freeLoopbackPort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port: chosen } = server.address();
        server.close(() => resolve(chosen));
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
  throw new Error("找不到可用的本机端口。");
}

function resolveExecutable() {
  if (process.platform === "darwin") {
    const outputDirectory =
      process.arch === "arm64" ? "mac-arm64" : process.arch === "x64" ? "mac" : null;
    if (!outputDirectory) {
      throw new Error(`不支持在 macOS ${process.arch} 上运行桌面冒烟测试。`);
    }
    return path.join(
      RELEASE_DIRECTORY,
      outputDirectory,
      "Skill Control.app",
      "Contents",
      "MacOS",
      "Skill Control",
    );
  }
  if (process.platform === "win32") {
    if (process.arch !== "x64") {
      throw new Error(`不支持在 Windows ${process.arch} 上运行桌面冒烟测试。`);
    }
    return path.join(RELEASE_DIRECTORY, "win-unpacked", "Skill Control.exe");
  }
  if (process.platform === "linux") {
    if (process.arch !== "x64") {
      throw new Error(`不支持在 Linux ${process.arch} 上运行桌面冒烟测试。`);
    }
    return path.join(RELEASE_DIRECTORY, "linux-unpacked", "skill-control");
  }
  throw new Error(`不支持的平台：${process.platform}`);
}

async function runSmokeTest() {
  const executable = resolveExecutable();
  await access(executable);
  console.info(`[desktop-smoke-runner] 启动 ${executable}`);
  // A fresh profile each run; app update checks stay offline.
  const userDataDirectory = await mkdtemp(
    path.join(os.tmpdir(), "skill-control-smoke-"),
  );

  const managerPort =
    process.env.SKILL_MANAGER_DESKTOP_MANAGER_PORT || String(await freeLoopbackPort());
  const webPort =
    process.env.SKILL_MANAGER_DESKTOP_WEB_PORT || String(await freeLoopbackPort());

  const child = spawn(executable, [`--user-data-dir=${userDataDirectory}`], {
    cwd: PROJECT_DIRECTORY,
    env: {
      ...process.env,
      SKILL_CONTROL_SMOKE_TEST: "1",
      SKILL_MANAGER_UPDATES_OFFLINE: "1",
      SKILL_MANAGER_DESKTOP_MANAGER_PORT: managerPort,
      SKILL_MANAGER_DESKTOP_WEB_PORT: webPort,
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: "inherit",
    windowsHide: true,
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    console.error(
      `[desktop-smoke-runner] ${SMOKE_TIMEOUT_MS / 1_000} 秒内未完成，正在终止。`,
    );
    child.kill("SIGTERM");
  }, SMOKE_TIMEOUT_MS);

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (timedOut) {
        resolve(124);
        return;
      }
      if (signal) {
        console.error(`[desktop-smoke-runner] 应用被信号 ${signal} 终止。`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  }).finally(async () => {
    clearTimeout(timeout);
    await rm(userDataDirectory, { recursive: true, force: true }).catch(() => {});
  });

  if (exitCode !== 0) {
    throw new Error(`桌面冒烟测试失败，退出码 ${exitCode}。`);
  }
  console.info("[desktop-smoke-runner] 桌面冒烟测试通过。");
}

runSmokeTest().catch((error) => {
  console.error(
    `[desktop-smoke-runner] ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
});
