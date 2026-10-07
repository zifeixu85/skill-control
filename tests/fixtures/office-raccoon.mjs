import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { writeFixtureFile } from "./smartorder.mjs";

/**
 * 办公小浣熊 shaped like the real app (v1.0.17): app bundle, app data with settings.json
 * (workspace dir, memoryEntries) and local-chat.sqlite3, and the ~/.box-agent workspace.
 * Secrets carry "ZZ9" (the leak marker); conversation text carries "MSGTEXT".
 */

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const skill = (name, body = "") => `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n\n${body}\n`;

export async function createRaccoonHome(home, { feedUrl = "https://updates.raccoon-fixture.cn/office-agent/mac" } = {}) {
  const app = path.join(home, "Applications", "办公小浣熊.app");
  await writeFixtureFile(app, "Contents/Info.plist", `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.sensetime.desktop.raccoon</string><key>CFBundleShortVersionString</key><string>1.0.17</string><key>CFBundleIconFile</key><string>icon.icns</string></dict></plist>\n`);
  await writeFixtureFile(app, "Contents/Resources/icon.icns", "icns");
  await writeFixtureFile(app, "Contents/Resources/app-update.yml", `provider: generic\nurl: ${feedUrl}\nupdaterCacheDirName: raccoon-ai-updater\n`);
  const builtin = path.join(app, "Contents", "Resources", "box-agent-runtime", "bin", "_internal", "box_agent", "skills");
  await writeFixtureFile(builtin, "docx/SKILL.md", skill("docx"));

  const data = path.join(home, "Library", "Application Support", "office-raccoon");
  await writeFixtureFile(data, "settings.json", json({
    systemSetting: { localAgentWorkspaceDir: "~/.box-agent", enableMemory: true, memoryRecallDays: 7, allowOpenClawMemoryImport: false, fileAccessScope: "custom", customAllowedDirectories: [`${home}/Documents`] },
    memoryEntries: [
      { id: "mem-1", content: "用户喜欢简洁的回答。api_key=ZZ9raccoonmemory01abc", source: "user", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z" },
      { id: "mem-2", content: `项目目录在 ${home}/work/raccoon-project`, source: "auto", createdAt: "2026-09-03T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z" },
    ],
    localTaskCenter: { records: [{ id: "t1", lastPrompt: "MSGTEXT-raccoon-task ZZ9raccoontask02" }] },
  }));
  const { DatabaseSync } = await import("node:sqlite");
  await mkdir(data, { recursive: true });
  const database = new DatabaseSync(path.join(data, "local-chat.sqlite3"));
  database.exec(
    "CREATE TABLE sessions (id TEXT, title TEXT, workspace_dir TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, last_chatted_at_ms INTEGER, payload_json TEXT);" +
      "CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, created_at_ms INTEGER, payload_json TEXT);",
  );
  const now = Date.now();
  database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)").run("s1", "MSGTEXT-raccoon-title ZZ9raccoontitle03", `${home}/work/raccoon-project`, now - 3_600_000, now - 1_800_000, now - 1_800_000, "{}");
  const message = (session, offset, payload) =>
    database.prepare("INSERT INTO messages (session_id, role, created_at_ms, payload_json) VALUES (?, ?, ?, ?)").run(session, "assistant", now - offset, JSON.stringify(payload));
  message("s1", 3_500_000, { content: "MSGTEXT-raccoon-answer ZZ9raccoonanswer04", usage_metadata: { token_usage: { promptTokens: 1_200, completionTokens: 300, totalTokens: 1_500, calls: 2 }, used_skill_codes: ["opc-alpha"], skill_invocations: [{ skill_code: "opc-alpha" }] } });
  message("s1", 3_400_000, { content: "MSGTEXT-raccoon-two", usage_metadata: { token_usage: { promptTokens: 800, completionTokens: 200, totalTokens: 1_000, calls: 1 } } });
  message("s1", 3_300_000, { content: "no usage here MSGTEXT" });
  database.close();

  const box = path.join(home, ".box-agent");
  await writeFixtureFile(box, "skills/opc-alpha/SKILL.md", skill("opc-alpha", "Use carefully."));
  await writeFixtureFile(box, "skills/opc-beta/SKILL.md", skill("opc-beta"));
  await writeFixtureFile(box, "skills/opc-context-governance.md", "# Shared context, not a skill\n");
  await writeFixtureFile(box, "skills/.backups/old/SKILL.md", skill("old"));
  await writeFixtureFile(home, "elsewhere/linked-skill/SKILL.md", skill("linked-skill"));
  await symlink(path.join(home, "elsewhere", "linked-skill"), path.join(box, "skills", "linked-skill"));
  await writeFixtureFile(box, "config/skill-settings.json", json({ disabledSkillNames: ["opc-beta"] }));
  await writeFixtureFile(box, "config/config.yaml", "api_key: sk-ZZ9raccoonkey05abcdefghij\napi_base: https://llm.raccoon-fixture.cn/v1?token=ZZ9raccoonbase06\nmodel: raccoon-pro\nprovider: sensetime\nmax_output_tokens: 8192\nenable_memory: true\nmemory_recall_days: 7\nimage_generation:\n  model: raccoon-image\n  api_key: ZZ9raccoonimage07\n");
  await writeFixtureFile(box, "config/auth.json", json({ token: "ZZ9raccoonauth08" }));
  await writeFixtureFile(box, "config/mcp.json", json({ mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp"] }, search: { url: "https://search.raccoon-fixture.cn/mcp?key=ZZ9raccoonmcp09" } } }));
  await writeFixtureFile(box, "config/workspaces.json", json({ schema_version: 1, workspaces: [{ path: `${home}/work/raccoon-project`, task_type: "analysis", updated_at: "2026-09-01" }] }));
  await writeFixtureFile(box, "config/expert-profiles.json", json({
    schemaVersion: 2,
    experts: [
      {
        id: "custom-expert-1",
        name: "市场分析师",
        role: "分析市场",
        description: "帮你做市场研究",
        source: "user",
        starterPrompt: "开始前先确认 token=ZZ9raccoonprompt10abc 不要外传",
        instructions: ["先问清目标"],
        defaultSkills: ["opc-alpha"],
        requiredSkills: ["opc-alpha", "opc-missing"],
        optionalSkills: ["docx"],
        revision: "r3",
        updatedAt: "2026-09-05T00:00:00Z",
      },
    ],
    teams: [
      {
        id: "team-1",
        name: "增长团队",
        description: "一起做增长",
        source: "user",
        executionMode: "orchestrated",
        leader: { id: "lead", name: "负责人", role: "统筹", defaultSkills: ["opc-alpha"] },
        members: [{ id: "m1", name: "研究员", role: "研究", defaultSkills: ["opc-beta"] }],
        workflow: ["收集信息", "形成方案"],
        revision: "r1",
      },
    ],
  }));
  await writeFixtureFile(box, "config/expert-profiles.json.bak-20260901", json({ experts: [{ id: "old", name: "旧专家" }] }));
  await writeFixtureFile(box, "memory/MEMORY.md", "# 记忆\n\npassword: ZZ9raccoonmemfile11\n");
  await writeFixtureFile(box, "memory/memory_summary.md", "# 摘要\n");
  await writeFixtureFile(box, "memory/context/project.md", "# 项目\n");
  await writeFixtureFile(box, "memory/v2/experiences/feedback.md", "# 反馈\n");
  await writeFixtureFile(box, "memory/.backups/old.md", "# 备份\n");
  return { app, data, box };
}
