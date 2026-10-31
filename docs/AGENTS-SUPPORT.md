# 支持的 Agent / Supported Agents

[中文](#中文) · [English](#english)

## 中文

Skill Control 只把本机检测到的 Agent 当作数据源。是否安装，看的是产品自己的文件、命令或应用，不看技能目录：技能目录可能是别的工具建的，技能库 `~/.agents/skills` 也不属于任何一个 Agent。下表的“产品主目录”只有在里面除了 `skills` 还有别的内容时才算数。检测到的 Agent 默认都会显示，可以在“设置 → 读取哪些 Agent 的技能”里调整。

| Agent | 怎么判断已安装 | 默认技能目录 | 接入技能库的方式 | 用量统计 |
| --- | --- | --- | --- | --- |
| Codex | `~/.codex/config.toml`、`~/.codex/sessions`、`~/.codex/auth.json` 或 `~/.codex/history.jsonl`；`codex` 命令；Codex.app | `~/.codex/skills`、`~/.agents/skills`、`~/.codex/vendor_imports/skills` | 会自动读取 | 有 |
| Claude Code | `~/.claude/settings.json`、`~/.claude/projects`、`~/.claude.json`、`~/.claude/local/claude` 或 `~/.local/bin/claude`；`claude` 命令 | `~/.claude/skills` | 需要逐个接入 | 有 |
| WorkBuddy | `~/.workbuddy`；应用 | `~/.workbuddy/skills`、`~/.workbuddy/connectors/skills` | 需要逐个接入 | 有 |
| Hermes Agent | Hermes 主目录；`hermes` 命令；应用 | `~/.hermes/skills`（按 Hermes 的规则，含 Profile 和额外目录） | 通过额外目录读取 | 有 |
| OpenClaw | `~/.openclaw`、`~/.clawdbot` 或 `~/.moltbot`；`openclaw` 命令 | `~/.openclaw/skills`，以及 OpenClaw 自己的其他技能来源 | 会自动读取 | 有 |
| QClaw | `~/.qclaw/qclaw.json`；应用 | `~/.qclaw/skills`（由 QClaw 同步管理，Skill Control 不往里装） | 会自动读取 | 有 |
| 办公小浣熊 | 应用数据里的 `settings.json` 或 `~/.box-agent/config`；应用 | `~/.box-agent/skills` | 需要复制一份 | 有 |
| Cursor | `~/.cursor`；`cursor-agent` 命令；应用 | `~/.cursor/skills` | 会自动读取 | — |
| Gemini CLI | `~/.gemini`；`gemini` 命令 | `~/.gemini/skills` | 会自动读取 | — |
| GitHub Copilot | `~/.copilot`；`copilot` 命令 | `~/.copilot/skills`、`~/.github/copilot/skills` | 会自动读取 | — |
| OpenCode | `~/.config/opencode` 或 `~/.local/share/opencode`；`opencode` 命令 | `~/.config/opencode/skills`、`~/.opencode/skills` | 会自动读取 | — |
| Windsurf | `~/.windsurf` 或 `~/.codeium/windsurf`；应用 | `~/.windsurf/skills` | 会自动读取 | — |
| Kiro | `~/.kiro`；`kiro-cli` 命令；应用 | `~/.kiro/skills` | 需要逐个接入 | — |
| Trae | `~/.trae` 或 `~/.trae-cn`；应用 | `~/.trae/skills` | 需要逐个接入 | — |
| CodeBuddy | `~/.codebuddy`；`codebuddy` 命令 | `~/.codebuddy/skills` | 需要逐个接入 | — |
| Cline | `~/.cline`；`cline` 命令；VS Code 扩展 | `~/.cline/skills` | 暂不读取技能库 | — |
| Roo Code | `~/.roo` 或 `~/.roo-code`；VS Code 扩展 | `~/.roo/skills`、`~/.roo-code/skills` | 暂不读取技能库 | — |
| Qwen Code | `~/.qwen` 或 `~/.qwen-code`；`qwen` 命令 | `~/.qwen/skills`、`~/.qwen-code/skills` | 暂不读取技能库 | — |
| 订单来了（SmartOrder） | `~/.smartorder/config.toml`；应用 | `~/.smartorder/skills`，以及已启用插件的技能目录 | 暂不读取技能库 | — |

“应用”指 `/Applications` 或 `~/Applications` 里的 `.app`，只在 macOS 上识别。

### 接入方式

- **会自动读取**：Agent 自己就读 `~/.agents/skills`，放进库就能看到，不用改动。Codex 不合并同名技能：它自己目录里另有同名副本时，会出现两次，可以用技能库页的“一键整理”去重。
- **需要逐个接入**：在 Agent 自己的技能目录里，为每个技能建一个指向技能库的相对链接。自动接入和“补齐接入”做的就是这件事。
- **通过额外目录读取**：在 Hermes 的 `config.yaml` 里把技能库加进 `skills.external_dirs`，只需一次。需要你确认，改之前备份。Hermes 本地有同名技能时，本地的优先。
- **需要复制一份**：办公小浣熊只读取 `~/.box-agent/skills` 下的真实文件夹，不跟随链接，所以每个技能复制一份，并记下来源。库里的技能更新后，这份副本暂时不会自动重新复制，界面会显示它和库里不同。

Windows 上建链接时依次尝试符号链接和目录联接，都不行时复制一份。

### 没有出现在列表里的 Agent

“概览”和“设置”里的“发现新 Agent”会找出含 `skills/*/SKILL.md`、但不属于已知 Agent 的目录（每天最多扫描一次），可以“添加为自定义 Agent”或忽略。想让 Skill Control 正式支持一个新的 Agent，欢迎提交 Issue 或 PR，规则见[架构说明](./ARCHITECTURE.md#增加-agent-目录规则)。

LumiClaw、MotiClaw 和 Clawith 管理或编排 Agent，本身不是 Agent。Skill Control 只读显示它们是否安装、版本和目录数量，不读取它们的配置。

### 订单来了：技能与连接器

自动检测当前用户目录下的 `.smartorder`，Windows 和 Mac 使用相同的相对目录规则。可以查看本地技能、内置技能和已启用插件里的技能；遵循 `skills.config` 的停用项，市场清单、未登记的缓存和历史版本不会混进已安装列表。插件和系统内置技能只读，不能通过普通安装或同步覆盖。连接器只显示配置摘要，不访问远程服务、不执行连接器命令，也不显示凭据、环境变量的值、启动参数或 URL 的路径和查询部分。

---

## English

Skill Control only uses agents it detects on your computer. Whether an agent is installed is decided from the product's own files, commands or apps, never from skill folders: other tools create those, and the library `~/.agents/skills` belongs to no agent. A product home folder counts only when it holds something besides `skills`. Detected agents are shown by default; change this in 设置 → 读取哪些 Agent 的技能 (Settings → which agents' skills to read).

| Agent | Detected from | Default skill folders | How it reads the library | Usage stats |
| --- | --- | --- | --- | --- |
| Codex | `~/.codex/config.toml`, `~/.codex/sessions`, `~/.codex/auth.json` or `~/.codex/history.jsonl`; `codex` command; Codex.app | `~/.codex/skills`, `~/.agents/skills`, `~/.codex/vendor_imports/skills` | Natively | Yes |
| Claude Code | `~/.claude/settings.json`, `~/.claude/projects`, `~/.claude.json`, `~/.claude/local/claude` or `~/.local/bin/claude`; `claude` command | `~/.claude/skills` | A link per skill | Yes |
| WorkBuddy | `~/.workbuddy`; app | `~/.workbuddy/skills`, `~/.workbuddy/connectors/skills` | A link per skill | Yes |
| Hermes Agent | Hermes home folder; `hermes` command; app | `~/.hermes/skills` (per Hermes' rules, with profiles and extra directories) | Extra directory | Yes |
| OpenClaw | `~/.openclaw`, `~/.clawdbot` or `~/.moltbot`; `openclaw` command | `~/.openclaw/skills` and OpenClaw's other skill sources | Natively | Yes |
| QClaw | `~/.qclaw/qclaw.json`; app | `~/.qclaw/skills` (managed by QClaw's own sync; Skill Control does not install into it) | Natively | Yes |
| Office Raccoon (办公小浣熊) | `settings.json` in its app data, or `~/.box-agent/config`; app | `~/.box-agent/skills` | A copy | Yes |
| Cursor | `~/.cursor`; `cursor-agent` command; app | `~/.cursor/skills` | Natively | — |
| Gemini CLI | `~/.gemini`; `gemini` command | `~/.gemini/skills` | Natively | — |
| GitHub Copilot | `~/.copilot`; `copilot` command | `~/.copilot/skills`, `~/.github/copilot/skills` | Natively | — |
| OpenCode | `~/.config/opencode` or `~/.local/share/opencode`; `opencode` command | `~/.config/opencode/skills`, `~/.opencode/skills` | Natively | — |
| Windsurf | `~/.windsurf` or `~/.codeium/windsurf`; app | `~/.windsurf/skills` | Natively | — |
| Kiro | `~/.kiro`; `kiro-cli` command; app | `~/.kiro/skills` | A link per skill | — |
| Trae | `~/.trae` or `~/.trae-cn`; app | `~/.trae/skills` | A link per skill | — |
| CodeBuddy | `~/.codebuddy`; `codebuddy` command | `~/.codebuddy/skills` | A link per skill | — |
| Cline | `~/.cline`; `cline` command; VS Code extension | `~/.cline/skills` | Not yet | — |
| Roo Code | `~/.roo` or `~/.roo-code`; VS Code extension | `~/.roo/skills`, `~/.roo-code/skills` | Not yet | — |
| Qwen Code | `~/.qwen` or `~/.qwen-code`; `qwen` command | `~/.qwen/skills`, `~/.qwen-code/skills` | Not yet | — |
| SmartOrder (订单来了) | `~/.smartorder/config.toml`; app | `~/.smartorder/skills` and the skill folders of enabled plugins | Not yet | — |

"App" means a `.app` in `/Applications` or `~/Applications`, detected on macOS only.

**How agents read the library**

- **Natively**: the agent reads `~/.agents/skills` itself; nothing to do. Codex does not merge skills with the same name: a copy in its own folder shows up twice, which 一键整理 (tidy up) on the library page can remove.
- **A link per skill**: one relative link per skill in the agent's own skills folder, pointing to the library. This is what auto-link and catch-up create.
- **Extra directory**: the library is added once to `skills.external_dirs` in Hermes' `config.yaml`, with your confirmation and a backup. A local Hermes skill with the same name wins.
- **A copy**: Office Raccoon loads only real folders in `~/.box-agent/skills` and skips links, so each skill is copied and its source recorded. When the library copy changes, this copy is not re-copied automatically yet; the app shows it as different from the library.

On Windows, links are tried as a symbolic link, then a directory junction, then a copy.

**Agents that are not listed**: 发现新 Agent (new agent found) on the overview and in Settings looks for folders with `skills/*/SKILL.md` that belong to no known agent (at most once a day); you can add one as a custom agent or ignore it. To add proper support for a new agent, open an Issue or a PR; the rules are in the [architecture notes](./ARCHITECTURE.md#增加-agent-目录规则).

LumiClaw, MotiClaw and Clawith manage or orchestrate agents and are not agents themselves. Skill Control shows only whether they are installed, their version and folder counts, and never reads their configuration.

**SmartOrder skills and connectors**: local, built-in and explicitly enabled plugin skills are listed; disabled skills and marketplace or history caches are left out, and plugin and system skills are read-only. Connectors show configuration summaries only, without running commands or contacting services; credentials, environment values, command arguments and URL paths or query strings are omitted.
