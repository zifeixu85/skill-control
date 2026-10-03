import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  scanCapabilityCatalog,
  scanHermesProfiles,
  scanWorkBuddyExperts,
} from "../server/local-server.mjs";

const WORKBUDDY_EXPERTS_PATH = path.join(
  ".workbuddy",
  "plugins",
  "marketplaces",
  "experts",
  "plugins",
);

async function writeWorkBuddyPlugin(
  homeDirectory,
  directoryName,
  config,
  memberFiles,
) {
  const pluginRoot = path.join(
    homeDirectory,
    WORKBUDDY_EXPERTS_PATH,
    directoryName,
  );
  await mkdir(path.join(pluginRoot, ".codebuddy-plugin"), {
    recursive: true,
  });
  await writeFile(
    path.join(pluginRoot, ".codebuddy-plugin", "plugin.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  for (const [relativePath, content] of Object.entries(memberFiles)) {
    const filePath = path.join(pluginRoot, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
  }
  return pluginRoot;
}

test("WorkBuddy expert discovery skips sensitive, missing, and out-of-root members", async (context) => {
  const temporaryHome = await mkdtemp(
    path.join(tmpdir(), "skill-control-capabilities-"),
  );
  context.after(() => rm(temporaryHome, { recursive: true, force: true }));

  const configuredMembers = [
    "./agents/lead.md",
    "./.env",
    "./agents/missing.md",
    "./agents/internal.txt",
    "./agents/oversized.md",
    "./agents/SESSION.md",
    "./agents/API_KEY.md",
    "./agents/CREDENTIALS.md",
    "./agents/AUTHENTICATION.md",
    "./agents/TOKEN.md",
  ];
  const teamRoot = await writeWorkBuddyPlugin(
    temporaryHome,
    "research-team",
    {
      name: "research-team",
      displayName: { zh: "研究专家团", en: "Research Team" },
      expertType: "team",
      agents: configuredMembers,
    },
    {
      "agents/lead.md": [
        "---",
        "name: research-lead",
        "description: 负责研究规划。",
        "displayName:",
        "  zh: 研究负责人",
        "---",
        "# 研究负责人",
      ].join("\n"),
      ".env": "TOP_SECRET=member-secret-must-not-leak\n",
      "agents/internal.txt": "INTERNAL_SECRET=text-secret-must-not-leak\n",
      "agents/oversized.md": "OVERSIZED_SECRET=size-secret-must-not-leak\n",
      "agents/SESSION.md": "SESSION_SECRET=session-secret-must-not-leak\n",
      "agents/API_KEY.md": "API_KEY_SECRET=api-key-secret-must-not-leak\n",
      "agents/CREDENTIALS.md":
        "CREDENTIAL_SECRET=credential-secret-must-not-leak\n",
      "agents/AUTHENTICATION.md":
        "AUTH_SECRET=authentication-secret-must-not-leak\n",
      "agents/TOKEN.md": "TOKEN_SECRET=token-secret-must-not-leak\n",
    },
  );
  await truncate(path.join(teamRoot, "agents", "oversized.md"), 2_000_001);

  if (process.platform !== "win32") {
    const outsideMember = path.join(temporaryHome, "outside-agent.md");
    await writeFile(
      outsideMember,
      [
        "---",
        "name: outside-agent",
        "description: OUTSIDE_SECRET=symlink-secret-must-not-leak",
        "---",
      ].join("\n"),
      "utf8",
    );
    await symlink(
      outsideMember,
      path.join(teamRoot, "agents", "outside.md"),
    );
    configuredMembers.push("./agents/outside.md");
    await writeFile(
      path.join(teamRoot, ".codebuddy-plugin", "plugin.json"),
      `${JSON.stringify(
        {
          name: "research-team",
          displayName: { zh: "研究专家团", en: "Research Team" },
          expertType: "team",
          agents: configuredMembers,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  await writeWorkBuddyPlugin(
    temporaryHome,
    "solo-expert",
    {
      name: "solo-expert",
      displayName: { zh: "独立专家", en: "Solo Expert" },
      agents: ["./agent.md"],
    },
    {
      "agent.md": [
        "---",
        "name: solo-expert",
        "description: 独立完成任务。",
        "---",
        "# 独立专家",
      ].join("\n"),
    },
  );

  const product = await scanWorkBuddyExperts(temporaryHome);
  assert.equal(product.available, true);
  assert.equal(product.itemCount, 2);

  const team = product.items.find((item) => item.name === "research-team");
  assert.equal(team.kind, "expert-team");
  assert.deepEqual(
    team.members.map((member) => member.name),
    ["research-lead"],
  );

  const solo = product.items.find((item) => item.name === "solo-expert");
  assert.equal(solo.kind, "expert");
  assert.equal(solo.displayName, "独立专家");
  assert.equal(solo.memberCount, 1);

  const serialized = JSON.stringify(product);
  assert.doesNotMatch(
    serialized,
    /(?:member|text|size|session|api-key|credential|authentication|token|symlink)-secret-must-not-leak/i,
  );
});

test("Hermes discovery recognizes default and named profiles without exposing secrets", async (context) => {
  const temporaryHome = await mkdtemp(
    path.join(tmpdir(), "skill-control-hermes-"),
  );
  context.after(() => rm(temporaryHome, { recursive: true, force: true }));

  const hermesRoot = path.join(temporaryHome, ".hermes");
  const namedProfileRoot = path.join(hermesRoot, "profiles", "research");
  await Promise.all([
    mkdir(hermesRoot, { recursive: true }),
    mkdir(path.join(namedProfileRoot, "skills", "source-review"), {
      recursive: true,
    }),
  ]);
  await Promise.all([
    writeFile(
      path.join(hermesRoot, "config.yaml"),
      [
        "model:",
        "  provider: openai-codex",
        "  default: gpt-default-test",
        "  api_key: default-secret-must-not-leak",
        "agent:",
        "  max_turns: 24",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      path.join(hermesRoot, "SOUL.md"),
      "# 默认 Agent\n\n处理通用任务。",
      "utf8",
    ),
    writeFile(
      path.join(namedProfileRoot, "config.yaml"),
      [
        "model:",
        "  provider: anthropic",
        "  default: claude-profile-test",
        "  api_key: profile-secret-must-not-leak",
        "delegation:",
        "  orchestrator_enabled: true",
        "  max_concurrent_children: 4",
        "  max_spawn_depth: 2",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      path.join(namedProfileRoot, "profile.yaml"),
      [
        "name: research",
        "displayName: 深度研究 Agent",
        "description: 负责资料分析与任务委派。",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      path.join(namedProfileRoot, "SOUL.md"),
      "# 深度研究\n\n核验资料并委派子任务。",
      "utf8",
    ),
    writeFile(
      path.join(namedProfileRoot, "skills", "source-review", "SKILL.md"),
      "# Source review",
      "utf8",
    ),
    writeFile(
      path.join(namedProfileRoot, ".env"),
      "PROFILE_TOKEN=env-secret-must-not-leak\n",
      "utf8",
    ),
  ]);

  const product = await scanHermesProfiles(temporaryHome);
  assert.equal(product.available, true);
  assert.equal(product.itemCount, 2);

  const defaultProfile = product.items.find((item) => item.name === "default");
  assert.equal(defaultProfile.model, "openai-codex / gpt-default-test");
  assert.equal(defaultProfile.maxTurns, 24);

  const namedProfile = product.items.find((item) => item.name === "research");
  assert.equal(namedProfile.displayName, "深度研究 Agent");
  assert.equal(namedProfile.model, "anthropic / claude-profile-test");
  assert.equal(namedProfile.skillCount, 1);
  assert.deepEqual(namedProfile.delegation, {
    enabled: true,
    maxConcurrentChildren: 4,
    maxSpawnDepth: 2,
  });

  const catalog = await scanCapabilityCatalog(temporaryHome);
  assert.deepEqual(catalog.totals, {
    products: 1,
    profiles: 2,
    members: 0,
  });
  assert.equal("rootPath" in catalog.products[0].items[0], false);
  assert.doesNotMatch(
    JSON.stringify({ product, catalog }),
    /default-secret-must-not-leak|profile-secret-must-not-leak|env-secret-must-not-leak/i,
  );
});
