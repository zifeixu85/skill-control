import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const DESKTOP_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = path.resolve(DESKTOP_DIRECTORY, "..");
const VINEXT_CLI = path.join(
  PROJECT_DIRECTORY,
  "node_modules",
  "vinext",
  "dist",
  "cli.js",
);
const DEV_PORT = readPort(process.env.SKILL_MANAGER_DESKTOP_DEV_PORT, 3000);
const DEV_URL = `http://127.0.0.1:${DEV_PORT}`;

const children = new Set();
let stopping = false;
let ownsWebServer = false;

function readPort(value, fallback) {
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid desktop development port: ${value}`);
  }
  return port;
}

function launch(command, args, environment = {}) {
  const child = spawn(command, args, {
    cwd: PROJECT_DIRECTORY,
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function fetchText(url, timeoutMs = 1_000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode || 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    request.once("timeout", () =>
      request.destroy(new Error("request timed out")),
    );
    request.once("error", reject);
  });
}

async function inspectExistingWebServer() {
  try {
    const response = await fetchText(DEV_URL);
    if (response.statusCode < 200 || response.statusCode >= 500) return "other";
    return /技能管理器|Skill Control|__next_f|_rsc=/u.test(response.body)
      ? "manager"
      : "other";
  } catch {
    return "available";
  }
}

async function waitForWebServer(attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await inspectExistingWebServer();
    if (result === "manager") return;
    if (result === "other") {
      throw new Error(
        `Port ${DEV_PORT} is occupied by another web application. Set SKILL_MANAGER_DESKTOP_DEV_PORT to use another port.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Vinext did not become ready at ${DEV_URL}.`);
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 500).unref();
}

async function main() {
  await access(VINEXT_CLI);
  const existingServer = await inspectExistingWebServer();
  if (existingServer === "other") {
    throw new Error(
      `Port ${DEV_PORT} is occupied by another web application. Set SKILL_MANAGER_DESKTOP_DEV_PORT to use another port.`,
    );
  }
  if (existingServer === "available") {
    ownsWebServer = true;
    const web = launch(process.execPath, [
      VINEXT_CLI,
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(DEV_PORT),
    ]);
    web.once("exit", (code, signal) => {
      if (!stopping) {
        console.error(`Vinext stopped unexpectedly (${signal || code || 0}).`);
        stop(code || 1);
      }
    });
    await waitForWebServer();
  } else {
    console.log(`Using the existing Skill Manager web server at ${DEV_URL}.`);
  }

  const desktop = launch(
    electronPath,
    [PROJECT_DIRECTORY],
    {
      SKILL_MANAGER_DESKTOP_DEV_URL: DEV_URL,
      ELECTRON_ENABLE_LOGGING: "1",
    },
  );
  desktop.once("exit", (code, signal) => {
    if (!stopping) {
      if (signal) console.error(`Electron stopped with signal ${signal}.`);
      stop(code || 0);
    }
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
process.on("exit", () => {
  if (ownsWebServer) {
    for (const child of children) {
      if (!child.killed) child.kill("SIGTERM");
    }
  }
});

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  stop(1);
});
