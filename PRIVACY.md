# 隐私说明 / Privacy Notice

最后更新：2026-11-xx（适用于 v0.3.0）

Last updated: 2026-11-xx (applies to v0.3.0)

[中文](#中文) · [English](#english)

## 中文

Skill Control 在你的电脑上读取各 Agent 的文件，并在本机整理和统计。本说明列出它会读哪些位置、保存什么、什么时候改动其他 Agent 的文件夹、什么时候联网，以及怎样删除它的数据。

### 不收集什么

- 没有遥测、行为分析、崩溃上报或广告 SDK。
- 没有用户账户，也没有由项目维护者运营的服务器。
- 不上传技能内容、对话内容、密钥、文件路径或设备标识。

界面和本地服务之间只通过本机回环地址（`127.0.0.1`）通信，不对局域网或外网开放。界面本身不加载任何外部资源。

### 本机会读取的位置

“保存”指写进 Skill Control 自己数据目录的内容。数据目录是 `~/.agent-skill-manager/`（Windows 为 `%USERPROFILE%\.agent-skill-manager`），下表只写文件名。

| 读取的位置 | 用来做什么 | 保存什么 | 存在哪里 |
| --- | --- | --- | --- |
| 各 Agent 的技能目录（如 `~/.claude/skills`、`~/.codex/skills`）和技能库 `~/.agents/skills` | 列出技能、预览文件、判断各 Agent 能否看到某个技能、比较版本 | 路径、文件大小和修改时间、内容指纹；不复制技能内容 | `fingerprint-cache.json`、`library-lock.json` |
| 会话记录：`~/.claude/projects`、`~/.codex/sessions`、`~/.codex/archived_sessions`、`~/.workbuddy/projects`、OpenClaw / QClaw 的 `agents/*/sessions`；会话数据库：Codex 的 `~/.codex/state_*.sqlite`、Hermes 的 `state.db`、WorkBuddy 的 `workbuddy.db`、办公小浣熊的 `local-chat.sqlite3`；Hermes 的 `skills/.usage.json`、WorkBuddy 的 `usage-log.json` | “数据”页和概览：会话数、Token、技能使用次数、预估费用；按最近 30 天的会话推荐常用 Agent | 会读取会话记录文件来统计次数和 Token，只保存数字，不保存、不上传对话内容。保存的是：次数、Token 数、技能名、模型名、日期、项目文件夹名（只取文件夹名，不含完整路径），以及用来去重的短哈希。数据库以只读方式打开 | `usage-index.json` |
| Agent 配置与凭据文件：各 Agent 的 MCP 配置、`~/.claude/settings.json`、`~/.claude.json`、Gemini / WorkBuddy / Hermes 的 `.env` 和设置文件、OpenClaw / QClaw / 办公小浣熊的配置；`~/.npmrc`、`~/.netrc`、`~/.aws/credentials`、`~/.config/gh/hosts.yml`、`~/.docker/config.json`、`~/.lark-cli/config.json`；技能目录里的 `.env*` 文件 | “连接器与 MCP → 密钥”：哪些服务的密钥存在哪里、谁在用、有没有变化。只在打开这一页时读取 | 不显示、不保存密钥的值，只在本机保存一个加盐指纹，用来判断是否变化（只对 16 个字符以上的值计算；技能目录里的 `.env*` 只记键名，不算指纹）。保存键名、位置、指纹、首次看到和变化的时间；盐是本机随机生成的 | `secret-snapshot.json`、`secret-salt` |
| 各 Agent 的指令、记忆和规则文件（如 `CLAUDE.md`、`AGENTS.md`、memory 文件）、配置详情、插件、MCP 服务、专家与 Profile；WorkBuddy 数据库里的专家使用次数（只查专家 id、次数和时间） | 在对应页面里展示 | 不保存。显示前，像密钥的字段会打码 | — |
| 已安装的应用（`/Applications`、`~/Applications` 里的 `Info.plist`）、命令所在的目录（PATH、`~/.local/bin`、nvm、Homebrew 等）、各 Agent 的终端环境记录（shell snapshot）和 Hermes 的 launchd 配置 | 判断 Agent 是否安装、读取版本号、“命令行工具”卡片和体检 | 版本号、命令名和路径。只读文件，不运行这些程序；macOS 上把应用图标转成 PNG 缓存 | `agent-versions.json`、`cli-skill-mentions.json`、`icons/` |
| 新 Agent 发现：用户目录下的隐藏文件夹（跳过 `.ssh`、`.gnupg`、`.docker`、缓存和工具链目录）、`~/Library/Application Support` 里与已安装应用同名或名字像 Agent 的文件夹、`~/.local/bin` | 找出含 `skills/*/SKILL.md` 但不属于已知 Agent 的目录，提示你“添加为自定义 Agent” | 候选目录的路径、名称和技能数 | `discovery.json` |
| `~/.agents/.skill-lock.json`、技能里的来源记录（`_skillhub_meta.json`、`.clawhub/origin.json`）、git 检出、插件登记文件 | 判断技能和插件从哪里来，用来检查更新 | 来源和上次查到的上游版本；不保存令牌 | `update-cache.json`、`update-baselines.json` |

新 Agent 发现最多每天运行一次（在打开“概览”或“设置”时触发），从不打开 Apple、系统和受隐私保护的目录，例如通讯录、通话记录、邮件、信息、Safari、日历、照片和 `com.apple.*`。

从不读取 macOS 钥匙串。OpenClaw / QClaw 的 SQLite 认证库只记录“存在”，不打开。

### 什么时候会写入其他 Agent 的文件夹

除了下面第 1 项“自动接入”，所有写入其他 Agent 文件夹或配置的操作，都会先列出每一步，你确认后才执行。替换或移走之前会先备份到 `backups/` 或 `trash/`，之后可以在“设置 → 历史与撤销”里撤销。

1. **自动接入（默认开启）**：新放进技能库 `~/.agents/skills` 的技能，会在常用 Agent 的技能目录里建一个指向技能库的链接（办公小浣熊不认链接，复制一份；只在它是常用 Agent 或范围选了“所有已安装的 Agent”时才复制）。
   - 只给还没有这个技能的 Agent 接入；Agent 自己已有同名副本的不动。
   - 开启时（包括从旧版本升级后第一次启动），库里已有的技能不会被自动接入。它们在技能库页的“补齐接入”里，由你确认后再处理。
   - 从不自动修改 Hermes 的配置。
   - 触发时机：启动时、每次扫描后、技能库或这些技能目录的第一层有变化时（约 2 秒后），以及运行 `skill-control sync` 时。
   - 还没选常用 Agent 时，按界面上显示的常用 Agent 处理：应用根据最近 30 天推荐的 Agent；没有推荐时是所有显示的 Agent。
   - 撤销：每次自动接入后会弹出提示，12 秒内可以直接点“撤销”；之后可以在“设置 → 历史与撤销”里撤销，或运行 `skill-control undo <historyId>`。撤销或取消接入过的组合，以后不会再被自动接回。
   - 关闭：技能库页的“自动接入”开关。高级用户也可以设置环境变量 `SKILL_MANAGER_AUTO_LINK=off`。
2. **安装技能**：导入 `.skill`、`.zip` 或文件夹，从一个 Agent 装到其他 Agent，技能详情里的安装开关，以及 `skill-control add`。会放进技能库并接入你选的 Agent，或者只复制到某一个 Agent 的目录。
3. **补齐接入**：一次接入开启自动接入之前就有的缺口。Hermes 的“额外目录”（在 `~/.hermes/config.yaml` 的 `skills.external_dirs` 里加上技能库）只有在你勾选时才会修改，改之前备份。
4. **一键整理、取消接入、停用、移除**：可能把某个 Agent 里的副本移进技能库、原位置换成链接；停用会在对应 Agent 的配置里记一笔（Codex 的 `config.toml`、Gemini 的 `settings.json`、OpenClaw / QClaw 的配置、办公小浣熊的 `skill-settings.json`，Hermes 通过 `hermes config set`）；移除的技能放进 `~/.agent-skill-manager/trash/`，可以放回原位。
5. **更新**：技能更新会替换技能文件夹（先备份），并更新 `~/.agents/.skill-lock.json` 里对应的一条；插件、`lark-cli`、git 检出和 Agent 软件的更新，运行它们自己的官方命令（如 `claude plugin update`、`lark-cli update`、`git pull --ff-only`、`npm` 安装命令）。
6. **命令行工具的“预览修复”**（在“连接器与 MCP → 命令行工具”里，也可以从体检进入）：在 `~/.local/bin` 写一个命令启动脚本，或给 Agent 补放行规则；写之前展示改动并备份。
7. **设置 → Agent 集成**：“安装命令行工具”写入 `~/.local/bin/skill-control`（已有同名文件且不是 Skill Control 写的，就拒绝覆盖）；“装到常用 Agent”把随附的 `skill-control` 技能放进技能库并接入。两者都可以在同一处卸载。

### 联网

Skill Control 自己发出的联网请求只有下表这些。请求里不带账户、Cookie 或设备标识，也不包含你的文件内容、路径或密钥。和任何联网请求一样，这些服务能看到你的 IP 地址，以及你查询了哪些软件包、仓库。

| 请求 | 发往 | 什么时候 | 发送什么 |
| --- | --- | --- | --- |
| Skill Control 自身的更新检查（桌面版） | `api.github.com`（本项目的最新正式版本） | 启动 15 秒后，距上次检查满 24 小时时；之后每小时判断一次是否满 24 小时；或你在“设置 → 版本检查”里手动检查 | 一个查询请求，`User-Agent` 只含应用版本、系统平台和芯片架构 |
| 下载 Skill Control 的新版本 | `github.com` 和 GitHub 的下载域名（`objects.githubusercontent.com`、`release-assets.githubusercontent.com`、`github-releases.githubusercontent.com`） | 你点“下载并安装”之后 | 同上 |
| Agent 软件的版本检查 | `registry.npmjs.org`；`api.github.com`（只对更新来源在 GitHub 的产品，如 Hermes）；各 Agent 应用自己配置的更新地址（从应用的 `Info.plist` 或 `app-update.yml` 读出，只接受 https 公网地址） | 启动时（距上次满 24 小时）和之后每 24 小时；或你点“立即检查” | 软件包名或更新地址；`User-Agent: skill-control-version-check` |
| 技能和插件的更新检查 | `api.github.com`、`github.com`、`raw.githubusercontent.com`、`registry.npmjs.org`、`open.feishu.cn`、`clawhub.ai`、`api.skillhub.cn`、`download.codebuddy.cn`；技能所在 git 仓库的远端（`git ls-remote`，只取最新提交号） | 只在你点“更新 → 检查更新”时 | 来源的公开地址；`User-Agent: skill-control-update-check`。默认不带 GitHub 令牌；只有在配置文件里打开 `updates.useGhAuth` 后，才会读取 `gh auth token`，只附加在发往 `api.github.com` 的请求里，不保存 |
| 执行更新 | 由对应工具自己的更新命令联网（npm、`claude`、`codex`、`hermes`、`lark-cli`、`git`），技能更新从 `raw.githubusercontent.com` 下载 | 你确认更新之后 | 由这些工具决定 |
| 打开网页 | 你的默认浏览器 | 你点“官网”“打开下载页”“使用说明”“反馈问题”等链接时 | — |

**怎样关闭**

- **设置 → 数据与隐私 → 自动检查更新**：关闭后，Skill Control 不会自己联网。你点“立即检查”“检查更新”或执行更新时，仍会联网。
- **第一次启动**：新安装在你看过联网说明之前不做任何自动检查。看过的意思是：在引导第一步点“下一步”，在概览的提示条上点“知道了”或“在设置里修改”，或者在设置里拨过这个开关；在引导第一步选“稍后再说”不算。从 0.2.x 升级的用户之前一直在检查更新，升级后照常检查，可以随时用上面的开关关闭。
- **环境变量 `SKILL_MANAGER_UPDATES_OFFLINE=1`（高级）**：关闭全部联网，包括手动检查，也不执行会联网的更新命令。从程序坞或访达打开的应用读不到终端里设置的变量，需要从终端启动（macOS，先退出 Skill Control）：

  ```bash
  SKILL_MANAGER_UPDATES_OFFLINE=1 "/Applications/Skill Control.app/Contents/MacOS/Skill Control"
  ```

- **代理**：桌面版的联网请求使用系统代理；设置了 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`（以及 `NO_PROXY`）时改用它们。

### 数据保存在哪里、怎样删除

| 位置 | 内容 |
| --- | --- |
| `~/.agent-skill-manager/`（Windows：`%USERPROFILE%\.agent-skill-manager`） | 配置 `config.json`、操作历史 `history.jsonl`、替换前的备份 `backups/`、从技能库或 Agent 移除的技能 `trash/`、导入预览 `imports/`，以及上面表格里的统计和缓存文件、`auto-link.json`（自动接入记录） |
| 桌面版用户数据：macOS `~/Library/Application Support/Skill Control/`，Windows `%APPDATA%\Skill Control`，Linux `~/.config/Skill Control` | 应用更新的检查结果 `app-update.json`，以及 Electron 的缓存 |
| `~/Library/Preferences/dev.skillcontrol.desktop.plist`（macOS） | 系统为应用保存的偏好设置 |
| `~/.local/bin/skill-control` | 命令行工具的启动脚本（只在你安装后才有） |
| 系统临时目录里的 `skill-control-update-*` | 下载中的更新包；安装完成或失败后删除。macOS 更新后，旧版本会被移到废纸篓 |

删除方法：先退出 Skill Control，再删除上面的文件夹和文件。删除前请先看一眼 `trash/` 和 `backups/`：从 Agent 移除的技能和替换前的旧版本都在里面，删掉就找不回。

删除这些数据不会影响技能库 `~/.agents/skills`，也不会影响各 Agent 技能目录里的技能和链接。不要删除技能库，否则指向它的链接会失效。完整的卸载步骤见 [README](./README.md#卸载)。

项目目前没有为备份、回收站和导入预览设定自动清理期限。

### 分享诊断信息

公开提交 Issue、截图或日志之前，请去掉用户名、完整路径、私人技能内容、访问令牌和其他能识别你的信息。维护者不会要求你公开整个技能目录。

### 变更

如果以后加入新的联网功能、可选遥测或在线技能目录，会在发布前更新本说明，并在功能里给出清楚的告知和选择。

---

## English

Skill Control reads your AI agents' files on your computer and organizes and counts them locally. This notice lists what it reads, what it keeps, when it changes other agents' folders, when it goes online, and how to delete its data.

### What we do not collect

- No telemetry, analytics, crash reporting or advertising SDK.
- No user account and no server run by the maintainers.
- Skill content, conversations, secrets, file paths and device identifiers are never uploaded.

The UI and the local service talk only over the loopback address (`127.0.0.1`), not over your network. The UI loads no external resources.

### What is read on your computer

"Kept" means written to Skill Control's own data folder, `~/.agent-skill-manager/` (`%USERPROFILE%\.agent-skill-manager` on Windows); the table gives file names only.

| Read from | Used for | Kept | Stored in |
| --- | --- | --- | --- |
| Each agent's skill folders (such as `~/.claude/skills`, `~/.codex/skills`) and the library `~/.agents/skills` | Listing skills, previewing files, working out which agent can see which skill, comparing versions | Paths, file sizes and modification times, content fingerprints. Skill content is not copied | `fingerprint-cache.json`, `library-lock.json` |
| Session transcripts: `~/.claude/projects`, `~/.codex/sessions`, `~/.codex/archived_sessions`, `~/.workbuddy/projects`, OpenClaw / QClaw `agents/*/sessions`; session databases: Codex `~/.codex/state_*.sqlite`, Hermes `state.db`, WorkBuddy `workbuddy.db`, Office Raccoon (办公小浣熊) `local-chat.sqlite3`; Hermes `skills/.usage.json`, WorkBuddy `usage-log.json` | The usage page and overview: sessions, tokens, skill use, estimated cost; suggesting primary agents from the last 30 days of sessions | Session files are read to count sessions and tokens. Only numbers are kept; conversation content is never stored or uploaded. Kept: counts, token numbers, skill names, model names, dates, project folder names (the folder name only, not the full path) and short hashes used to avoid counting twice. Databases are opened read-only | `usage-index.json` |
| Agent configuration and credential files: each agent's MCP configuration, `~/.claude/settings.json`, `~/.claude.json`, the Gemini / WorkBuddy / Hermes `.env` and settings files, OpenClaw / QClaw / Office Raccoon configuration; `~/.npmrc`, `~/.netrc`, `~/.aws/credentials`, `~/.config/gh/hosts.yml`, `~/.docker/config.json`, `~/.lark-cli/config.json`; `.env*` files inside skill folders | Connectors & MCP → Secrets: which services' keys are stored where, who uses them, and whether they changed. Read only when you open that tab | Secret values are never shown or stored. For values of 16 characters or more, a salted fingerprint is kept on your computer to tell whether a value changed (`.env*` files in skill folders: key names only, no fingerprint). Kept: key names, locations, fingerprints, first-seen and changed times; the salt is generated randomly on your computer | `secret-snapshot.json`, `secret-salt` |
| Agents' instruction, memory and rule files (such as `CLAUDE.md`, `AGENTS.md`, memory files), configuration details, plugins, MCP servers, experts and profiles; expert use counts from WorkBuddy's database (expert id, count and time only) | Showing them on the matching pages | Nothing. Secret-looking fields are masked before display | — |
| Installed apps (`Info.plist` in `/Applications` and `~/Applications`), command folders (PATH, `~/.local/bin`, nvm, Homebrew and so on), agents' terminal environment records (shell snapshots) and Hermes' launchd configuration | Detecting agents, reading version numbers, the command-line tools cards and health checks | Version numbers, command names and paths. Files are read; these programs are not run. On macOS, app icons are converted to cached PNGs | `agent-versions.json`, `cli-skill-mentions.json`, `icons/` |
| New-agent discovery: hidden folders in your home folder (skipping `.ssh`, `.gnupg`, `.docker`, caches and toolchains), folders in `~/Library/Application Support` that match an installed app or are named like an agent, `~/.local/bin` | Finding folders with `skills/*/SKILL.md` that belong to no known agent, so you can add them as a custom agent | Candidate paths, names and skill counts | `discovery.json` |
| `~/.agents/.skill-lock.json`, source records inside skills (`_skillhub_meta.json`, `.clawhub/origin.json`), git checkouts, plugin registries | Working out where skills and plugins come from, for update checks | Sources and the upstream versions last seen; no tokens | `update-cache.json`, `update-baselines.json` |

New-agent discovery runs at most once a day (when you open Overview or Settings) and never opens Apple, system or privacy-protected folders such as Contacts, call history, Mail, Messages, Safari, Calendars, Photos or `com.apple.*`.

The macOS keychain is never read. OpenClaw / QClaw SQLite credential stores are only noted as present, never opened.

### When other agents' folders are changed

Except for item 1, auto-link, every change to another agent's folder or configuration is shown step by step first and runs only after you confirm. Anything replaced or removed is first backed up to `backups/` or `trash/`, and can be undone in Settings → 历史与撤销 (history and undo).

1. **Auto-link (on by default)**: a skill that newly arrives in the library `~/.agents/skills` gets a link to the library in your primary agents' skill folders (Office Raccoon does not follow links and gets a copy, only when it is a primary agent or the scope is "all installed agents").
   - Only agents that do not have the skill yet are touched; an agent's own copy with the same name is left alone.
   - When auto-link is turned on (including the first start after upgrading), the skills already in the library are not linked automatically. They are offered on the library page as a catch-up plan (补齐接入) that runs after you confirm.
   - Hermes' configuration is never changed automatically.
   - When: at start, after each scan, when the first level of the library or those skill folders changes (after about 2 seconds), and when `skill-control sync` runs.
   - Before you pick primary agents, the primary agents shown in the app are used: the ones suggested from the last 30 days, or every shown agent when there is no suggestion.
   - Undo: after each run a notice offers 撤销 (undo) for 12 seconds; later, use Settings → 历史与撤销 or `skill-control undo <historyId>`. A pair you undid or unlinked is never linked again automatically.
   - Turn off: the 自动接入 switch on the library page, or the environment variable `SKILL_MANAGER_AUTO_LINK=off`.
2. **Installing skills**: importing a `.skill`, `.zip` or folder, installing from one agent to others, the install switches in skill details, and `skill-control add`. The skill goes into the library and is connected to the agents you chose, or is copied into one agent's own folder only.
3. **Catch-up (补齐接入)**: connects the gaps that existed before auto-link was turned on. Hermes' extra directory (adding the library to `skills.external_dirs` in `~/.hermes/config.yaml`) is changed only when you tick it, after a backup.
4. **Tidy up, unlink, disable, remove**: may move an agent's copy into the library and put a link in its place; disabling records the switch in that agent's configuration (Codex `config.toml`, Gemini `settings.json`, the OpenClaw / QClaw configuration, Office Raccoon `skill-settings.json`, or `hermes config set` for Hermes); removed skills go to `~/.agent-skill-manager/trash/` and can be put back.
5. **Updates**: a skill update replaces the skill folder (after a backup) and updates its entry in `~/.agents/.skill-lock.json`; plugin, `lark-cli`, git checkout and agent software updates run the tool's own official command (such as `claude plugin update`, `lark-cli update`, `git pull --ff-only` or an `npm` install).
6. **"Preview fix" for command-line tools** (in 连接器与 MCP → 命令行工具, also reachable from the health check): a launcher script in `~/.local/bin` or a missing allow rule for an agent; the change is shown and backed up first.
7. **Settings → Agent 集成 (agent integration)**: "install command-line tool" writes `~/.local/bin/skill-control` (an existing file of that name that Skill Control did not write is never overwritten); "install to primary agents" puts the bundled `skill-control` skill into the library and connects it. Both can be removed in the same place.

### Network access

These are the only network requests Skill Control makes itself. They carry no account, cookie or device identifier, and none of your file contents, paths or secrets. As with any request, these services see your IP address and which packages and repositories were asked about.

| Request | Sent to | When | What is sent |
| --- | --- | --- | --- |
| Skill Control's own update check (desktop) | `api.github.com` (this project's latest full release) | 15 seconds after start when the last check is 24 hours old; then hourly it checks whether 24 hours have passed; or by hand in Settings → 版本检查 (version checks) | One query; the `User-Agent` holds only the app version, platform and architecture |
| Downloading a new Skill Control version | `github.com` and GitHub's download hosts (`objects.githubusercontent.com`, `release-assets.githubusercontent.com`, `github-releases.githubusercontent.com`) | After you click 下载并安装 (download and install) | As above |
| Agent software version checks | `registry.npmjs.org`; `api.github.com` (only for products whose own update source is on GitHub, such as Hermes); each agent app's own update address (read from the app's `Info.plist` or `app-update.yml`, public https addresses only) | At start (when the last check is 24 hours old), then every 24 hours; or when you click 立即检查 (check now) | Package names or update addresses; `User-Agent: skill-control-version-check` |
| Skill and plugin update checks | `api.github.com`, `github.com`, `raw.githubusercontent.com`, `registry.npmjs.org`, `open.feishu.cn`, `clawhub.ai`, `api.skillhub.cn`, `download.codebuddy.cn`; the remote of a skill's git repository (`git ls-remote`, latest commit id only) | Only when you click 检查更新 (check for updates) on the Updates page | Public source addresses; `User-Agent: skill-control-update-check`. No GitHub token by default; only with `updates.useGhAuth` turned on in the configuration file is `gh auth token` read, attached to `api.github.com` requests only, and never stored |
| Running an update | The tool's own update command (npm, `claude`, `codex`, `hermes`, `lark-cli`, `git`); skill updates download from `raw.githubusercontent.com` | After you confirm an update | Decided by those tools |
| Opening web pages | Your default browser | When you click links such as the product site, download page, help or issues | — |

**Turning it off**

- **Settings → 数据与隐私 → 自动检查更新** (automatic update checks): when off, Skill Control does not go online by itself. Checks and updates you start still go online.
- **First start**: a new install makes no automatic check until you have seen the network notice: 下一步 (next) on the first onboarding step, 知道了 (got it) or 在设置里修改 (change in Settings) on the overview banner, or flipping the switch in Settings. Choosing 稍后再说 (later) on the first onboarding step does not count. Users upgrading from 0.2.x were already checking and keep checking until they turn the switch off.
- **`SKILL_MANAGER_UPDATES_OFFLINE=1` (advanced)**: turns off all network access, including checks you start, and refuses update commands that would go online. An app opened from the Dock or Finder does not see variables set in a terminal, so start it from a terminal (macOS, after quitting Skill Control):

  ```bash
  SKILL_MANAGER_UPDATES_OFFLINE=1 "/Applications/Skill Control.app/Contents/MacOS/Skill Control"
  ```

- **Proxy**: the desktop app uses the system proxy; `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (and `NO_PROXY`) override it when set.

### Where data is stored and how to delete it

| Location | Contents |
| --- | --- |
| `~/.agent-skill-manager/` (Windows: `%USERPROFILE%\.agent-skill-manager`) | `config.json`, the operation history `history.jsonl`, backups taken before replacements `backups/`, skills removed from the library or an agent `trash/`, staged imports `imports/`, the usage and cache files listed above, and `auto-link.json` (auto-link records) |
| Desktop user data: macOS `~/Library/Application Support/Skill Control/`, Windows `%APPDATA%\Skill Control`, Linux `~/.config/Skill Control` | The app update state `app-update.json` and Electron's caches |
| `~/Library/Preferences/dev.skillcontrol.desktop.plist` (macOS) | Preferences the system keeps for the app |
| `~/.local/bin/skill-control` | The command-line launcher (only if you installed it) |
| `skill-control-update-*` in the system temp folder | An update being downloaded; deleted after install or failure. After a macOS update the old version goes to the Trash |

To delete: quit Skill Control, then delete the folders and files above. Look inside `trash/` and `backups/` first: skills removed from agents and replaced old versions are kept there and cannot be recovered once deleted.

Deleting this data does not affect the library `~/.agents/skills` or the skills and links in your agents' folders. Do not delete the library: the links that point to it would stop working. For full uninstall steps see the [English README](./README_EN.md#uninstall).

Backups, the trash and staged imports currently have no automatic retention period.

### Sharing diagnostics

Before sharing an Issue, screenshot or log, remove usernames, full paths, private skill content, access tokens and anything else that identifies you. The maintainers will never ask you to publish a whole skill folder.

### Changes

If a future version adds new network features, optional telemetry or an online skill catalog, this notice will be updated before release, and the feature will give clear notice and a choice.
