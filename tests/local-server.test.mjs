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
  compareSkillDirectories,
  createSkillArchive,
  handleRequest,
  inspectSkillArchive,
  listSkillFiles,
  materializeSkillDirectory,
  parseFrontmatter,
  readSkillFileContent,
  readSkillDirectoryDiffFile,
  readSkillImageAsset,
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
  assert.equal(parsed.displayName, "Example");
  assert.equal(parsed.description, "A portable test skill");
  assert.equal(parsed.descriptionZh, null);
  assert.deepEqual(parsed.tags, ["test", "portable"]);
  assert.match(parsed.body, /Use this skill carefully/);
});

test("uses the leading H1 as display name and offers a Chinese first paragraph separately", () => {
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
  assert.equal(parsed.description, "Manage local skills across agents.");
  assert.equal(
    parsed.descriptionZh,
    "统一管理不同 Agent 产品中已经安装的技能，并优先展示中文信息。",
  );

  const chineseFrontmatter = parseFrontmatter(
    "---\nname: zh\ndescription: 已经是中文的描述。\n---\n# 标题\n\n另一段中文介绍文字。\n",
    "zh",
  );
  assert.equal(chineseFrontmatter.description, "已经是中文的描述。");
  assert.equal(chineseFrontmatter.descriptionZh, null);
});

test("keeps a trailing # that is part of the H1 text and strips closing hashes", () => {
  assert.equal(parseFrontmatter("# Learn C#\n", "x").displayName, "Learn C#");
  assert.equal(parseFrontmatter("# Closed title ##\n", "x").displayName, "Closed title");
  assert.equal(parseFrontmatter("#NoSpace\n", "fallback").displayName, "fallback");
});

test("parses pathological Markdown and frontmatter in bounded time", () => {
  const inputs = [
    `---\nname: redos\n---\n${"a<".repeat(80_000)}\n`,
    `---\nname: redos\n---\n${"[a](".repeat(80_000)}\n`,
    `---\nname: redos\n---\n# ${"[a](".repeat(80_000)}\n`,
    `---\nname: redos\n---\n# a${" ".repeat(80_000)}b\n`,
    `---\nname: redos\ndescription: x\n${"tags: [a\n".repeat(20_000)}---\n`,
    `---\nname: redos\n---\n${"**a__".repeat(40_000)}\n`,
    `---\nname: redos\n---\n${"\n".repeat(80_000)}1`,
  ];
  for (const input of inputs) {
    const started = performance.now();
    parseFrontmatter(input, "fallback");
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 200, `took ${elapsed.toFixed(1)} ms`);
  }
});

test("prefers explicit frontmatter display names over body headings", () => {
  const ordered = parseFrontmatter(
    "---\nname: tech\ntitle: 标题\nname_zh: 中文名\n---\n",
    "fallback",
  );
  assert.equal(ordered.displayName, "中文名");
  for (const key of ["display_name", "displayName", "title", "name_zh", "name-zh"]) {
    const parsed = parseFrontmatter(
      `---\nname: tech-name\n${key}: 明确名称\ndescription: x\n---\n# Heading\n`,
      "fallback",
    );
    assert.equal(parsed.displayName, "明确名称", key);
  }
});

test("never derives display names from code comments, deeper headings or long titles", () => {
  const cases = [
    {
      name: "lark-calendar",
      expected: "calendar (v4)",
      body: [
        "# calendar (v4)",
        "",
        "## 身份",
        "",
        "```bash",
        "# BAD — bot 身份查用户日程，返回空列表",
        "lark-cli calendar +agenda --as bot",
        "# GOOD — user 身份查日程",
        "```",
      ],
    },
    {
      name: "lark-doc",
      expected: "docs",
      body: ["# docs", "", "```bash", "# 常用示例", "lark-cli docs +fetch", "```", "", "## 前置条件 — 执行操作前必读"],
    },
    {
      name: "lark-markdown",
      expected: "lark-markdown",
      body: ["## 快速决策", "", "```bash", "# BAD: 未转义正则特殊字符，可能匹配到错误位置", "```", "", "# markdown (v1)"],
    },
    {
      name: "lark-sheets",
      expected: "lark-sheets",
      body: ["```bash", "# workbook 定位：--url <workbook-url>", "```", "", "- 列表项不是名称", "", "### sheets"],
    },
    {
      name: "guizang-ppt-skill",
      expected: "Magazine Web Ppt",
      body: [
        "# Magazine Web Ppt",
        "",
        "> 来源识别: guizang-ppt-skill",
        "",
        "## 这个 Skill 做什么",
        "",
        "### 风格 A · 电子杂志风",
      ],
    },
    {
      name: "ameng-skill-scout",
      expected: "Skill Scout（ameng-skill-scout）",
      body: [
        "# Skill Scout（ameng-skill-scout）",
        "",
        "## Phase 1：搜索与下载",
        "",
        "```bash",
        "# skills.sh — 记录每个 Skill 的安装量 installs",
        "```",
      ],
    },
    {
      name: "long-title",
      expected: "long-title",
      body: ["# 这是一个非常非常长的标题，用来确认超过四十个字符的一级标题不会被当成技能名称使用，而是回退到技术名称"],
    },
  ];
  for (const { name, expected, body } of cases) {
    const parsed = parseFrontmatter(
      [`---`, `name: ${name}`, `description: "飞书示例：中文描述"`, `---`, "", ...body].join("\n"),
      "fallback",
    );
    assert.equal(parsed.displayName, expected, name);
    assert.doesNotMatch(parsed.displayName, /BAD|常用示例|workbook|风格 A|skills\.sh/u, name);
  }
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
  const backupSkillDirectory = path.join(
    codexRoot,
    ".backup",
    "portable-skill-older",
  );
  await mkdir(backupSkillDirectory, { recursive: true });
  await writeFile(
    path.join(backupSkillDirectory, "SKILL.md"),
    manifest.replace("Same content in two tools", "Archived content"),
    "utf8",
  );
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
  assert.equal(result.skills[0].instances.length, 2);
  assert.deepEqual(result.skills[0].installedAgentIds, ["codex", "claude"]);
  assert.equal(result.skills[0].hashes.length, 1);
  assert.deepEqual(result.skills[0].missingAgentIds, ["workbuddy"]);
  assert.equal("excerpt" in result.skills[0], false);
  assert.equal("excerpt" in result.skills[0].instances[0], false);
  assert.equal("description" in result.skills[0].instances[0], false);

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

test("compares skill versions at file and line level", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "skill-diff-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const candidateDirectory = path.join(temporaryRoot, "candidate");
  const comparisonDirectory = path.join(temporaryRoot, "comparison");
  await Promise.all([
    mkdir(path.join(candidateDirectory, "assets"), { recursive: true }),
    mkdir(path.join(candidateDirectory, ".venv"), { recursive: true }),
    mkdir(comparisonDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(candidateDirectory, "SKILL.md"),
      "# 示例\n\n相同行\n候选版本",
      "utf8",
    ),
    writeFile(
      path.join(comparisonDirectory, "SKILL.md"),
      "# 示例\n\n相同行\n对比版本",
      "utf8",
    ),
    writeFile(path.join(candidateDirectory, "same.txt"), "same", "utf8"),
    writeFile(path.join(comparisonDirectory, "same.txt"), "same", "utf8"),
    writeFile(
      path.join(candidateDirectory, "assets", "candidate.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    ),
    writeFile(
      path.join(comparisonDirectory, "comparison.json"),
      '{"version":1}',
      "utf8",
    ),
    writeFile(
      path.join(candidateDirectory, ".venv", "generated.py"),
      "not part of the skill",
      "utf8",
    ),
  ]);

  const comparison = await compareSkillDirectories(
    candidateDirectory,
    comparisonDirectory,
  );
  assert.deepEqual(comparison.summary, {
    modified: 1,
    leftOnly: 1,
    rightOnly: 1,
    typeChanged: 0,
    unchanged: 1,
    total: 4,
  });
  assert.deepEqual(
    comparison.entries.map((entry) => [entry.path, entry.change]),
    [
      ["SKILL.md", "modified"],
      ["assets/candidate.png", "left-only"],
      ["comparison.json", "right-only"],
    ],
  );

  const textDiff = await readSkillDirectoryDiffFile(
    candidateDirectory,
    comparisonDirectory,
    "SKILL.md",
  );
  assert.equal(textDiff.previewKind, "text");
  assert.ok(
    textDiff.lines.some(
      (line) => line.kind === "removed" && line.text === "对比版本",
    ),
  );
  assert.ok(
    textDiff.lines.some(
      (line) => line.kind === "added" && line.text === "候选版本",
    ),
  );

  const imageDiff = await readSkillDirectoryDiffFile(
    candidateDirectory,
    comparisonDirectory,
    "assets/candidate.png",
  );
  assert.equal(imageDiff.previewKind, "image");
  assert.equal(imageDiff.left?.mimeType, "image/png");
  assert.equal(imageDiff.right, null);
});

test("previews raster images and safe SVG files without allowing active SVG content", async (context) => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "skill-media-"));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const skillDirectory = path.join(temporaryRoot, "visual-skill");
  await mkdir(path.join(skillDirectory, "assets"), { recursive: true });
  await writeFile(path.join(skillDirectory, "SKILL.md"), "# Visual skill", "utf8");
  const pixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(path.join(skillDirectory, "assets", "pixel.png"), pixelPng);
  const safeSvg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">',
    "<defs><linearGradient id=\"g\"><stop stop-color=\"#d7f56d\"/></linearGradient></defs>",
    '<rect width="20" height="20" fill="url(#g)"/>',
    "</svg>",
  ].join("");
  await writeFile(
    path.join(skillDirectory, "assets", "mark.svg"),
    safeSvg,
    "utf8",
  );
  await writeFile(
    path.join(skillDirectory, "assets", "unsafe.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    "utf8",
  );

  const rasterMetadata = await readSkillFileContent(
    skillDirectory,
    "assets/pixel.png",
  );
  assert.equal(rasterMetadata.previewable, true);
  assert.equal(rasterMetadata.previewKind, "image");
  assert.equal(rasterMetadata.mimeType, "image/png");
  assert.equal(rasterMetadata.content, null);

  const svgMetadata = await readSkillFileContent(
    skillDirectory,
    "assets/mark.svg",
  );
  assert.equal(svgMetadata.previewKind, "image");
  assert.equal(svgMetadata.mimeType, "image/svg+xml");
  assert.match(svgMetadata.content, /linearGradient/);

  const rasterAsset = await readSkillImageAsset(
    skillDirectory,
    "assets/pixel.png",
  );
  assert.equal(rasterAsset.mimeType, "image/png");
  assert.deepEqual(rasterAsset.buffer, pixelPng);
  const svgAsset = await readSkillImageAsset(
    skillDirectory,
    "assets/mark.svg",
  );
  assert.equal(svgAsset.mimeType, "image/svg+xml");
  assert.equal(svgAsset.buffer.toString("utf8"), safeSvg);

  await assert.rejects(
    readSkillImageAsset(skillDirectory, "assets/unsafe.svg"),
    /不安全内容/,
  );
  const unsafeVariants = [
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg"><svg:script>alert(1)</svg:script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a><set attributeName="href" to="javascript:alert(1)"/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><animate attributeName="href" values="javascript:alert(1)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill: image-set(\'x.png\' 1x)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>rect { fill: \\75 rl(x) }</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="background:\\75 rl(x)"/></svg>',
  ];
  for (const [index, variant] of unsafeVariants.entries()) {
    await writeFile(path.join(skillDirectory, "assets", `variant-${index}.svg`), variant, "utf8");
    await assert.rejects(
      readSkillImageAsset(skillDirectory, `assets/variant-${index}.svg`),
      /不安全内容/,
      variant,
    );
  }
  await assert.rejects(
    readSkillImageAsset(skillDirectory, "../outside.png"),
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
