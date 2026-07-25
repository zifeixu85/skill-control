import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const TEST_ORIGIN = "http://127.0.0.1:3000";

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

async function waitForHealth(baseUrl, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`测试服务提前退出：\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: TEST_ORIGIN },
      });
      if (response.ok) return;
    } catch {
      // The child may still be binding its loopback socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待测试服务超时：\n${logs.join("")}`);
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

test("synchronizes, backs up, exports, and reinstalls a skill through the local API", async (context) => {
  const temporaryHome = await mkdtemp(path.join(tmpdir(), "skill-control-e2e-"));
  const codexRoot = path.join(temporaryHome, ".codex", "skills");
  const claudeRoot = path.join(temporaryHome, ".claude", "skills");
  const workbuddyRoot = path.join(temporaryHome, ".workbuddy", "skills");
  const sourcePath = path.join(codexRoot, "sample-skill");
  const claudePath = path.join(claudeRoot, "sample-skill");
  const workbuddyPath = path.join(workbuddyRoot, "sample-skill");
  const stateDirectory = path.join(temporaryHome, ".agent-skill-manager");
  await Promise.all([
    mkdir(sourcePath, { recursive: true }),
    mkdir(claudeRoot, { recursive: true }),
    mkdir(workbuddyRoot, { recursive: true }),
    mkdir(stateDirectory, { recursive: true }),
  ]);
  const firstVersion = [
    "---",
    "name: sample-skill",
    "description: 完全虚构的端到端测试技能。",
    "---",
    "# 示例技能",
    "",
    "第一版内容。",
  ].join("\n");
  const secondVersion = firstVersion.replace("第一版内容。", "第二版内容。");
  await writeFile(path.join(sourcePath, "SKILL.md"), firstVersion, "utf8");
  await writeFile(
    path.join(stateDirectory, "config.json"),
    `${JSON.stringify(
      {
        version: 1,
        syncMode: "copy",
        visibleAgentIds: ["codex", "claude", "workbuddy"],
        agents: [
          {
            id: "codex",
            name: "Codex",
            shortName: "CX",
            color: "#d7f56d",
            paths: [codexRoot],
          },
          {
            id: "claude",
            name: "Claude Code",
            shortName: "CC",
            color: "#ff7a4d",
            paths: [claudeRoot],
          },
          {
            id: "workbuddy",
            name: "WorkBuddy",
            shortName: "WB",
            color: "#74c7ec",
            paths: [workbuddyRoot],
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const port = await reserveFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ["server/local-server.mjs"], {
    cwd: PROJECT_DIRECTORY,
    env: {
      ...process.env,
      HOME: temporaryHome,
      USERPROFILE: temporaryHome,
      SKILL_MANAGER_HOST: "127.0.0.1",
      SKILL_MANAGER_PORT: String(port),
      SKILL_MANAGER_ORIGINS: TEST_ORIGIN,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  context.after(async () => {
    await stopChild(child);
    await rm(temporaryHome, { recursive: true, force: true });
  });
  await waitForHealth(baseUrl, child, logs);

  async function requestJson(pathname, options = {}) {
    const headers = {
      Origin: TEST_ORIGIN,
      ...(options.body && !(options.body instanceof Uint8Array)
        ? { "content-type": "application/json" }
        : {}),
      ...options.headers,
    };
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers,
    });
    const payload = await response.json();
    assert.equal(
      response.ok,
      true,
      `HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
    return payload;
  }

  const initialScan = await requestJson("/api/scan?force=1");
  const sourceInstance = initialScan.skills
    .find((skill) => skill.name === "sample-skill")
    .instances.find((instance) => instance.agentId === "codex");
  assert.ok(sourceInstance);

  const createPlan = await requestJson("/api/sync", {
    method: "POST",
    body: JSON.stringify({
      sourceInstanceId: sourceInstance.id,
      targetAgentIds: ["claude"],
      mode: "copy",
      dryRun: true,
    }),
  });
  assert.equal(createPlan.actions[0].action, "create");
  await requestJson("/api/sync", {
    method: "POST",
    headers: { "x-skill-manager-confirm": "yes" },
    body: JSON.stringify({
      sourceInstanceId: sourceInstance.id,
      targetAgentIds: ["claude"],
      mode: "copy",
      dryRun: false,
      confirm: true,
    }),
  });
  assert.equal(await readFile(path.join(claudePath, "SKILL.md"), "utf8"), firstVersion);

  await writeFile(path.join(sourcePath, "SKILL.md"), secondVersion, "utf8");
  const replaceResult = await requestJson("/api/sync", {
    method: "POST",
    headers: { "x-skill-manager-confirm": "yes" },
    body: JSON.stringify({
      sourceInstanceId: sourceInstance.id,
      targetAgentIds: ["claude"],
      mode: "copy",
      dryRun: false,
      confirm: true,
    }),
  });
  assert.equal(replaceResult.actions[0].action, "replace");
  assert.equal(await readFile(path.join(claudePath, "SKILL.md"), "utf8"), secondVersion);
  const compactBackup = replaceResult.actions[0].backup;
  assert.match(compactBackup, /^~\//);
  const backupPath = path.join(temporaryHome, compactBackup.slice(2));
  assert.equal(await readFile(path.join(backupPath, "SKILL.md"), "utf8"), firstVersion);

  const exportResponse = await fetch(
    `${baseUrl}/api/export-skill?instanceId=${encodeURIComponent(sourceInstance.id)}`,
    { headers: { Origin: TEST_ORIGIN } },
  );
  assert.equal(exportResponse.ok, true);
  const archive = new Uint8Array(await exportResponse.arrayBuffer());
  assert.ok(archive.byteLength > 0);

  const imported = await requestJson("/api/import-skill", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-skill-filename": encodeURIComponent("sample-skill.skill"),
    },
    body: archive,
  });
  assert.equal(imported.name, "sample-skill");
  const installPlan = await requestJson("/api/import-install", {
    method: "POST",
    body: JSON.stringify({
      importId: imported.importId,
      targetAgentIds: ["workbuddy"],
      dryRun: true,
    }),
  });
  assert.equal(installPlan.actions[0].action, "create");
  await requestJson("/api/import-install", {
    method: "POST",
    headers: { "x-skill-manager-confirm": "yes" },
    body: JSON.stringify({
      importId: imported.importId,
      targetAgentIds: ["workbuddy"],
      dryRun: false,
      confirm: true,
    }),
  });
  assert.equal(
    await readFile(path.join(workbuddyPath, "SKILL.md"), "utf8"),
    secondVersion,
  );

  const historyLines = (
    await readFile(path.join(stateDirectory, "history.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    historyLines.map((entry) => entry.type),
    ["sync", "sync", "import"],
  );
});
