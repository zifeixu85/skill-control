import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./helpers/load-ts.mjs";

const format = await loadTs("app/lib/format.ts");
const apiBase = await loadTs("app/lib/api-base.ts");
const chart = await loadTs("app/lib/chart.ts");
const highlight = await loadTs("app/lib/highlight.ts");
const frontmatter = await loadTs("app/lib/frontmatter.ts");
const tree = await loadTs("app/lib/file-tree.ts");
const navigation = await loadTs("app/lib/navigation.ts");
const plugins = await loadTs("app/lib/plugins.ts");
const agents = await loadTs("app/lib/agents.ts");

test("formatting: compact Chinese numbers, bytes, money and dates", () => {
  assert.equal(format.formatCompact(9_999), "9,999");
  assert.equal(format.formatCompact(26_900), "2.7 万");
  assert.equal(format.formatCompact(100_000), "10 万");
  assert.equal(format.formatCompact(10_560_000_000), "105.6 亿");
  assert.equal(format.formatBytes(512), "512 B");
  assert.equal(format.formatBytes(4_400), "4.3 KB");
  assert.equal(format.formatUsd(null), "—");
  assert.equal(format.formatUsd(0.004), "< $0.01");
  assert.equal(format.formatUsd(12.5), "$12.50");
  const now = Date.parse("2026-10-04T12:00:00Z");
  assert.equal(format.formatRelative("2026-10-04T11:59:40Z", now), "刚刚");
  assert.equal(format.formatRelative("2026-10-04T11:30:00Z", now), "30 分钟前");
  assert.equal(format.formatRelative("2026-10-01T12:00:00Z", now), "3 天前");
  assert.equal(format.formatRelative(null, now), "未知");
  assert.match(format.formatMonthDay("2025-03-05T12:00:00Z", now), /^2025年3月\d+日$/);
  assert.equal(format.shortTitle("ameng-ppt-design — 有设计主见的 HTML 演示生成器"), "ameng-ppt-design");
  assert.equal(format.baseName("~/.claude/skills/demo/"), "demo");
});

test("API base: desktop preload wins, env only in development, loopback only", () => {
  assert.equal(apiBase.resolveApiBase({ development: true }), apiBase.DEFAULT_API_BASE);
  assert.equal(
    apiBase.resolveApiBase({ desktopBase: "http://127.0.0.1:50123", envBase: "http://127.0.0.1:43119", development: true }),
    "http://127.0.0.1:50123",
  );
  assert.equal(apiBase.resolveApiBase({ envBase: "http://127.0.0.1:43119", development: true }), "http://127.0.0.1:43119");
  assert.equal(apiBase.resolveApiBase({ envBase: "http://127.0.0.1:43119", development: false }), apiBase.DEFAULT_API_BASE);
  assert.equal(apiBase.loopbackOrigin("http://evil.example:43119"), null);
  assert.equal(apiBase.loopbackOrigin("https://127.0.0.1:43119"), null);
  assert.equal(apiBase.loopbackOrigin("http://user:pw@127.0.0.1:43119"), null);
  assert.equal(apiBase.loopbackOrigin("http://127.0.0.1:43119/api"), null);
  assert.equal(apiBase.loopbackOrigin("http://localhost:43119/"), "http://localhost:43119");
});

test("charts are drawn to scale from zero with clean ticks", () => {
  assert.equal(chart.niceMax(0), 1);
  assert.equal(chart.niceMax(7), 10);
  assert.equal(chart.niceMax(43), 50);
  assert.equal(chart.niceMax(180), 200);
  assert.deepEqual(chart.ticks(1, 2), [0, 1]);
  assert.deepEqual(chart.ticks(2, 2), [0, 1, 2]);
  assert.deepEqual(chart.ticks(100, 2), [0, 50, 100]);
  const box = { width: 110, height: 60, top: 5, right: 5, bottom: 5, left: 5 };
  const points = chart.plotPoints([0, 5, 10], box, 10);
  assert.deepEqual(points.map((point) => [point.x, point.y]), [[5, 55], [55, 30], [105, 5]]);
  assert.equal(chart.linePath(points), "M5 55 L55 30 L105 5");
  assert.equal(chart.areaPath(points, 55), "M5 55 L55 30 L105 5 L105 55 L5 55 Z");
  const bars = chart.barRects([0, 10], box, 10, 0.5);
  assert.equal(bars[1].height, 50);
  assert.equal(bars[0].height, 0);
});

test("highlighting tokenizes keys, strings and masked values without HTML", () => {
  const toml = highlight.tokenize('[mcp_servers.x]\nAuthorization = "••••••"\n# note', "toml");
  assert.equal(toml[0][0].kind, "heading");
  assert.deepEqual(toml[1].map((token) => token.kind), ["key", "plain", "string", "mask", "string"]);
  assert.equal(toml[2][0].kind, "comment");
  const json = highlight.tokenize('  "token": "<b>••••••</b>"', "json");
  assert.equal(json[0][1].kind, "key");
  assert.ok(json[0].some((token) => token.kind === "mask"));
  assert.ok(json[0].some((token) => token.text.includes("<b>")), "markup stays literal text");
  const yaml = highlight.tokenize("name: demo\n- item: 1", "yaml");
  assert.equal(yaml[0][0].kind, "key");
  assert.equal(yaml[1][1].kind, "key");
  const md = highlight.tokenize("---\nname: x\n---\n# Title", "md");
  assert.equal(md[1][0].kind, "key");
  assert.equal(md[3][0].kind, "heading");
  assert.equal(highlight.normalizeLanguage(null, "plugin.yaml"), "yaml");
  assert.equal(highlight.normalizeLanguage("markdown"), "md");
  assert.ok(highlight.containsMask("a ••••••"));
});

test("frontmatter: every key in order, nested values as YAML, invalid YAML reported", () => {
  const { frontmatter: head, body } = frontmatter.splitFrontmatter(
    "---\nname: demo\ndescription: Does things\nmetadata:\n  short: x\n  tags: [a, b]\nversion: 2\n---\n# Body\n",
  );
  assert.equal(body, "# Body\n");
  const rows = frontmatter.frontmatterRows(head);
  assert.deepEqual(rows.map((row) => row.key), ["name", "description", "metadata", "version"]);
  assert.equal(rows[2].nested, true);
  assert.match(rows[2].value, /short: x/);
  assert.equal(rows[3].value, "2");
  assert.equal(frontmatter.frontmatterRows("name: [unclosed"), null);
  assert.deepEqual(frontmatter.frontmatterRows(null), []);
  assert.equal(frontmatter.splitFrontmatter("# No header").frontmatter, null);
});

test("file tree nests paths, puts SKILL.md first and resolves relative links safely", () => {
  const entry = (path, type = "file") => ({ path, name: path.split("/").pop(), type, size: 1, modifiedAt: "", language: null, linkTarget: null });
  const nodes = tree.buildFileTree([entry("scripts/run.py"), entry("README.md"), entry("SKILL.md"), entry("assets", "directory"), entry("assets/logo.png")]);
  assert.deepEqual(nodes.map((node) => node.name), ["SKILL.md", "README.md", "assets", "scripts"]);
  assert.equal(nodes[3].children[0].path, "scripts/run.py");
  assert.equal(tree.defaultFilePath([entry("docs/a.md"), entry("SKILL.md")]), "SKILL.md");
  assert.equal(tree.defaultFilePath([entry("b.txt"), entry("docs/a.md")]), "docs/a.md");
  assert.equal(tree.resolveRelativePath("docs/guide.md", "../assets/logo.png"), "assets/logo.png");
  assert.equal(tree.resolveRelativePath("SKILL.md", "./assets/a%20b.png"), "assets/a b.png");
  assert.equal(tree.resolveRelativePath("SKILL.md", "../../etc/passwd"), null);
  assert.equal(tree.resolveRelativePath("SKILL.md", "https://example.com/x.png"), null);
  assert.equal(tree.resolveRelativePath("SKILL.md", "#heading"), null);
  assert.deepEqual(tree.ancestorPaths("a/b/c.md"), ["a", "a/b"]);
});

test("navigation routes round-trip and reject unknown pages", () => {
  assert.deepEqual(navigation.parseRoute("agent:codex"), { page: "agent", agentId: "codex" });
  assert.deepEqual(navigation.parseRoute("nope"), { page: "home", agentId: null });
  assert.deepEqual(navigation.parseRoute("agent:../x"), { page: "home", agentId: null });
  assert.equal(navigation.serializeRoute({ page: "usage", agentId: null }), "usage");
  assert.ok(navigation.isValidRoute("health"));
  assert.ok(!navigation.isValidRoute("agent:"));
});

test("plugins merge per Agent and name, preferring the enabled variant", () => {
  const base = { components: { skills: [], mcpServers: [], apps: [], hooks: false }, scope: "user", source: "claude-plugins" };
  const merged = plugins.mergePlugins([
    { ...base, key: "1", agentId: "claude", name: "docs", displayName: "Docs", enabled: "unknown", scope: "local" },
    { ...base, key: "2", agentId: "claude", name: "docs", displayName: "Docs", enabled: true },
    { ...base, key: "3", agentId: "codex", name: "docs", displayName: "Docs", enabled: false },
    { ...base, key: "4", agentId: "workbuddy", name: "expert", displayName: "Expert", enabled: true, kind: "expert" },
  ]);
  assert.equal(merged.length, 2);
  const claude = merged.find((plugin) => plugin.agentId === "claude");
  assert.equal(claude.key, "2");
  assert.equal(claude.variants, 1);
  assert.equal(plugins.pluginState(claude).label, "已启用");
  assert.equal(plugins.pluginState({ ...claude, enabled: "unknown", source: "codex-plugin-cache" }).label, "只在缓存里");
  assert.equal(plugins.pluginDetailId(claude), `claude:${claude.id}`);
});

test("agent meta: brand names, readable ink and theme-safe tints", () => {
  assert.equal(agents.agentMeta("smartorder").letter, "订");
  assert.equal(agents.agentMeta("unknown-agent", { name: "My Agent", color: "#123456" }).name, "My Agent");
  assert.equal(agents.inkOn("#ffffff"), "#1d1d1f");
  assert.equal(agents.inkOn("#1d1d1f"), "#ffffff");
  assert.equal(agents.tintFor("#1d1d1f"), "var(--ink)");
  assert.equal(agents.tintFor("#d97757"), "#d97757");
  assert.equal(
    agents.activityReason({ status: "ok", basis: "bytes", files30d: 12, tokens30d: 0, activeDays30d: 5 }, true),
    "近 30 天 12 个会话 · 推荐",
  );
  assert.equal(agents.activityReason(undefined, false), "近 30 天没有记录");
});
