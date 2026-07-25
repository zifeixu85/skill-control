import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import {
  createSkillArchive,
  handleRequest,
  inspectSkillArchive,
  listSkillFiles,
  materializeSkillDirectory,
  parseFrontmatter,
  readSkillFileContent,
  scanAll,
} from "../server/local-server.mjs";

test("handles origin-less OPTIONS requests without stopping the service", async (context) => {
  const server = http.createServer(handleRequest);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
      }),
  );

  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const preflight = await fetch(`${baseUrl}/api/scan`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    service: "Skill Control local service",
  });
});

test("parses skill metadata and a useful body excerpt", () => {
  const parsed = parseFrontmatter(
    [
      "---",
      "name: example-skill",
      'description: "A portable test skill"',
      "tags: [test, portable]",
      "---",
      "# Example",
      "Use this skill carefully.",
    ].join("\n"),
    "fallback",
  );

  assert.equal(parsed.name, "example-skill");
  assert.equal(parsed.displayName, "example-skill");
  assert.equal(parsed.description, "A portable test skill");
  assert.deepEqual(parsed.tags, ["test", "portable"]);
  assert.match(parsed.body, /Use this skill carefully/);
});

test("prefers a Chinese heading and introduction for display metadata", () => {
  const parsed = parseFrontmatter(
    [
      "---",
      "name: local-skill-manager",
      "description: Manage local skills across agents.",
      "---",
      "# 本地技能管家",
      "",
      "统一管理不同 Agent 产品中已经安装的技能，并优先展示中文信息。",
      "",
      "## Usage",
    ].join("\n"),
    "fallback",
  );

  assert.equal(parsed.name, "local-skill-manager");
  assert.equal(parsed.displayName, "本地技能管家");
  assert.equal(
    parsed.description,
    "统一管理不同 Agent 产品中已经安装的技能，并优先展示中文信息。",
  );
});

test("parses folded YAML descriptions used by installed skills", () => {
  const parsed = parseFrontmatter(
    [
      "---",
      "name: folded-skill",
      "description: >-",
      "  A longer description that",
      "  spans multiple lines.",
      "license: MIT",
      "---",
      "Instructions.",
    ].join("\n"),
    "fallback",
  );

  assert.equal(
    parsed.description,
    "A longer description that spans multiple lines.",
  );
});

test("groups identical skills across agent directories", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "skill-control-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const codexRoot = path.join(temporaryRoot, "codex");
  const claudeRoot = path.join(temporaryRoot, "claude");
  const workbuddyRoot = path.join(temporaryRoot, "workbuddy");
  const manifest = [
    "---",
    "name: portable-skill",
    "description: Same content in two tools",
    "---",
    "# 可移植技能",
  ].join("\n");

  for (const skillsRoot of [codexRoot, claudeRoot]) {
    const skillDirectory = path.join(skillsRoot, "portable-skill");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(path.join(skillDirectory, "SKILL.md"), manifest, "utf8");
  }
  await mkdir(workbuddyRoot, { recursive: true });

  const result = await scanAll({
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
  });

  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0].status, "partial");
  assert.equal(result.skills[0].displayName, "可移植技能");
  assert.deepEqual(result.skills[0].installedAgentIds, ["codex", "claude"]);
  assert.equal(result.skills[0].hashes.length, 1);
  assert.deepEqual(result.skills[0].missingAgentIds, ["workbuddy"]);

  const defaultView = await scanAll({
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
  });
  assert.deepEqual(
    defaultView.agents
      .filter((agent) => agent.visible)
      .map((agent) => agent.id),
    ["codex", "claude"],
  );
  assert.equal(defaultView.skills[0].status, "synced");
  assert.equal(
    defaultView.agents.find((agent) => agent.id === "workbuddy").skillCount,
    0,
  );

  const hiddenSkillDirectory = path.join(workbuddyRoot, "hidden-skill");
  await mkdir(hiddenSkillDirectory, { recursive: true });
  await writeFile(
    path.join(hiddenSkillDirectory, "SKILL.md"),
    [
      "---",
      "name: hidden-skill",
      "description: Installed in a hidden Agent",
      "---",
      "# Hidden skill",
    ].join("\n"),
    "utf8",
  );
  const hiddenAgentView = await scanAll({
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
  });
  assert.equal(
    hiddenAgentView.agents.find((agent) => agent.id === "workbuddy").skillCount,
    1,
  );
  assert.equal(
    hiddenAgentView.skills.some((skill) => skill.name === "hidden-skill"),
    false,
  );
});

test("lists and reads files inside a skill without allowing path traversal", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "skill-browser-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const skillDirectory = path.join(temporaryRoot, "example-skill");
  await mkdir(path.join(skillDirectory, "references"), { recursive: true });
  await writeFile(
    path.join(skillDirectory, "SKILL.md"),
    "# 示例技能\n\n完整说明。",
    "utf8",
  );
  await writeFile(
    path.join(skillDirectory, "references", "guide.md"),
    "参考资料",
    "utf8",
  );

  const listing = await listSkillFiles(skillDirectory);
  assert.equal(listing.fileCount, 2);
  assert.equal(listing.directoryCount, 1);
  assert.deepEqual(
    listing.entries.map((entry) => entry.path),
    ["references", "references/guide.md", "SKILL.md"],
  );

  const content = await readSkillFileContent(skillDirectory, "SKILL.md");
  assert.equal(content.previewable, true);
  assert.equal(content.language, "markdown");
  assert.match(content.content, /完整说明/);

  await assert.rejects(
    readSkillFileContent(skillDirectory, "../outside.md"),
    /文件路径无效|Skill 目录之外/,
  );
});

test("reads and creates portable .skill archives with Unicode resources", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "skill-archive-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const skillDirectory = path.join(temporaryRoot, "localized-copy-helper");
  await mkdir(path.join(skillDirectory, "references"), { recursive: true });
  const manifest = [
    "---",
    "name: localized-copy-helper",
    "description: 中文商业文案技能。",
    "---",
    "# 中文文案助手",
  ].join("\n");
  await writeFile(path.join(skillDirectory, "SKILL.md"), manifest, "utf8");
  await writeFile(
    path.join(skillDirectory, "references", "方法论.md"),
    "完整参考内容",
    "utf8",
  );

  const archive = await createSkillArchive(
    skillDirectory,
    "localized-copy-helper",
  );
  const inspected = inspectSkillArchive(
    archive,
    "localized-copy-helper（示例）.skill",
  );
  assert.equal(inspected.name, "localized-copy-helper");
  assert.equal(inspected.displayName, "中文文案助手");
  assert.equal(inspected.fileCount, 2);
  assert.equal(
    inspected.files.get("references/方法论.md").toString("utf8"),
    "完整参考内容",
  );

  const rootlessArchive = zipSync({
    "SKILL.md": Buffer.from(manifest),
  });
  assert.equal(
    inspectSkillArchive(rootlessArchive, "rootless.skill").directoryName,
    "localized-copy-helper",
  );
});

test("replaces a skill only after preparing the new copy and preserves a backup", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "skill-replace-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const sourcePath = path.join(temporaryRoot, "source");
  const destinationPath = path.join(temporaryRoot, "agent", "example-skill");
  const backupPath = path.join(temporaryRoot, "backups", "example-skill");
  await mkdir(sourcePath, { recursive: true });
  await mkdir(destinationPath, { recursive: true });
  await writeFile(path.join(sourcePath, "SKILL.md"), "# 新版本", "utf8");
  await writeFile(path.join(destinationPath, "SKILL.md"), "# 原版本", "utf8");

  await materializeSkillDirectory({
    sourcePath,
    destinationPath,
    backupPath,
    mode: "copy",
  });

  assert.equal(
    await readFile(path.join(destinationPath, "SKILL.md"), "utf8"),
    "# 新版本",
  );
  assert.equal(
    await readFile(path.join(backupPath, "SKILL.md"), "utf8"),
    "# 原版本",
  );
  assert.deepEqual(
    (await readdir(path.dirname(destinationPath)))
      .filter((entry) => entry.includes("skill-control"))
      .sort(),
    [],
  );
});

test("refuses to export a .skill archive with an oversized file", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "skill-export-limit-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  await writeFile(path.join(temporaryRoot, "SKILL.md"), "# 示例", "utf8");
  const oversizedPath = path.join(temporaryRoot, "oversized.bin");
  await writeFile(oversizedPath, "");
  await truncate(oversizedPath, 25_000_001);

  await assert.rejects(
    createSkillArchive(temporaryRoot, "oversized-skill"),
    /超过 25 MB/,
  );
});
