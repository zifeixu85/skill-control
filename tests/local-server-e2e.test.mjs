import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSmartOrderFixture } from "./fixtures/smartorder.mjs";

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
  const smartOrderFixture = await createSmartOrderFixture(temporaryHome);
  const codexRoot = path.join(temporaryHome, ".codex", "skills");
  const claudeRoot = path.join(temporaryHome, ".claude", "skills");
  const workbuddyRoot = path.join(temporaryHome, ".workbuddy", "skills");
  const sourcePath = path.join(codexRoot, "sample-skill");
  const claudePath = path.join(claudeRoot, "sample-skill");
  const workbuddyPath = path.join(workbuddyRoot, "sample-skill");
  const workbuddyExpertPath = path.join(
    temporaryHome,
    ".workbuddy",
    "plugins",
    "marketplaces",
    "experts",
    "plugins",
    "research-team",
  );
  const workbuddyExpertManifestPath = path.join(
    temporaryHome,
    ".workbuddy",
    "app",
    "cache",
    "experts",
    "manifest.json",
  );
  const hermesRoot = path.join(temporaryHome, ".hermes");
  const hermesResearchProfile = path.join(
    hermesRoot,
    "profiles",
    "research",
  );
  const stateDirectory = path.join(temporaryHome, ".agent-skill-manager");
  await Promise.all([
    mkdir(sourcePath, { recursive: true }),
    mkdir(claudeRoot, { recursive: true }),
    mkdir(workbuddyRoot, { recursive: true }),
    mkdir(path.join(workbuddyExpertPath, ".codebuddy-plugin"), {
      recursive: true,
    }),
    mkdir(path.join(workbuddyExpertPath, "agents"), { recursive: true }),
    mkdir(path.join(workbuddyExpertPath, "assets"), { recursive: true }),
    mkdir(path.dirname(workbuddyExpertManifestPath), { recursive: true }),
    mkdir(hermesRoot, { recursive: true }),
    mkdir(hermesResearchProfile, { recursive: true }),
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
  await mkdir(path.join(sourcePath, "assets"), { recursive: true });
  const logoSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#d7f56d"/></svg>';
  await writeFile(path.join(sourcePath, "assets", "logo.svg"), logoSvg, "utf8");
  await writeFile(
    path.join(workbuddyExpertPath, "assets", "badge.svg"),
    logoSvg,
    "utf8",
  );
  if (process.platform !== "win32") {
    const outsideCapabilityAsset = path.join(
      temporaryHome,
      "outside-capability.svg",
    );
    await writeFile(outsideCapabilityAsset, logoSvg, "utf8");
    await symlink(
      outsideCapabilityAsset,
      path.join(workbuddyExpertPath, "assets", "outside.svg"),
    );
  }
  await writeFile(
    path.join(workbuddyExpertPath, ".codebuddy-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: "research-team",
        displayName: { zh: "深度研究专家团", en: "Research Team" },
        displayDescription: {
          zh: "由研究负责人和资料分析师协作完成复杂调研。",
        },
        expertType: "team",
        version: "1.2.0",
        agents: ["./agents/lead.md", "./agents/analyst.md"],
        tags: [{ zh: "研究" }, { zh: "协作" }],
        connectorIds: ["browser"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(workbuddyExpertPath, "agents", "lead.md"),
    [
      "---",
      "name: research-lead",
      "description: 负责拆解研究目标并整合结论。",
      "displayName:",
      "  zh: 研究负责人",
      "profession:",
      "  zh: 研究策划",
      "maxTurns: 18",
      "---",
      "# 工作方式",
      "",
      "先定义问题，再分配检索任务。",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(workbuddyExpertPath, "agents", "analyst.md"),
    [
      "---",
      "name: source-analyst",
      "description: 负责核验资料来源。",
      "displayName:",
      "  zh: 资料分析师",
      "profession:",
      "  zh: 信息核验",
      "---",
      "# 工作方式",
      "",
      "交叉验证关键事实。",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(workbuddyExpertPath, ".env"),
    "DO_NOT_EXPOSE=workbuddy-secret\n",
    "utf8",
  );
  await writeFile(
    workbuddyExpertManifestPath,
    `${JSON.stringify({ experts: [{ id: "a" }, { id: "b" }] })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(hermesRoot, "config.yaml"),
    [
      "model:",
      "  provider: openai-codex",
      "  default: gpt-test",
      "  api_key: do-not-expose",
      "agent:",
      "  max_turns: 42",
      "delegation:",
      "  orchestrator_enabled: true",
      "  max_concurrent_children: 3",
      "  max_spawn_depth: 1",
      "display:",
      "  language: zh",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(hermesRoot, "SOUL.md"),
    "# 调研型 Hermes\n\n负责复杂调研，并将任务委派给子 Agent。",
    "utf8",
  );
  await writeFile(
    path.join(hermesRoot, ".env"),
    "HERMES_API_KEY=hermes-secret\n",
    "utf8",
  );
  await writeFile(
    path.join(hermesResearchProfile, "config.yaml"),
    [
      "model:",
      "  provider: anthropic",
      "  default: claude-profile-test",
      "  api_key: named-profile-secret",
      "delegation:",
      "  orchestrator_enabled: true",
      "  max_concurrent_children: 2",
      "  max_spawn_depth: 2",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(hermesResearchProfile, "profile.yaml"),
    [
      "name: research",
      "displayName: 深度研究 Agent",
      "description: 负责资料分析与任务委派。",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(hermesResearchProfile, "SOUL.md"),
    "# 深度研究 Agent\n\n核验资料并委派子任务。",
    "utf8",
  );
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

  const migratedConfig = await requestJson("/api/config");
  assert.equal(migratedConfig.version, 3);
  assert.deepEqual(migratedConfig.dismissedAgentIds, []);
  assert.equal(migratedConfig.agents.find((agent) => agent.id === "smartorder").name, "订单来了");
  // An older config never chose its visible Agents: every detected Agent is shown.
  assert.equal(migratedConfig.visibleCustomized, false);
  assert.equal(migratedConfig.visibleAgentIds.includes("smartorder"), true);
  const connectors = await requestJson("/api/connectors");
  assert.equal(connectors.connectors.length, 3);
  assert.doesNotMatch(JSON.stringify(connectors), /secret-|bearer_token|env_http_headers/);
  assert.equal(
    migratedConfig.agents.find((agent) => agent.id === "codex").color,
    "#8fc9ef",
  );
  assert.equal(
    migratedConfig.agents.find((agent) => agent.id === "claude").color,
    "#c7b7ef",
  );

  const withoutWorkbuddy = await requestJson("/api/config", {
    method: "PUT",
    body: JSON.stringify({
      ...migratedConfig,
      agents: migratedConfig.agents.filter(
        (agent) => agent.id !== "workbuddy",
      ),
      visibleAgentIds: migratedConfig.visibleAgentIds.filter(
        (id) => id !== "workbuddy",
      ),
      dismissedAgentIds: ["workbuddy"],
    }),
  });
  assert.equal(
    withoutWorkbuddy.agents.some((agent) => agent.id === "workbuddy"),
    false,
  );
  assert.deepEqual(withoutWorkbuddy.dismissedAgentIds, ["workbuddy"]);
  const stillWithoutWorkbuddy = await requestJson("/api/config");
  assert.equal(
    stillWithoutWorkbuddy.agents.some((agent) => agent.id === "workbuddy"),
    false,
  );
  await requestJson("/api/config", {
    method: "PUT",
    body: JSON.stringify(migratedConfig),
  });

  const capabilities = await requestJson("/api/capabilities");
  assert.deepEqual(capabilities.totals, {
    products: 2,
    profiles: 3,
    members: 2,
  });
  const workbuddyCapability = capabilities.products
    .find((product) => product.id === "workbuddy")
    .items.find((item) => item.name === "research-team");
  assert.equal(workbuddyCapability.displayName, "深度研究专家团");
  assert.equal(workbuddyCapability.memberCount, 2);
  assert.equal(workbuddyCapability.members[0].displayName, "研究负责人");
  const workbuddyCapabilityFiles = await requestJson(
    `/api/capability-files?capabilityId=${encodeURIComponent(workbuddyCapability.id)}`,
  );
  assert.ok(
    workbuddyCapabilityFiles.entries.some(
      (entry) => entry.path === "agents/lead.md",
    ),
  );
  assert.equal(
    workbuddyCapabilityFiles.entries.some((entry) => entry.path === ".env"),
    false,
  );
  const workbuddyMemberFile = await requestJson(
    `/api/capability-file?capabilityId=${encodeURIComponent(workbuddyCapability.id)}&path=${encodeURIComponent("agents/lead.md")}`,
  );
  assert.match(workbuddyMemberFile.content, /先定义问题/);
  const capabilityAssetResponse = await fetch(
    `${baseUrl}/api/capability-asset?capabilityId=${encodeURIComponent(workbuddyCapability.id)}&path=${encodeURIComponent("assets/badge.svg")}`,
    { headers: { Origin: TEST_ORIGIN } },
  );
  assert.equal(capabilityAssetResponse.ok, true);
  assert.equal(
    capabilityAssetResponse.headers.get("content-type"),
    "image/svg+xml",
  );
  assert.match(
    capabilityAssetResponse.headers.get("content-security-policy"),
    /default-src 'none'/,
  );
  assert.equal(await capabilityAssetResponse.text(), logoSvg);

  for (const rejectedPath of [
    ".env",
    "../outside-capability.svg",
    ...(process.platform === "win32" ? [] : ["assets/outside.svg"]),
  ]) {
    const rejectedAssetResponse = await fetch(
      `${baseUrl}/api/capability-asset?capabilityId=${encodeURIComponent(workbuddyCapability.id)}&path=${encodeURIComponent(rejectedPath)}`,
      { headers: { Origin: TEST_ORIGIN } },
    );
    assert.equal(rejectedAssetResponse.ok, false);
    assert.doesNotMatch(
      await rejectedAssetResponse.text(),
      /workbuddy-secret/i,
    );
  }

  const hermesCapability = capabilities.products
    .find((product) => product.id === "hermes")
    .items.find((item) => item.name === "default");
  assert.equal(hermesCapability.model, "openai-codex / gpt-test");
  assert.equal(hermesCapability.delegation.enabled, true);
  const hermesCapabilityFiles = await requestJson(
    `/api/capability-files?capabilityId=${encodeURIComponent(hermesCapability.id)}`,
  );
  assert.deepEqual(
    hermesCapabilityFiles.entries.map((entry) => entry.path),
    ["SOUL.md", "配置摘要.json"],
  );
  const hermesConfiguration = await requestJson(
    `/api/capability-file?capabilityId=${encodeURIComponent(hermesCapability.id)}&path=${encodeURIComponent("配置摘要.json")}`,
  );
  assert.match(hermesConfiguration.content, /gpt-test/);
  assert.doesNotMatch(hermesConfiguration.content, /do-not-expose|secret/i);
  const namedHermesCapability = capabilities.products
    .find((product) => product.id === "hermes")
    .items.find((item) => item.name === "research");
  assert.equal(namedHermesCapability.displayName, "深度研究 Agent");
  assert.equal(namedHermesCapability.model, "anthropic / claude-profile-test");
  const namedHermesConfiguration = await requestJson(
    `/api/capability-file?capabilityId=${encodeURIComponent(namedHermesCapability.id)}&path=${encodeURIComponent("配置摘要.json")}`,
  );
  assert.match(namedHermesConfiguration.content, /claude-profile-test/);
  assert.doesNotMatch(
    namedHermesConfiguration.content,
    /named-profile-secret|api_key/i,
  );

  const initialScan = await requestJson("/api/scan?force=1");
  const sourceInstance = initialScan.skills
    .find((skill) => skill.name === "sample-skill")
    .instances.find((instance) => instance.agentId === "codex");
  assert.ok(sourceInstance);
  const assetResponse = await fetch(
    `${baseUrl}/api/skill-asset?instanceId=${encodeURIComponent(sourceInstance.id)}&path=${encodeURIComponent("assets/logo.svg")}`,
    { headers: { Origin: TEST_ORIGIN } },
  );
  assert.equal(assetResponse.ok, true);
  assert.equal(assetResponse.headers.get("content-type"), "image/svg+xml");
  assert.equal(await assetResponse.text(), logoSvg);

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
  const divergentScan = await requestJson("/api/scan?force=1");
  const divergentSkill = divergentScan.skills.find(
    (skill) => skill.name === "sample-skill",
  );
  const divergentSource = divergentSkill.instances.find(
    (instance) => instance.agentId === "codex",
  );
  const divergentTarget = divergentSkill.instances.find(
    (instance) => instance.agentId === "claude",
  );
  const diffSummary = await requestJson(
    `/api/skill-diff?leftInstanceId=${encodeURIComponent(divergentSource.id)}&rightInstanceId=${encodeURIComponent(divergentTarget.id)}`,
  );
  assert.equal(diffSummary.summary.modified, 1);
  assert.equal(diffSummary.summary.unchanged, 1);
  assert.deepEqual(
    diffSummary.entries.map((entry) => [entry.path, entry.change]),
    [["SKILL.md", "modified"]],
  );
  const diffFile = await requestJson(
    `/api/skill-diff-file?leftInstanceId=${encodeURIComponent(divergentSource.id)}&rightInstanceId=${encodeURIComponent(divergentTarget.id)}&path=${encodeURIComponent("SKILL.md")}`,
  );
  assert.equal(diffFile.previewKind, "text");
  assert.ok(
    diffFile.lines.some(
      (line) => line.kind === "removed" && line.text === "第一版内容。",
    ),
  );
  assert.ok(
    diffFile.lines.some(
      (line) => line.kind === "added" && line.text === "第二版内容。",
    ),
  );
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
  assert.match(
    exportResponse.headers.get("content-disposition"),
    /sample-skill\.skill/,
  );
  const archive = new Uint8Array(await exportResponse.arrayBuffer());
  assert.ok(archive.byteLength > 0);

  const zipExportResponse = await fetch(
    `${baseUrl}/api/export-skill?instanceId=${encodeURIComponent(sourceInstance.id)}&format=zip`,
    { headers: { Origin: TEST_ORIGIN } },
  );
  assert.equal(zipExportResponse.ok, true);
  assert.equal(zipExportResponse.headers.get("content-type"), "application/zip");
  assert.match(
    zipExportResponse.headers.get("content-disposition"),
    /sample-skill\.zip/,
  );
  const zipArchive = new Uint8Array(await zipExportResponse.arrayBuffer());
  assert.ok(zipArchive.byteLength > 0);

  const imported = await requestJson("/api/import-skill", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-skill-filename": encodeURIComponent("sample-skill.skill"),
    },
    body: archive,
  });
  assert.equal(imported.name, "sample-skill");
  const importedAssetResponse = await fetch(
    `${baseUrl}/api/import-asset?importId=${encodeURIComponent(imported.importId)}&path=${encodeURIComponent("assets/logo.svg")}`,
    { headers: { Origin: TEST_ORIGIN } },
  );
  assert.equal(importedAssetResponse.ok, true);
  assert.equal(
    importedAssetResponse.headers.get("content-type"),
    "image/svg+xml",
  );
  assert.equal(await importedAssetResponse.text(), logoSvg);
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

  await requestJson("/api/config", {
    method: "PUT", body: JSON.stringify({ ...migratedConfig, visibleAgentIds: ["smartorder"] }),
  });
  const smartOrderScan = await requestJson("/api/scan?force=1");
  assert.deepEqual(smartOrderScan.skills.map((skill) => skill.name).sort(), ["local-demo", "plugin-demo", "system-demo"]);
  const pluginInstance = smartOrderScan.skills.find((skill) => skill.name === "plugin-demo").instances[0];
  const pluginContent = await requestJson(`/api/skill-file?instanceId=${pluginInstance.id}&path=SKILL.md`);
  assert.match(pluginContent.content, /酒店订单示例/);
  const protectedPlan = await fetch(`${baseUrl}/api/sync`, {
    method: "POST", headers: { Origin: TEST_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ sourceInstanceId: pluginInstance.id, targetAgentIds: ["smartorder"], dryRun: true }),
  });
  assert.equal(protectedPlan.status, 400);
  assert.match((await protectedPlan.json()).error, /仅提供读取/);
  assert.equal(await readFile(path.join(smartOrderFixture.pluginRoot, "skills", "plugin-demo", "SKILL.md"), "utf8"), pluginContent.content);
});
