import { execFile } from "node:child_process";
import { appendFile, mkdir, symlink, utimes } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createHermesHome, createOpenClawHome } from "./claw-hermes.mjs";
import { writeFixtureFile } from "./smartorder.mjs";

/**
 * Agent files, tools and transcripts for /api/agent-files, /api/agent-tools and the usage
 * index. Secrets contain "ZZ9" (the leak marker) in credential-shaped text the redactor
 * must catch; conversation text contains "MSGTEXT", which must never reach the index.
 */

const POSIX = process.platform !== "win32";
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const line = (value) => `${JSON.stringify(value)}\n`;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

export async function createAgentFilesHome(home) {
  const codex = path.join(home, ".codex");
  await writeFixtureFile(codex, "AGENTS.md", `# Codex rules\n\nAPI_KEY=ZZ9codexagents11\nWork in \`${home}\` only.\n`);
  await writeFixtureFile(codex, "rules/default.rules", 'prefix_rule(pattern=["curl", "-H", "Authorization: Bearer ZZ9codexrule12abcdefghijklmnop"], decision="allow")\n');
  await writeFixtureFile(codex, "memories/MEMORY.md", "# Memory\n\npassword: ZZ9codexmemory13\n");
  await writeFixtureFile(codex, "memories/rollout_summaries/2026-10-01.md", "summary token=ZZ9codexsummary14\n");
  await writeFixtureFile(codex, "memories/session-secrets.md", "ZZ9codexsensitive16 plain\n");
  await writeFixtureFile(codex, "auth.json", json({ tokens: { access: "ZZ9codexauth15" } }));
  if (POSIX) await promisify(execFile)("mkfifo", [path.join(codex, "memories", "pipe.md")]);

  const claude = path.join(home, ".claude");
  await writeFixtureFile(claude, "CLAUDE.md", "# Global\n\napi_key = ZZ9claudemd17abc\n");
  await writeFixtureFile(claude, "rules/common/security.md", "export GITHUB_TOKEN=ZZ9clauderule18\n");
  await writeFixtureFile(claude, "agents/reviewer.md", "---\nname: reviewer\ndescription: Reviews code. token: ZZ9claudeagent19x\n---\nBody\n");
  await writeFixtureFile(claude, "commands/deploy.md", "---\ndescription: Deploy with secret=ZZ9claudecmd20\n---\nRun it\n");
  await writeFixtureFile(claude, "projects/-work-alpha/memory/MEMORY.md", "secret: ZZ9claudememory21\n");
  await writeFixtureFile(home, "outside/secret.md", "password=ZZ9claudeescape22\n");
  if (POSIX) await symlink(path.join(home, "outside", "secret.md"), path.join(claude, "rules", "escape.md"));
  await writeFixtureFile(claude, "settings.json", json({
    permissions: {
      defaultMode: "acceptEdits",
      allow: ["Bash(npm test)", "Bash(curl -H 'Authorization: Bearer ZZ9claudeperm23abcdefghijkl' https://x.test)"],
      deny: ["Read(./.env)"],
      ask: ["WebFetch(domain:example.test)"],
    },
  }));

  const workbuddy = path.join(home, ".workbuddy");
  await writeFixtureFile(workbuddy, "SOUL.md", "# 人格\n\n密钥：ZZ9wbsoul24abc\n");
  await writeFixtureFile(workbuddy, "IDENTITY.md", "- Name: Buddy\n");
  await writeFixtureFile(workbuddy, "USER.md", "token: ZZ9wbuser25\n");
  await writeFixtureFile(workbuddy, "MEMORY.md", "the api key is ZZ9wbmemory26x\n");
  await writeFixtureFile(workbuddy, "mcp-tool-list.json", json({
    version: 1,
    entries: { "9a9106004679950484177d069df938ff": [{ name: "search_docs", description: "Search docs. Use token=ZZ9wbtool27" }] },
  }));
  const account = path.join(workbuddy, "connectors", "4ef3dbe5-38b8-4ab0-b076-fda433dbbba5");
  await writeFixtureFile(account, "connector-states.json", json({
    version: 2,
    connectors: { feishu: { bound: true, enabled: true }, "baidu-netdisk": { bound: false, enabled: false } },
    headerOverrides: { feishu: { Authorization: "Bearer ZZ9wbheader28abcdefghijklmn" } },
    envOverrides: { feishu: { APP_SECRET: "ZZ9wbenv29" } },
  }));
  await writeFixtureFile(account, ".credentials.v3.json", json({ token: "ZZ9wbcred30" }));

  await createHermesHome(home);
  await appendFile(
    path.join(home, ".hermes", "config.yaml"),
    "command_allowlist:\n  - \"curl -H 'Authorization: Bearer ZZ9hermesallow31abcdefghijk' https://x.test\"\n",
  );
  await writeFixtureFile(home, ".hermes/hermes-agent/toolsets.py", `
_CORE_TOOLS = [
    "web_search",
    "terminal",  # shell
    "read_file",
]

TOOLSETS = {
    "web": {
        "description": "Web research tools",
        "tools": ["web_search", "web_extract"],
        "includes": []
    },

    "hermes-cli": {
        "description": (
            "Full interactive CLI toolset "
            "with every default tool"
        ),
        "tools": _CORE_TOOLS,
        "includes": ["web"]
    },

    "safe": {
        "description": 'Safe toolkit without terminal access',
        "tools": [],
        "includes": ["web"]
    },
}
`);
  await createOpenClawHome(home);
  await writeFixtureFile(home, ".openclaw/agents/main/LESSONS.md", "# Lessons\n\ntoken=ZZ9oclesson32\n");
}

/** Claude, Codex and WorkBuddy transcripts plus WorkBuddy's usage log and database. */
export async function createTranscriptsHome(home, { withDatabase = true } = {}) {
  const claude = path.join(home, ".claude", "projects", "-work-alpha-project");
  const assistant = (id, usage, content, extra = {}, model = "claude-opus-5-5") => ({
    type: "assistant",
    timestamp: ago(3_600_000),
    cwd: "/work/alpha-project",
    sessionId: "s1",
    message: { id, role: "assistant", model, usage, content },
    ...extra,
  });
  const usage1 = {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20,
    cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 15 },
    speed: "standard",
  };
  const s1 = [
    { type: "user", timestamp: ago(3_700_000), cwd: "/work/alpha-project", message: { role: "user", content: "MSGTEXT-claude-user please ZZ9claudeprompt01" } },
    assistant("msg_1", usage1, [{ type: "text", text: "MSGTEXT-claude-answer" }], { attributionSkill: "pdf" }),
    assistant("msg_1", usage1, [{ type: "tool_use", id: "toolu_1", name: "Skill", input: { skill: "pdf", args: "MSGTEXT-skill-args" } }], { attributionSkill: "pdf" }),
    assistant("msg_2", { input_tokens: 1, output_tokens: 2 }, [{ type: "text", text: "MSGTEXT-claude-two" }], {}, "claude-sonnet-5-5"),
  ];
  await writeFixtureFile(claude, "s1.jsonl", s1.map(line).join(""));
  // A resumed session copies earlier messages into a new file; they must be counted once.
  await writeFixtureFile(claude, "s2.jsonl", [
    s1[1],
    s1[2],
    // A credential-shaped model id is never stored.
    assistant("msg_3", { input_tokens: 4, output_tokens: 4 }, [{ type: "text", text: "MSGTEXT-claude-three" }], {}, "sk-ant-api03-ZZ9modelkey40abcdefgh"),
  ].map(line).join(""));
  await writeFixtureFile(claude, "s1/subagents/agent-a.jsonl", line(assistant("msg_4", { input_tokens: 7, output_tokens: 3 }, [], {}, "claude-haiku-4-5-20251001")));

  const codex = path.join(home, ".codex");
  const event = (payload, offset = 3_600_000) => ({ timestamp: ago(offset), type: "event_msg", payload });
  const totals = (input, cached, output) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: 0,
    total_tokens: input + output,
  });
  await writeFixtureFile(codex, "sessions/2026/10/03/rollout-2026-10-03T10-00-00-aaaa.jsonl", [
    { timestamp: ago(3_700_000), type: "session_meta", payload: { id: "a", cwd: "/work/beta-project", base_instructions: "MSGTEXT-codex-instructions" } },
    { timestamp: ago(3_650_000), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "MSGTEXT-codex-user ZZ9codexuser05" }] } },
    { timestamp: ago(3_645_000), type: "turn_context", payload: { model: "gpt-5.5", cwd: "/work/beta-project", user_instructions: "MSGTEXT-codex-turn" } },
    {
      timestamp: ago(3_640_000),
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "cat ~/.codex/skills/lark-doc/SKILL.md # MSGTEXT-codex-args" }) },
    },
    {
      timestamp: ago(3_630_000),
      type: "response_item",
      payload: { type: "function_call_output", output: "see skills/output-only/SKILL.md MSGTEXT-codex-output" },
    },
    event({ type: "token_count", info: { total_token_usage: totals(1_000, 800, 50), last_token_usage: totals(1_000, 800, 50) } }),
    event({ type: "token_count", info: { total_token_usage: totals(1_000, 800, 50), last_token_usage: totals(1_000, 800, 50) } }),
    event({ type: "token_count", info: { total_token_usage: totals(1_500, 1_000, 80), last_token_usage: totals(500, 200, 30) } }),
  ].map(line).join(""));
  // A fork starts from its parent's running total: only its own turn counts.
  await writeFixtureFile(codex, "archived_sessions/rollout-2026-10-03T11-00-00-bbbb.jsonl", [
    { timestamp: ago(3_000_000), type: "session_meta", payload: { id: "b", cwd: "/work/beta-project" } },
    { timestamp: ago(2_950_000), type: "turn_context", payload: { model: "codex-auto-review", cwd: "/work/beta-project" } },
    event({ type: "token_count", info: { total_token_usage: totals(50_000, 40_000, 100), last_token_usage: totals(100, 0, 0) } }, 2_900_000),
  ].map(line).join(""));

  const workbuddy = path.join(home, ".workbuddy");
  await writeFixtureFile(workbuddy, "projects/Users-x-WorkBuddy-1/w1.jsonl", [
    { type: "message", role: "user", timestamp: ago(3_600_000), cwd: "/work/gamma-project", content: "MSGTEXT-wb-user ZZ9wbuser08" },
    {
      type: "function_call",
      name: "Skill",
      timestamp: ago(3_590_000),
      cwd: "/work/gamma-project",
      arguments: JSON.stringify({ skill: "xlsx", args: "MSGTEXT-wb-args" }),
      providerData: { messageId: "m1", model: "glm-5.2" },
      message: { usage: { input_tokens: 300, output_tokens: 20, total_tokens: 320, cache_read_input_tokens: 200 } },
    },
    {
      type: "function_call",
      name: "Bash",
      timestamp: ago(3_580_000),
      arguments: JSON.stringify({ command: "echo MSGTEXT-wb-bash" }),
      providerData: { messageId: "m2", model: "auto" },
      message: { usage: { input_tokens: 50, output_tokens: 5, total_tokens: 55, cache_read_input_tokens: 0 } },
    },
  ].map(line).join(""));
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  await writeFixtureFile(workbuddy, "usage-log.json", json({
    version: 1,
    skills: { xlsx: { id: "x", type: "skill", lastUsedDate: todayKey, recentDates: [todayKey], firstSeenDate: todayKey } },
  }));
  if (withDatabase) {
    const { DatabaseSync } = await import("node:sqlite");
    await mkdir(workbuddy, { recursive: true });
    const database = new DatabaseSync(path.join(workbuddy, "workbuddy.db"));
    database.exec(
      "CREATE TABLE sessions (id TEXT, title TEXT, cwd TEXT, created_at INTEGER); CREATE TABLE session_usage (session_id TEXT, used INTEGER, size INTEGER, updated_at INTEGER, credit_json TEXT);",
    );
    database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run("w1", "MSGTEXT-wb-title ZZ9wbtitle33", "/work/gamma-project", Date.now() - 3_600_000);
    database.prepare("INSERT INTO session_usage VALUES (?, ?, ?, ?, ?)").run("w1", 1000, 200000, Date.now(), JSON.stringify({ r1: 1.5, r2: 2.25 }));
    database.close();
  }
  // Old transcript files keep their mtimes so "newest first" ordering is deterministic.
  const old = new Date(Date.now() - 2 * 86_400_000);
  await utimes(path.join(codex, "archived_sessions", "rollout-2026-10-03T11-00-00-bbbb.jsonl"), old, old);
}
