import { symlink, truncate, utimes } from "node:fs/promises";
import path from "node:path";
import { PIXEL_PNG, SAFE_SVG } from "./integrations.mjs";
import { writeFixtureFile } from "./smartorder.mjs";

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const agentMd = (name, zh, maxTurns, extra = "") =>
  `---\nname: ${name}\ndescription: ${name} fixture\ndisplayName:\n  en: ${name}\n  zh: ${zh}\nprofession:\n  zh: ${zh}职业\nmaxTurns: ${maxTurns}\n---\n# ${zh}\n${extra}\n`;

/** WorkBuddy experts: market team + cache-only market expert + one of the user's own experts. */
export async function createWorkBuddyExpertFixture(home) {
  const plugins = path.join(home, ".workbuddy", "plugins");
  const team = path.join(plugins, "marketplaces", "experts", "plugins", "research-team");
  await writeFixtureFile(team, ".codebuddy-plugin/plugin.json", json({
    name: "research-team",
    version: "1.2.0",
    expertType: "team",
    agentName: "research-lead",
    displayName: { en: "Research Team", zh: "研究专家团" },
    displayDescription: { en: "Research", zh: "协作完成调研。" },
    profession: { zh: "研究团队" },
    avatar: "avatars/team.png",
    agents: ["./agents/research-lead.md", "./agents/analyst.md", "./agents/reviewer.md"],
    members: [
      { id: "research-lead", avatar: "avatars/lead.svg" },
      { id: "analyst", avatar: "avatars/missing.png" },
      { id: "reviewer", avatar: "avatars/huge.png" },
    ],
    skills: ["./skills/source-review"],
    defaultInitPrompt: { en: "Start research", zh: "开始调研" },
    quickPrompts: [{ en: "Summarize", zh: "总结一下" }],
    tags: [{ en: "Research", zh: "研究" }],
  }));
  await writeFixtureFile(team, "agents/research-lead.md", agentMd("research-lead", "研究负责人", 18, "Token: Bearer PLANTEXPERTTOKEN1234"));
  await writeFixtureFile(team, "agents/analyst.md", agentMd("analyst", "分析师", 12, "key sk-PLANTSKEXPERT12345678"));
  await writeFixtureFile(team, "agents/reviewer.md", agentMd("reviewer", "审稿人", 8));
  await writeFixtureFile(team, "avatars/team.png", PIXEL_PNG);
  await truncate(await writeFixtureFile(team, "avatars/huge.png", ""), 3_000_000);
  await writeFixtureFile(team, "avatars/lead.svg", SAFE_SVG);
  await writeFixtureFile(team, "skills/source-review/SKILL.md", "---\nname: source-review\n---\n");

  const cacheOnly = path.join(plugins, "cache", "experts", "solo-cache", "1.0.0");
  await writeFixtureFile(cacheOnly, ".codebuddy-plugin/plugin.json", json({
    name: "solo-cache",
    version: "1.0.0",
    expertType: "agent",
    displayName: { zh: "缓存专家" },
    agents: ["./agents/solo.md"],
    avatar: "avatars/escape.png",
  }));
  await writeFixtureFile(cacheOnly, "agents/solo.md", agentMd("solo-cache", "缓存专家", 5));
  const outsideImage = await writeFixtureFile(home, "outside/escape.png", PIXEL_PNG);
  if (process.platform !== "win32") {
    await writeFixtureFile(cacheOnly, "avatars/.keep", "");
    await symlink(outsideImage, path.join(cacheOnly, "avatars", "escape.png"));
  }

  const mineSource = path.join(plugins, "marketplaces", "my-experts", "plugins", "mine-expert");
  const mineManifest = {
    name: "mine-expert",
    version: "0.1.0",
    description: "我的专家",
    expertType: "agent",
    agentName: "mine-expert",
    displayName: { en: "Xiaochu", zh: "小初" },
    profession: { en: "Operator", zh: "内容运营" },
    displayDescription: { zh: "负责内容运营。" },
    avatar: "avatars/expert.png",
    categoryId: "06-ContentCreative",
    agents: ["./agents/mine-expert.md"],
    skills: ["./skills/mine-skill"],
    defaultInitPrompt: { zh: "你好，我是小初", en: "Hi" },
    quickPrompts: [{ zh: "写一篇笔记", en: "Write a note" }, { en: "Only English" }],
    tags: [{ en: "Content", zh: "内容" }],
    plugin: "mine-expert",
  };
  for (const root of [mineSource, path.join(plugins, "cache", "my-experts", "mine-expert", "0.1.0")]) {
    await writeFixtureFile(root, ".codebuddy-plugin/plugin.json", json(mineManifest));
    await writeFixtureFile(root, "agents/mine-expert.md", agentMd("mine-expert", "小初", 40));
    await writeFixtureFile(root, "avatars/expert.png", PIXEL_PNG);
    await writeFixtureFile(root, "skills/mine-skill/SKILL.md", "---\nname: mine-skill\n---\n");
  }
  await writeFixtureFile(plugins, "cache/my-experts/mine-expert/0.1.0/.in_use", "");
  await writeFixtureFile(plugins, "marketplaces/my-experts/dist/mine-expert.zip", "PK");
  const oversized = await writeFixtureFile(mineSource, "avatars/huge.png", "");
  await truncate(oversized, 3_000_000);
  return { plugins, team, mineSource, cacheOnly };
}

/** WorkBuddy's session database with expert usage; titles carry a planted marker. */
export async function createWorkBuddyUsageDatabase(home) {
  const { DatabaseSync } = await import("node:sqlite");
  const databasePath = path.join(home, ".workbuddy", "workbuddy.db");
  await writeFixtureFile(home, ".workbuddy/.keep", "");
  const database = new DatabaseSync(databasePath);
  database.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, expert_id TEXT, updated_at INTEGER)",
  );
  const insert = database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)");
  insert.run("a", "PLANT-TITLE-1", "ResearchTeam", Date.UTC(2026, 8, 1));
  insert.run("b", "PLANT-TITLE-2", "ResearchTeam", Date.UTC(2026, 8, 20));
  insert.run("c", "PLANT-TITLE-3", "mine-expert", Date.UTC(2026, 9, 1));
  insert.run("d", "PLANT-TITLE-4", "ex_cloud123", Date.UTC(2026, 9, 2));
  insert.run("e", "PLANT-TITLE-5", null, Date.UTC(2026, 9, 2));
  database.close();
  const stamp = new Date("2026-10-01T00:00:00Z");
  await utimes(databasePath, stamp, stamp);
  return databasePath;
}
