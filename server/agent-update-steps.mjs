import path from "node:path";

/**
 * The allowlist of one-click Agent CLI updates: only commands verified in each tool's own
 * documentation. Everything else stays an AI prompt (remedies.mjs).
 */

/** <prefix>/lib/node_modules/<pkg> → <prefix> (npm's global folder layout on Unix). */
export function npmPrefixOf(packageRoot) {
  const marker = `${path.sep}lib${path.sep}node_modules${path.sep}`;
  const index = typeof packageRoot === "string" ? packageRoot.indexOf(marker) : -1;
  return index > 0 ? packageRoot.slice(0, index) : null;
}

/** npm packages whose official upgrade is `npm install -g <package>@latest` with the npm that owns the install. */
const NPM_ONE_CLICK = new Set(["@openai/codex", "@anthropic-ai/claude-code", "@google/gemini-cli", "@larksuite/cli"]);

/**
 * The verified update steps for an installed copy, or null (AI prompt only):
 * - npm global packages: `<that install's npm> install -g <pkg>@latest` (npm documents @latest
 *   for upgrades; Claude Code's docs say the same and warn against `npm update -g`);
 * - Claude Code native install: `claude update` (code.claude.com/docs/en/setup, "Update manually");
 * - OpenClaw: `openclaw update` (its docs, install/updating.md "Recommended: openclaw update").
 */
export function updateStepsFor(row, display = (value) => value) {
  const internal = row.internal || {};
  const pkg = row.feed?.package;
  if (row.agentId === "openclaw" && row.installed?.source === "npm" && internal.program) {
    return {
      steps: [{ program: internal.program, args: ["update"] }],
      effects: ["运行 OpenClaw 自带的更新命令 openclaw update（官方文档推荐的更新方式）", "它会检测安装方式、更新并自动运行 Doctor；正在运行的 Gateway 可能会被重启", "需要联网"],
    };
  }
  const prefix = npmPrefixOf(internal.packageRoot);
  if ((row.installed?.source === "npm" || row.installed?.source === "bundled") && NPM_ONE_CLICK.has(pkg) && internal.npmAbs && prefix) {
    return {
      // --prefix pins the global folder that owns this copy (an npmrc prefix cannot redirect it).
      steps: [{ program: internal.npmAbs, args: ["install", "-g", "--prefix", prefix, `${pkg}@latest`] }],
      effects: [
        `用 ${display(internal.npmAbs)} 把 ${pkg} 升级到最新版`,
        `安装位置：${row.installed.path}${internal.bundledWith ? `（${internal.bundledWith} 自带的这一份）` : ""}`,
        "只改这个 npm 全局目录里的这个包，不改配置和登录状态",
        "需要联网，可能要几分钟",
      ],
    };
  }
  if (row.agentId === "claude" && internal.native && internal.program) {
    return {
      steps: [{ program: internal.program, args: ["update"] }],
      effects: ["运行 Claude Code 自带的更新命令 claude update（官方文档的手动更新方式）", "新版本装到 ~/.local/share/claude/versions/，启动器指向新版本", "正在运行的会话不受影响，下次启动生效", "需要联网"],
    };
  }
  return null;
}
