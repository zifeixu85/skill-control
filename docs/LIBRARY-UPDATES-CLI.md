# 统一技能库、更新检测与 CLI 工具 / Library, Updates and CLI Tools

状态：第 1–3 节已实现（接口与实现细节见 `docs/ARCHITECTURE.md`“更新检测与执行”“统一技能库与 CLI 工具卡片”）。未实现：WorkBuddy `skillOverrides` 与 Trae `disabledSkills` 停用开关（格式未核实，只给指引）、含注释的 OpenClaw 配置自动编辑、项目级 `skills-lock.json` 扫描。日期：2026-10-04。依据：本机只读实测 + 官方文档 + 9 个同类工具源码调研（vercel-labs/skills、cc-switch、xingkongliang/skills-manager、runkids/skillshare、qufei1993/skills-hub、HarnessKit、getsentry/dotagents、openskills、skillport）。

## 1. 统一技能库

### 1.1 位置

- 库根目录 = `realpath(~/.agents/skills)`。这是 agentskills.io 与 `npx skills` 的事实标准目录，Codex、OpenClaw/QClaw 原生读取，WorkBuddy 沙箱白名单预置了它。
- Skill Control 的元数据只写 `~/.agent-skill-manager/library-lock.json`，不往技能目录写任何标记文件。
- `~/.agents/.skill-lock.json`（vercel `skills` v3）只读，用于导入来源，不改写，不与它抢锁。
- 所有者检测做成通用能力：库根或技能是软链时记录 `owner`（realpath 前缀、锁文件来源、应用包是否仍存在）；被其他管理器托管时只提示，不替换对方的链接。
- 库内条目必须是实体目录。OpenClaw 2026.4.x 拒绝 realpath 越出根目录的软链（本机 16 个因此在 QClaw 中被隐藏）。

### 1.2 分发档位（只对用户选中的常用 Agent）

| 档位 | Agent | 动作 |
|---|---|---|
| A 原生读取 | Codex、Gemini CLI、Cursor、Copilot CLI、VS Code Copilot、OpenCode、Amp、Windsurf（源码或更新日志已核对）；OpenClaw、QClaw | 不建链；清理该 Agent 自己目录里的同名副本。Codex 不合并同名技能，两份都会出现（按路径去重），且 `~/.codex/skills` 已被官方标为过时 |
| B 配置额外目录 | Hermes（`skills.external_dirs`）；Copilot CLI 另有 `skillDirectories`、OpenCode 有 `skills.paths`、VS Code 有 `chat.agentSkillsLocations`（这些 Agent 已原生读取，通常不需要） | 优先经产品 CLI 写配置（`hermes config set`），写前展示 diff 并备份；清理 `~/.hermes/skills` 中同名不同内容的副本（否则 Hermes 报 Ambiguous skill name） |
| C 逐技能软链 | Claude Code、Kiro、CodeBuddy、WorkBuddy、Trae（全局目录） | `<agent>/skills/<name> → ~/.agents/skills/<name>`，优先相对路径。只链目录，不要单独链接 `SKILL.md` 文件（Codex 会忽略）；避免链接成环（OpenCode 会卡死） |
| D 复制兜底 | Windows 无链接权限、可见性验证失败 | Windows 依次尝试 symlink → junction → 复制；复制记录 `sourceHash`，库更新后重新复制，界面标“副本” |

分发后做可见性体检：按每个 Agent 的真实规则（是否跟随软链、是否做根目录包含检查、同名优先级、停用开关）逐技能给出“可见 / 被隐藏（原因）/ 重复”。

### 1.3 替换规则（按磁盘实况，不按记录）

写入目标前用 `lstat` 分类：`absent`、`link-to-library`、`foreign-link`、`real-dir`、`real-file`。

- `absent` / `link-to-library`：可直接写。
- `real-dir` / `foreign-link` / `real-file`：必须进入“收编”或冲突流程，绝不静默 `rm -rf`（vercel `skills` 会这样做，是要避开的坑）。

### 1.4 收编（已装在某个 Agent 里的技能纳入库）

1. 识别：realpath、frontmatter `name`、内容哈希（忽略 `.DS_Store`）、关联锁文件来源。
2. 备份：`~/.agent-skill-manager/backups/<时间>/<agent>/<name>`。
3. 迁入：move 到 `~/.agents/skills/<name>`（跨卷则复制 + 校验）。
4. 回链：按 1.2 的档位处理原位置。
5. 复验：可见性体检失败则自动回滚。

冲突：realpath 相同不算冲突；同名同哈希合并；同名不同哈希并排 diff，由用户选“保留库版本 / 采用此版本 / 另存为 `<name>@<agent>`”。外部仓库托管的技能包（如 gstack）不搬动，标 `external-managed`。

### 1.5 停用与卸载

- 对单个 Agent 停用：写该 Agent 原生开关（Codex `[[skills.config]] enabled=false`；OpenClaw/QClaw `skills.entries.<name>.enabled=false`；Hermes `skills.disabled`；WorkBuddy `skillOverrides`；Trae `disabledSkills`）；没有开关的删链。
- 原生读取的 Agent 只能靠开关停用，界面要说明“进库 = 默认对 Codex/QClaw 可见”。
- 只给某个 Agent 用的技能不进库。
- 卸载：先撤链接和配置项，再把库条目移到 `~/.agent-skill-manager/trash/`，可恢复。

### 1.6 `library-lock.json`

每条：`source`、`sourceType`（github / well-known / local / adopted …）、`sourceUrl`、`skillPath`、`ref`、`commit`、`upstreamHash`（与 vercel `skillFolderHash` 同为 git tree SHA）、`contentHash`（本地 sha256）、`adoptedFrom`、`fanout{agentId:{mode,path,verifiedAt}}`、`installedAt`、`updatedAt`。键排序，便于对比。

## 2. 更新检测

### 2.1 来源解析（`server/provenance.mjs`）

判定优先级：宿主托管目录（system/builtin/plugin cache）→ 显式锁或元数据（`.skill-lock.json`、`skills-lock.json`、`.clawhub/origin.json`、`_skillhub_meta.json`、`_meta.json`、`.hub/lock.json`、`.bundled_manifest`）→ 插件注册表（Claude `installed_plugins.json`、Codex `[marketplaces.*]`、WorkBuddy）→ 技能目录内的 `.git` → frontmatter 中的 github 链接（只作“可能来源”，用户确认后才绑定）→ unknown。`metadata.upstream` 是致谢列表，不是来源。

去重：先按 realpath 合并，再按 `(sourceKey, path)` 聚合成“更新单元”，同一来源的多份副本只检查、下载一次。

### 2.2 来源矩阵

| sourceType | 已装标识 | 查最新 | 执行更新 |
|---|---|---|---|
| skills-cli（github） | git tree SHA（`skillFolderHash`） | `git ls-remote` 拿 HEAD，变了才调一次 trees API | Skill Control 自己下载、重算 tree SHA 校验、走计划 → 备份 → 替换，再原子回写锁（写前备份） |
| skills-cli（well-known）/ lark-cli | CLI 版本 + 内容哈希 | npm `@larksuite/cli/latest`；well-known `index.json` 技能名差集 | `lark-cli update --json` |
| Claude 插件 | version / gitCommitSha | raw 读远端 `marketplace.json` → `plugin.json`；无 version 用 ls-remote | `claude plugin marketplace update` + `claude plugin update --json`（需重启） |
| Codex 插件 | 版本目录 / `last_revision` | ls-remote 对比；远端插件读 catalog `release.version` | `codex plugin marketplace upgrade <mk> --json` |
| WorkBuddy 市场 | version / etag | zip `HEAD` + If-None-Match | 交给 WorkBuddy 的 autoUpdate，只提示 |
| WorkBuddy SkillHub | version + installedContentHash | `api.skillhub.cn/api/v1/skills/{slug}` | 引导到 WorkBuddy 内更新 |
| Hermes hub / bundled | content_hash / md5 | `hermes skills check`（成本高，按需） | `hermes skills update` / `hermes update` |
| ClawHub | installedVersion | `clawhub.ai/api/v1/skills/{slug}` | 自己下载并写回 origin/lock |
| QClaw remote | 整数版本 + sha256 | 无公开接口 | 只读，标“由 QClaw 管理” |
| git | HEAD | `git ls-remote` | 工作区干净时 `git pull --ff-only`；gstack 交给 `/gstack-upgrade` |
| unknown | — | — | 只做本地修改检测 |

### 2.3 三方判定

本地实际内容 ↔ 锁里的基线 ↔ 上游最新。哈希必须用该来源自己的算法（git tree SHA、sha256 目录、Hermes 截断 sha256）。没有基线的来源，首次扫描时由 Skill Control 记快照作为基线。

| 条件 | 状态 |
|---|---|
| 本地 = 上游 | up-to-date（锁落后时提示可修正） |
| 本地 = 基线 ≠ 上游 | update-available |
| 本地 ≠ 基线 = 上游 | locally-modified |
| 三者互不相同 | update-available + locally-modified（冲突） |

另有 `managed-by-host`、`unknown-source`、`check-failed`。

### 2.4 规则与限制

- 检查阶段绝不调用 `npx skills check`（它就是 `update`，没有 dry-run）；调用任何 npx 时设 `DO_NOT_TRACK=1 DISABLE_TELEMETRY=1`。
- 绝不跨市场回退：同一 slug 在 clawhub.ai 与 skillhub.cn 是不同的东西。
- GitHub：未登录 60 次/小时，ETag 条件请求照样扣配额；先 ls-remote，配置文件走 raw.githubusercontent.com；可选在用户授权后临时读取 `gh auth token`（不落盘、不写日志）。
- 调度：手动“检查更新” + 后台每天最多一次；遵守 `x-ratelimit-reset` 退避；离线显示上次结果。
- 隐私：只发送仓库名或 slug；会访问的主机在界面列出（api.github.com、github.com、raw.githubusercontent.com、registry.npmjs.org、open.feishu.cn、clawhub.ai、api.skillhub.cn，可选 download.codebuddy.cn）。
- 更新执行：能委托就委托给宿主 CLI；所有外部命令用参数数组、限时、记录退出码，执行前展示命令与影响，需要用户确认。冲突默认不覆盖，提供“保留本地 / 覆盖（先备份）/ 另存为”。

## 3. CLI 工具卡片（以 lark-cli 为例）

### 3.1 检测项

- 每个二进制的位置与版本；同名多份时标出版本差（本机 Hermes 网关使用 `~/.hermes/node/bin/lark-cli` 1.0.56，终端使用 nvm 下的 1.0.66）。
- 最新版本（npm）。
- 每个 Agent 实际能找到哪一份：Codex / Claude Code / WorkBuddy 读各自的 shell snapshot；Hermes 网关读 `~/Library/LaunchAgents/ai.hermes.gateway.plist` 里固定的 PATH；`launchctl getenv PATH` 为空表示 GUI 默认只有系统目录。
- 工作区与登录：lark-cli 检测到 `HERMES_HOME` 或 `OPENCLAW_*` 时改用 `~/.lark-cli/hermes`、`~/.lark-cli/openclaw`，各自需要单独绑定（`lark-cli config bind --source hermes|openclaw`，默认机器人身份）。只显示“已配置 / 身份类型 / 过期时间”，不显示任何密钥。
- 钥匙串可达性：没有 `master.key.file` 时，沙箱内（如 Codex workspace-write）读不到凭据，提示 `lark-cli config keychain-downgrade`。
- 技能：是否已进库、版本是否与 CLI 一致。
- 放行规则：Claude Code `Bash(lark-cli *)`；Codex `~/.codex/rules/*.rules` 的 `prefix_rule(pattern=["lark-cli"], decision="allow")`（会在沙箱外运行）；Gemini `run_shell_command(lark-cli)`；Cursor CLI `Shell(lark-cli)`；OpenCode `permission.bash`；OpenClaw exec approvals；Hermes `command_allowlist`（普通命令多半无需规则）。
- Codex 默认沙箱断网：`[sandbox_workspace_write] network_access = true` 或放行规则。

### 3.2 一键修复（都要先展示改动再确认）

1. 在 `~/.local/bin/lark-cli` 生成稳定启动脚本：`#!/bin/sh` + `exec "<原生二进制绝对路径>" "$@"`（指向 Go 原生程序而不是 `run.js`，不依赖 node）；nvm 版本变化时重新生成。保持命令名 `lark-cli`，放行规则才能匹配。
2. 给各 Agent 补放行规则（写前展示 diff 并备份）。
3. 安装或更新 CLI 配套技能进库。
4. Hermes 网关 PATH 修复：提示在 plist 中把 `~/.local/bin` 提前，或用 `hermes` 自己的命令重装网关。
5. Hermes / OpenClaw 工作区绑定引导。

## 4. 实施顺序

1. 来源解析 + 只读的更新检查 + 三方判定 + 体检集成。
2. 更新执行：skills-cli GitHub 条目由 Skill Control 自行更新；其余委托宿主 CLI。
3. 技能库：所有者检测、可见性体检、收编与分发、停用与卸载。
4. CLI 工具卡片：检测 → 启动脚本 → 放行规则 → 工作区绑定引导。
