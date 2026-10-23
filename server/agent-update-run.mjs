import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * Running a confirmed Agent update plan (agent-versions.mjs builds and checks the plan):
 * a streaming runner without a shell, a terminal script for "open in terminal", and the
 * in-memory registry of background jobs.
 */

const OUTPUT_KEEP = 64 * 1024;

/** Runs a program (argument array, no shell, stdin closed), streaming output to `onOutput`. */
export function runStreaming(file, args, { cwd, env, timeoutMs, onOutput = () => {} } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const keep = (buffer, chunk) => (buffer + chunk).slice(-OUTPUT_KEEP);
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    let child;
    try {
      child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      done({ exitCode: 1 });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      done({ exitCode: "timeout" });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = keep(stdout, chunk);
      onOutput(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = keep(stderr, chunk);
      onOutput(chunk);
    });
    child.once("error", () => done({ exitCode: 1 }));
    child.once("close", (code) => done({ exitCode: typeof code === "number" ? code : 1 }));
  });
}

/** POSIX single quotes: the value is passed literally, nothing in it is expanded. */
export const posixQuote = (value) => `'${String(value).replace(/'/gu, "'\\''")}'`;

const UNSAFE_CMD = /["%^&|<>!\r\n]/u;
const plainLine = (value) => String(value).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 300);

/**
 * The one-off script for "open in terminal": shows each command, runs it, prints the exit
 * code and waits for a key; the POSIX one removes itself afterwards. Every program and
 * argument comes from the confirmed plan and is quoted, never interpolated.
 * `steps`: [{ program, args, display }]; `pathEntries`: PATH for the commands.
 */
export function terminalScript({ title, steps, pathEntries, platform = process.platform }) {
  if (platform === "win32") {
    for (const value of [...steps.flatMap((step) => [step.program, ...step.args]), ...pathEntries]) {
      if (UNSAFE_CMD.test(value)) throw Object.assign(new Error("命令里有无法安全写入 .cmd 的字符，请改用应用内执行。"), { statusCode: 409, code: "unsafe-command" });
    }
    const lines = ["@echo off", "chcp 65001 >nul", `rem Skill Control: ${plainLine(title).replace(UNSAFE_CMD, " ")}`, `set "PATH=${pathEntries.join(";")}"`, 'cd /d "%USERPROFILE%"', "set code=0"];
    for (const step of steps) {
      lines.push(`echo 运行：${plainLine(step.display).replace(UNSAFE_CMD, " ")}`, [step.program, ...step.args].map((value) => `"${value}"`).join(" "), "set code=%errorlevel%", "if not %code%==0 goto done");
    }
    lines.push(":done", "echo.", "echo 完成，可以关闭这个窗口（退出码 %code%）", "pause", "exit /b %code%");
    return { name: "skill-control-update.cmd", content: `${lines.join("\r\n")}\r\n` };
  }
  const lines = [
    "#!/bin/sh",
    `# Skill Control 生成的一次性更新脚本：${plainLine(title)}`,
    `PATH=${posixQuote(pathEntries.join(":"))}`,
    "export PATH",
    'cd "$HOME" || exit 1',
    "status=0",
  ];
  for (const step of steps) {
    lines.push(
      'if [ "$status" -eq 0 ]; then',
      `  printf '%s\\n' ${posixQuote(`运行：${plainLine(step.display)}`)}`,
      `  ${[step.program, ...step.args].map(posixQuote).join(" ")} || status=$?`,
      "fi",
    );
  }
  lines.push(
    "echo",
    'printf \'%s\\n\' "完成，可以关闭这个窗口（退出码 $status）"',
    "printf '%s' '按任意键关闭…'",
    "stty -icanon -echo 2>/dev/null; dd bs=1 count=1 >/dev/null 2>&1; stty icanon echo 2>/dev/null",
    'rm -f -- "$0"; rmdir -- "$(dirname -- "$0")" 2>/dev/null',
    'exit "$status"',
  );
  return { name: "skill-control-update.command", content: `${lines.join("\n")}\n` };
}

/** Opens the script with the user's default handler (Terminal, iTerm …; `start` on Windows). */
export function openScript(file, platform = process.platform) {
  const [command, args] = platform === "win32" ? ["cmd.exe", ["/c", "start", '""', file]] : platform === "darwin" ? ["/usr/bin/open", [file]] : ["xdg-open", [file]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Background update jobs, in memory: one at a time per product, kept 1 hour after they end. */
export function createJobRegistry({ now = () => Date.now(), ttlMs = 60 * 60_000 } = {}) {
  const jobs = new Map();
  const purge = () => {
    for (const [id, job] of jobs) if (job.finishedAt && now() - Date.parse(job.finishedAt) > ttlMs) jobs.delete(id);
  };
  return {
    running(productId) {
      purge();
      return [...jobs.values()].find((job) => job.productId === productId && job.status === "running") || null;
    },
    create(productId, steps) {
      purge();
      const job = { jobId: randomUUID(), productId, status: "running", step: 0, steps: steps.map((step) => ({ display: step.display })), outputTail: "", startedAt: new Date(now()).toISOString(), finishedAt: null };
      jobs.set(job.jobId, job);
      return job;
    },
    get(jobId) {
      purge();
      return jobs.get(String(jobId || "")) || null;
    },
  };
}
