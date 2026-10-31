import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const agents = await loadTs("app/lib/agents.ts");
const platform = await loadTs("app/lib/platform.ts");
const navigation = await loadTs("app/lib/navigation.ts");
const onboarding = await loadTs("app/lib/onboarding.ts");
const folder = await loadTs("app/lib/folder-zip.ts");
const diff = await loadTs("app/lib/skill-diff.ts");
const appUpdate = await loadTs("app/lib/app-update.ts");
const versions = await loadTs("app/lib/agent-versions.ts");
const library = await loadTs("app/lib/library.ts");
const importErrors = await loadTs("app/lib/import-errors.ts");
const cli = await loadTs("app/lib/cli-tools.ts");

test("one session count everywhere: the usage index wins, the file scan is the fallback", () => {
  const activity = { status: "ok", basis: "files", files30d: 139, tokens30d: 0, activeDays30d: 18 };
  assert.equal(agents.activityLine(activity, { sessions: 126, activeDays: 17 }), "近 30 天 126 个会话 · 17 天在用");
  assert.equal(agents.activityLine(activity, null), "近 30 天 139 个会话 · 18 天在用", "while usage is still counting");
  assert.equal(agents.activityLine(undefined, null), "近 30 天暂无记录");
});

test("onboarding offers installed Agents only, with 还没有技能, and never preselects placeholders", () => {
  const list = [
    { id: "codex", available: false, skillCount: 0 },
    { id: "claude", available: true, installed: true, skillsDir: "missing", skillCount: 0 },
    { id: "workbuddy", available: true, skillCount: 4 },
    { id: "gemini", available: false, installed: true, skillsDir: "missing", skillCount: 0 },
  ];
  const weights = { claude: 9, workbuddy: 2 };
  assert.deepEqual(agents.pickableAgents(list, (id) => weights[id] || 0).map((agent) => agent.id), ["claude", "workbuddy", "gemini"]);
  assert.equal(agents.noSkillsYet(list[1]), true);
  assert.equal(agents.noSkillsYet(list[2]), false);
  assert.equal(agents.isInstalled(list[3]), true, "v0.3 installed wins over the skills folder");
  assert.deepEqual(agents.initialPrimary(["codex", "claude", "workbuddy"], ["claude", "workbuddy"]), ["claude", "workbuddy"]);
  assert.deepEqual(agents.initialPrimary(["codex"], []), [], "nothing installed: nothing selected, 开始使用 stays off");
});

test("联网 notice lives in config.network: seen time, env switch, and the write", () => {
  assert.equal(onboarding.noticeSeen({ network: { noticeSeenAt: null } }), false, "fresh install: no automatic check yet");
  assert.equal(onboarding.noticeSeen({ network: { noticeSeenAt: "before-0.3" } }), true, "older configs were already checking");
  assert.equal(onboarding.envOffline({ network: { envOffline: true } }), true);
  assert.equal(onboarding.envOffline(null), false);
  assert.deepEqual(onboarding.networkPatch(false), { network: { updateChecks: false, noticeSeen: true } });
  assert.match(onboarding.ENV_OFFLINE_TEXT, /已被环境变量关闭/);
});

test("import answers: pick one of several skills, plain words for no-skill and too-large", () => {
  const apiError = (code, message, details = {}) => Object.assign(new Error(message), { name: "ApiError", code, details });
  assert.deepEqual(importErrors.skillChoicesOf(apiError("multiple-skills", "这里有 2 个技能", { skills: [{ root: "skills/a", name: "a" }, { root: "skills/b" }, { name: "x" }] })), [
    { root: "skills/a", name: "a" },
    { root: "skills/b", name: "skills/b" },
  ]);
  assert.equal(importErrors.skillChoicesOf(apiError("no-skill", "x")), null);
  assert.equal(importErrors.skillChoicesOf(new Error("x")), null);
  assert.match(importErrors.importErrorMessage(apiError("no-skill", "server words"), "f"), /没有找到 SKILL\.md/);
  assert.match(importErrors.importErrorMessage(apiError("too-large", "文件夹超过 100 MB。"), "f"), /太大了.*文件夹超过 100 MB.*单个文件最多 25 MB/);
  assert.equal(importErrors.importErrorMessage(apiError("other", "原话"), "f"), "原话");
  assert.equal(importErrors.desktopFolderPicker(), null, "no bridge: the page zips the folder itself");
});

test("detection evidence as a quiet hint; CLI rows that can't be judged are not problems", () => {
  assert.equal(agents.detectedHint(["~/.claude.json", "command:claude", "app:Claude.app"]), "检测依据：~/.claude.json、claude 命令 等 3 项");
  assert.equal(agents.detectedHint(["extension:rooveterinaryinc.roo-cline"], 4), "检测依据：VS Code 扩展 rooveterinaryinc.roo-cline");
  assert.equal(agents.detectedHint([]), "");
  const [tool] = cli.normalizeCliTools({
    tools: [{ id: "gh", name: "gh", agents: [
      { agentId: "codex", pathSource: "shell snapshot", status: "found", resolves: { path: "/opt/homebrew/bin/gh", version: "2.60" } },
      { agentId: "claude", pathSource: "", status: "unknown", note: "还无法判断（这个 Agent 还没记录过终端环境）" },
      { agentId: "workbuddy", pathSource: "shell snapshot", resolves: null },
    ] }],
  });
  assert.deepEqual(tool.agents.map((row) => row.status), ["found", "unknown", "missing"]);
  const unknown = cli.agentChecks(tool.agents[1], null).find((check) => check.key === "command");
  assert.deepEqual([unknown.state, unknown.short], ["na", "无法判断"]);
  assert.equal(cli.agentChecks(tool.agents[2], null)[0].state, "bad");
  assert.deepEqual(tool.availability.map((entry) => entry.available), [true, null, false], "unknown is not 'not found'");
});

test("first-run promises are the accurate privacy wording, and update checks default on", () => {
  const text = onboarding.PROMISES.map((item) => `${item.title}${item.detail}`).join("\n");
  assert.match(text, /只保存数字，不保存、不上传对话内容/);
  assert.match(text, /只在本机保存一个加盐指纹，用来判断是否变化/);
  assert.match(text, /会联网检查更新/);
  assert.doesNotMatch(text, /不读取对话内容|从不读取密钥/);
  assert.equal(onboarding.updateChecksOn(null), true);
  assert.equal(onboarding.updateChecksOn({ network: {} }), true);
  assert.equal(onboarding.updateChecksOn({ network: { updateChecks: false } }), false);
});

test("reveal wording follows the platform", () => {
  assert.equal(platform.platformFrom("darwin"), "mac");
  assert.equal(platform.platformFrom("MacIntel"), "mac");
  assert.equal(platform.platformFrom("win32"), "windows");
  assert.equal(platform.platformFrom("Windows"), "windows");
  assert.equal(platform.platformFrom("Linux x86_64"), "linux");
  assert.deepEqual(Object.values(platform.REVEAL_LABELS), ["在访达中显示", "在资源管理器中显示", "在文件管理器中显示"]);
});

test("menu navigation: known pages and plain section ids only", () => {
  assert.deepEqual(navigation.navigateTarget({ page: "settings" }), { page: "settings" });
  assert.deepEqual(navigation.navigateTarget({ page: "settings", section: "privacy" }), { page: "settings", section: "privacy" });
  assert.deepEqual(navigation.navigateTarget({ page: "settings", section: "../x" }), { page: "settings" });
  assert.equal(navigation.navigateTarget({ page: "nowhere" }), null);
  assert.equal(navigation.navigateTarget("settings"), null);
});

test("folder import: one top folder, litter left out, SKILL.md and limits checked", () => {
  const file = (path, size = 10) => ({ path, size, file: new Blob(["x"]) });
  const plan = folder.planFolder([file("my-skill/SKILL.md"), file("my-skill/scripts/run.sh"), file("my-skill/.git/HEAD"), file("my-skill/node_modules/a/index.js"), file("my-skill/.DS_Store")]);
  assert.equal(plan.error, null);
  assert.equal(plan.root, "my-skill");
  assert.deepEqual(plan.files.map((item) => item.path), ["my-skill/SKILL.md", "my-skill/scripts/run.sh"]);
  assert.equal(plan.skipped, 3);
  assert.match(folder.planFolder([file("x/readme.md")]).error, /没有 SKILL\.md/);
  assert.match(folder.planFolder([]).error, /空的/);
  assert.match(folder.planFolder([file("big/SKILL.md", 26_000_000)]).error, /25 MB/);
  assert.equal(folder.planFolder([file("SKILL.md")]).root, "skill", "loose files get a folder");
  assert.deepEqual(folder.filesFromInput(null), []);
});

test("版本不同: diff payloads and which copies an update would overwrite", () => {
  const parsed = diff.normalizeSkillDiff({ summary: { modified: 1, leftOnly: 1, total: 4 }, entries: [{ path: "SKILL.md", change: "modified" }, { path: "x", change: "weird" }, { change: "modified" }], truncated: false });
  assert.deepEqual(parsed.entries, [{ path: "SKILL.md", change: "modified" }, { path: "x", change: "modified" }]);
  assert.equal(parsed.summary.total, 4);
  const file = diff.normalizeDiffFile({ path: "SKILL.md", previewKind: "text", lines: [{ kind: "added", text: "v2", leftNumber: null, rightNumber: 3 }, { kind: "skip", text: "8 行未变化" }, { kind: "?", text: "a" }] });
  assert.deepEqual(file.lines.map((line) => line.kind), ["added", "skip", "context"]);
  assert.equal(diff.normalizeDiffFile({ previewKind: "binary" }).previewKind, "unavailable");
  const line = (kind, text) => ({ kind, text, leftNumber: null, rightNumber: null });
  assert.deepEqual(
    diff.orderChanges([line("context", "a"), line("added", "new"), line("removed", "old"), line("context", "b"), line("added", "x")]).map((item) => item.text),
    ["a", "old", "new", "b", "x"],
  );

  const newest = { id: "lib", agentId: "codex", hash: "new" };
  const older = { id: "cl", agentId: "claude", hash: "old" };
  const view = { differs: true, skill: { newest: { instanceId: "lib" }, behind: ["claude", "workbuddy"], instances: [newest, older] }, writable: { claude: [older], workbuddy: [] } };
  assert.deepEqual(diff.versionGap(view), { newest, older: [older] }, "read-only or missing copies can't be updated");
  assert.equal(diff.versionGap({ ...view, differs: false }), null);
  assert.equal(diff.versionGap({ ...view, writable: {} }), null);
});

test("app update: failure actions from the bridge, and the store runs them", async () => {
  const failed = appUpdate.normalizeState({ status: "error", error: "macOS 阻止了替换", actions: ["open-app-management", "open-download-page", "rm -rf"] });
  assert.deepEqual(failed.actions, ["open-app-management", "open-download-page"]);
  assert.deepEqual(appUpdate.normalizeState({ status: "available" }, failed).actions, [], "a new status clears them");
  assert.deepEqual(appUpdate.normalizeState({ percent: 40 }, failed).actions, failed.actions, "a progress push keeps them");
  assert.equal(appUpdate.ACTION_LABELS["open-app-management"], "打开系统设置");
  const calls = [];
  const store = appUpdate.createAppUpdateStore(() => ({
    check: async () => ({}),
    openAppManagement: async () => (calls.push("settings"), { status: "error", actions: ["open-app-management"] }),
  }));
  assert.equal(await store.runAction("open-app-management"), true);
  assert.equal(await store.runAction("open-download-page"), false, "missing bridge method: the page falls back to a link");
  assert.deepEqual(calls, ["settings"]);
  assert.equal(appUpdate.createAppUpdateStore(() => null).available(), false);
});

test("Agent 软件 polls only while the service says it is checking; autoCheck is kept", () => {
  const report = (extra) => ({ checkedAt: null, nextCheckAt: null, offline: false, checking: false, autoCheck: "on", agents: [], ...extra });
  assert.equal(versions.shouldPollVersions(report({ checking: true })), true);
  assert.equal(versions.shouldPollVersions(report({})), false, "never checked is not 'checking' (e.g. waiting for the notice)");
  assert.equal(versions.shouldPollVersions(report({ checking: true, offline: true })), false);
  assert.equal(versions.shouldPollVersions(null), false);
  assert.equal(versions.normalizeAgentVersions({ checking: true, autoCheck: "waiting-notice" }).autoCheck, "waiting-notice");
  assert.equal(versions.normalizeAgentVersions({ autoCheck: "sometimes" }).autoCheck, null);
});

test("需要注意: who can't see library skills, without the ones the user took out", () => {
  const data = library.normalizeLibrary({
    entries: [
      { name: "a", fanout: { claude: { tier: "link", state: "missing", reason: "没有链接到库" }, hermes: { tier: "config", state: "missing" } } },
      { name: "b", fanout: { claude: { tier: "link", state: "missing", skipped: true }, hermes: { tier: "config", state: "missing" } } },
      { name: "c", fanout: { claude: { tier: "link", state: "visible" }, raccoon: { tier: "none", state: "missing" } } },
    ],
    agents: [
      { agentId: "claude", name: "Claude Code", tier: "link", primary: true },
      { agentId: "hermes", name: "Hermes Agent", tier: "config", primary: true },
      { agentId: "raccoon", name: "办公小浣熊", tier: "none", primary: true },
    ],
    autoLink: { enabled: true, pending: { claude: 1 }, needsConfirmation: [{ agentId: "hermes", missing: 2 }] },
  });
  const issues = library.gapIssues(data, ["claude", "hermes", "raccoon"], (id) => ({ claude: "Claude Code", hermes: "Hermes Agent" })[id] || id);
  assert.deepEqual(
    issues.map((issue) => [issue.title, issue.names, issue.fix]),
    [
      ["Claude Code 看不到库里 1 个技能", ["a"], "catch-up"],
      ["Hermes Agent 看不到库里 2 个技能", ["a", "b"], "consent"],
    ],
  );
  assert.equal(issues[0].detail, "没有链接到库");
  assert.equal(library.KIND_LABELS.real, "真实文件夹");
  assert.equal(library.ITEM_KIND_LABELS.adopt, "放进技能库");
});
