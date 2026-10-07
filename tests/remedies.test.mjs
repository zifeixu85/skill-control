import assert from "node:assert/strict";
import test from "node:test";
import { REMEDY_ALL_LIMIT, REMEDY_PROMPT_LIMIT, remedyForFinding, remedyForFindings, remedyForUpdate, remedyForUpdates, remedyForVersion } from "../server/remedies.mjs";

const home = "/Users/someone";
const context = { agentNames: { claude: "Claude Code", codex: "Codex", hermes: "Hermes Agent" }, homes: [home] };
const SAFETY = /先把它备份[\s\S]*不要打印、复制或移动任何密钥[\s\S]*删除任何东西前先问我/u;

test("each finding gets a Chinese prompt with the problem, agent, ~/ path, goal and safe steps", () => {
  const broken = remedyForFinding(
    { severity: "error", category: "broken-link", title: "失效的技能链接：pdf", detail: "链接指向的目录已不存在。", agentId: "claude", path: "~/.claude/skills/pdf" },
    context,
  );
  assert.match(broken.prompt, /^请帮我处理这个问题：失效的技能链接：pdf\n涉及：Claude Code（~\/\.claude\/skills\/pdf）/u);
  assert.match(broken.prompt, SAFETY);
  assert.deepEqual(broken.commands, [
    { label: "查看链接", command: "ls -l ~/.claude/skills/pdf" },
    { label: "移到废纸篓", command: "mv -n ~/.claude/skills/pdf ~/.Trash/" },
  ]);
  const spaced = remedyForFinding({ severity: "error", category: "broken-link", title: "x", path: "~/My Skills/a b" }, context);
  assert.equal(spaced.commands[0].command, 'ls -l ~/"My Skills/a b"', "paths with spaces are quoted after ~/");
  const injected = remedyForFinding({ severity: "error", category: "broken-link", title: "x", path: "~/a\"; rm -rf ~; \"" }, context);
  assert.equal(injected.commands, undefined, "unsafe paths get no command");

  const workspace = remedyForFinding(
    { severity: "warn", category: "cli-workspace-unconfigured", title: "hermes 使用的 飞书 CLI 工作区未配置", detail: "…", agentId: "hermes", hint: { command: "lark-cli", workspace: "hermes" } },
    context,
  );
  assert.deepEqual(workspace.commands, [{ label: "绑定工作区", command: "lark-cli config bind --source hermes" }]);
  assert.match(workspace.prompt, /Hermes Agent/u);
  const bad = remedyForFinding({ severity: "warn", category: "cli-workspace-unconfigured", title: "x", hint: { command: "lark-cli", workspace: "a; rm" } }, context);
  assert.equal(bad.commands, undefined);

  const env = remedyForFinding({ severity: "warn", category: "missing-env", title: "未设置环境变量 OP_TOKEN：x", hint: { env: "OP_TOKEN" } }, context);
  assert.match(env.prompt, /test -n "\$OP_TOKEN"/u);
  assert.match(env.prompt, /不要在对话里要求我粘贴这个值/u);
  const secret = remedyForFinding(
    { severity: "warn", category: "mcp-literal-secret", title: "MCP「docs」配置里有明文密钥", detail: `字段：env.API_KEY。api_key=ZZ9remedy01abcdef in ${home}/.codex/config.toml`, path: `${home}/.codex/config.toml`, hint: { mcp: "docs" } },
    context,
  );
  assert.doesNotMatch(secret.prompt, /ZZ9|\/Users\/someone/u, "no secret, no home path");
  assert.equal(secret.commands, undefined);
  const long = remedyForFinding({ severity: "info", category: "shared-root", title: "x", detail: "很长".repeat(2_000) }, context);
  assert.ok(long.prompt.length <= REMEDY_PROMPT_LIMIT);
  for (const category of ["missing-skill-md", "frontmatter", "oversize", "differing-copies", "missing-bin", "nvm-only", "mcp-command-missing", "plugin-state", "codex-tmp-leftovers", "update-available", "library-drift", "cli-version-skew", "cli-not-on-agent-path", "hidden-by-product"]) {
    const remedy = remedyForFinding({ severity: "warn", category, title: `问题 ${category}`, path: "~/x/y", hint: { command: "lark-cli" } }, context);
    assert.ok(remedy.prompt.length <= REMEDY_PROMPT_LIMIT, category);
    assert.match(remedy.prompt, SAFETY, category);
    for (const command of remedy.commands || []) assert.doesNotMatch(command.command, /\brm\b|sudo/u, category);
  }
});

test("remedyAll groups 需要处理 and 建议处理 issues, bounded, with read-only checks only", () => {
  const findings = [
    ...Array.from({ length: 40 }, (_, index) => ({ severity: "error", category: "broken-link", title: `失效的技能链接：s${index}`, agentId: "claude", path: `~/.claude/skills/s${index}` })),
    { severity: "warn", category: "cli-version-skew", title: "飞书 CLI 有 2 个不同版本", hint: { command: "lark-cli" } },
    { severity: "info", category: "shared-root", title: "技能目录被 2 个 Agent 共用" },
  ];
  const all = remedyForFindings(findings, context);
  assert.match(all.prompt, /^请帮我处理 Skill Control 体检里需要处理和建议处理的 41 个问题/u);
  assert.match(all.prompt, /【失效的软链接】40 项[\s\S]*另有 28 项同类问题[\s\S]*【命令行工具版本不一致】1 项/u);
  assert.doesNotMatch(all.prompt, /共用/u, "info findings are left out");
  assert.ok(all.prompt.length <= REMEDY_ALL_LIMIT);
  assert.ok(all.commands.every((command) => !command.command.startsWith("mv ")));
  assert.ok(all.commands.length <= 20);
  assert.match(remedyForFindings([{ severity: "info", category: "shared-root", title: "x" }], context).prompt, /没有需要处理/u);
});

test("update remedies: the unit's own command, Skill Control for self updates, backups for local edits", () => {
  const delegate = remedyForUpdate({ title: "lark-cli 技能", status: "update-available", current: "1.0.0", latest: "1.1.0", sourceLabel: "lark-cli", action: { kind: "delegate", label: "用 lark-cli 更新", command: "lark-cli update --json" }, instances: [{ agentId: "codex", path: "~/.agents/skills/lark-doc" }] });
  assert.deepEqual(delegate.commands, [{ label: "用 lark-cli 更新", command: "lark-cli update --json" }]);
  assert.match(delegate.prompt, /1\.0\.0 → 1\.1\.0/u);
  const self = remedyForUpdate({ title: "pdf", status: "conflict", action: { kind: "self", label: "用 Skill Control 更新" }, instances: [] });
  assert.equal(self.commands, undefined);
  assert.match(self.prompt, /有本地修改[\s\S]*Skill Control 的“更新”页面/u);
  assert.match(remedyForUpdate({ title: "x", status: "up-to-date" }).prompt, /已是最新版本/u);
  const all = remedyForUpdates([
    { title: "a", status: "update-available", action: { kind: "self" } },
    { title: "b", status: "update-available", action: { kind: "delegate", command: "codex plugin marketplace upgrade m --json" } },
    { title: "c", status: "update-available", action: { kind: "guide", label: "请在 WorkBuddy 的技能市场中更新这个技能。" } },
    { title: "d", status: "up-to-date" },
  ]);
  assert.match(all.prompt, /请帮我更新 3 个技能或插件[\s\S]*【在 Skill Control 里更新】1 项[\s\S]*【用各自的命令更新】1 项[\s\S]*【按说明手动更新】1 项/u);
  assert.deepEqual(all.commands, [{ label: "b", command: "codex plugin marketplace upgrade m --json" }]);
});

test("version remedies: nothing to do when up to date; official updaters otherwise", () => {
  const base = { name: "Claude Code", installed: { version: "2.1.0", source: "cli", path: "~/.local/share/claude/versions/2.1.0" }, latest: { version: "2.2.0" } };
  assert.equal(remedyForVersion({ ...base, status: "up-to-date" }), null);
  assert.deepEqual(remedyForVersion({ ...base, status: "update-available", feed: { kind: "npm" }, internal: { native: true } }).commands.map((item) => item.command), ["claude update", "claude --version"]);
  const npm = remedyForVersion({ id: "openclaw-cli", name: "OpenClaw", status: "update-available", installed: { version: "1", source: "npm", path: "~/x" }, latest: { version: "2" }, feed: { kind: "npm", package: "openclaw" }, internal: {} });
  assert.equal(npm.commands[0].command, "npm install -g openclaw@latest", "plain npm when the prefix has none");
  const app = remedyForVersion({ name: "WorkBuddy", status: "unknown", installed: { version: "5", source: "app", path: "/Applications/WorkBuddy.app" }, reason: "应用没有公开的更新源配置" });
  assert.match(app.prompt, /检查更新/u);
});
