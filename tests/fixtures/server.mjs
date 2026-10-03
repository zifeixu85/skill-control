import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
export const TEST_ORIGIN = "http://127.0.0.1:3000";

async function reserveFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  if (child.exitCode === null) child.kill("SIGKILL");
}

/** Starts the manager service with HOME pointed at a synthetic directory. */
export async function startTestServer(context, home) {
  const port = await reserveFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ["server/local-server.mjs"], {
    cwd: PROJECT_DIRECTORY,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SKILL_MANAGER_HOST: "127.0.0.1",
      SKILL_MANAGER_PORT: String(port),
      SKILL_MANAGER_ORIGINS: TEST_ORIGIN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  context.after(() => stopChild(child));

  let healthy = false;
  for (let attempt = 0; attempt < 200 && !healthy; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`测试服务提前退出：\n${logs.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`, { headers: { Origin: TEST_ORIGIN } });
      healthy = response.ok;
    } catch {
      // The child may still be binding its loopback socket.
    }
    if (!healthy) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(healthy, true, `等待测试服务超时：\n${logs.join("")}`);

  async function request(pathname, options = {}) {
    return fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: {
        Origin: TEST_ORIGIN,
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
    });
  }
  async function requestJson(pathname, options = {}) {
    const response = await request(pathname, options);
    const payload = await response.json();
    assert.equal(response.ok, true, `HTTP ${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  }
  return { baseUrl, port, request, requestJson, logs };
}
