# 隐私说明 / Privacy Notice

最后更新：2026-09-10

Skill Control 是本地优先的软件。本说明描述项目当前 `v0.1.x` 代码会访问哪些数据，
数据保存在何处，以及用户如何删除这些数据。

Skill Control is local-first software. This notice describes the data accessed
by the current `v0.1.x` code, where it is stored, and how a user can delete it.

## 我们不收集什么 / What we do not collect

当前项目不包含遥测、行为分析、广告 SDK、用户账户或由项目维护者运营的云端后端。
核心扫描、预览、导入、导出和同步流程不会把 Skill 内容上传给项目维护者。

The current project includes no telemetry, behavioral analytics, advertising
SDK, user account, or cloud backend operated by the maintainers. Core scanning,
preview, import, export, and synchronization do not upload Skill content to the
maintainers.

## 本机访问的数据 / Data accessed locally

| 数据 | 用途 | 默认保存位置 |
| --- | --- | --- |
| 配置的 Agent 名称和 Skill 目录 | 扫描和展示数据源 | `~/.agent-skill-manager/config.json` |
| `SKILL.md` 和 Skill 内文件的元数据/内容 | 生成名称、介绍、指纹和详情预览 | 原 Skill 目录；不会因为扫描而复制 |
| WorkBuddy 专家插件清单、成员 Markdown 与包内资源 | 展示已安装专家、成员分工和配置详情 | `~/.workbuddy/`；只读，不复制 |
| Hermes `SOUL.md`、Profile 元数据与非敏感配置项 | 展示 Agent 身份、模型和委派方式 | `~/.hermes/`；只读，不复制 |
| 订单来了技能、插件清单、MCP 配置 | 识别已启用技能和连接器摘要 | `~/.smartorder/` 中的技能/已启用插件目录及 `config.toml`；只读 |
| Skill 路径、文件元数据和内容指纹缓存 | 避免每次扫描重复读取全部文件内容 | `~/.agent-skill-manager/fingerprint-cache.json` |
| 同步与导入摘要 | 展示最近操作 | `~/.agent-skill-manager/history.jsonl` |
| 被替换的旧 Skill | 出错时保留恢复副本 | `~/.agent-skill-manager/backups/` |
| 导入的 `.skill` 解压内容 | 安装前预览 | `~/.agent-skill-manager/imports/` |

The application reads configured Skill directories to calculate metadata and
show previews. It stores configuration, a local fingerprint cache, operation
summaries, backups, and staged imports under `~/.agent-skill-manager/`.
Expert discovery also reads installed WorkBuddy expert packages and Hermes
profiles locally. It excludes `.env`, credentials, tokens, authentication,
session data, and non-allowlisted Hermes configuration fields from previews.

订单来了配置只在本机解析。连接器 API 使用字段白名单，不返回原始 TOML、启动
命令/参数、环境变量值、认证头或 Token；URL 仅保留协议、域名和端口。不会读取
订单来了的会话、日志、数据库或浏览器状态，也不会执行命令或请求连接器服务。

SmartOrder configuration is parsed locally. Connector responses contain only
allowlisted metadata, without raw TOML, commands, arguments, environment values,
authentication headers or tokens. URLs expose only their origin. The adapter
does not read sessions, logs, databases or browser state, and does not execute
or contact connector services.

## 何时会写入 / When files are written

- 保存“工具数据源”设置时会更新本地配置；
- 选择 `.skill` 后，会把安全检查通过的文件解压到本地预览区；
- 只有在生成计划并明确确认后，才会复制或软链接到 Agent Skill 目录；
- 替换现有目录前，会先在本地备份目录中创建副本；
- 导出 `.skill` 时，文件只会保存到用户通过浏览器或桌面系统选择的下载位置。

Saving settings updates local configuration. Import selection stages a local
preview. Agent directories are modified only after a plan and explicit
confirmation, and replacements are backed up first.

## 网络访问 / Network access

源码模式的界面通过回环地址与本地管理服务通信。默认服务地址是
`127.0.0.1:43110`，允许的网页来源是 `localhost:3000` 和
`127.0.0.1:3000`。

桌面模式也只使用本机回环通信：界面服务由操作系统分配空闲端口，管理服务优先使用
`127.0.0.1:43110`；该端口被占用时会自动改用另一个空闲回环端口。桌面进程会把
管理服务允许的网页来源限制为当前界面来源，并通过隔离的 preload 把实际服务地址
传给界面。

安装依赖时，npm 会按照你的 npm 配置访问包注册表。除此之外，Skill Control 只在以下
情况联网，且都只读取公开信息、不发送技能内容或本机路径：

- **应用更新检查**（桌面版）：启动后（距上次检查超过 24 小时时）、之后每天一次或手动
  检查时，请求 `api.github.com` 上本项目的最新 Release；有新版本并由你点击下载时，
  从 `github.com` 及 GitHub 的下载域名获取更新清单和安装包。请求头只包含应用版本、
  平台和架构。检查结果保存在桌面应用的用户数据目录（`app-update.json`），下载的
  安装包放在系统临时目录，安装或失败后删除；
- **Agent 版本检查**：每天一次，读取 npm registry、GitHub 和各产品自己的更新源上的
  最新版本号；
- **技能与插件更新检测**：按技能和插件的来源请求 GitHub、npm registry 等已登记的主机；
  只有你在设置中开启时才会读取 `gh auth token`，并且只发给 `api.github.com`；
- **一键更新**：你确认后，由该命令行工具自己的官方更新命令联网。

设置环境变量 `SKILL_MANAGER_UPDATES_OFFLINE=1` 会关闭以上全部检查（应用更新、Agent
版本和技能更新），也不会执行会联网的更新命令。从源码运行时不检查应用更新。

In source mode, the UI communicates with a loopback-only local service. Besides
npm installing dependencies, Skill Control makes network requests only for: app
update checks in the desktop build (this repository's latest release on
`api.github.com`; the manifest and installer from `github.com` and GitHub's
download hosts when you download an update; the request carries only the app
version, platform and architecture), daily Agent version checks (npm registry,
GitHub and each product's own update source), Skill and plugin update detection
(listed hosts only; `gh auth token` is read only when you enable it and is sent
only to `api.github.com`), and one-click updates you confirm. No Skill content or
local path is sent. `SKILL_MANAGER_UPDATES_OFFLINE=1` turns all of these off.
Packaged desktop mode also uses loopback-only UI and manager services,
automatically chooses a free local port when needed, and restricts the manager's
allowed origin to the active local UI.

## 保留与删除 / Retention and deletion

项目当前不会自动设定备份和导入预览的保留期限。退出应用后，相关文件仍可能保留，
以便恢复或再次检查。

在确认不再需要备份后，可以关闭 Skill Control，然后删除：

```text
~/.agent-skill-manager/
```

这会删除 Skill Control 的配置、历史、导入预览和备份，但不会删除各 Agent
目录中已经安装的 Skills。若只想清除部分数据，可以单独删除
`fingerprint-cache.json`、`history.jsonl`、`imports/` 或 `backups/`。指纹缓存
删除后会在下次扫描时重新生成。

The project currently applies no automatic retention period. After closing
Skill Control, deleting `~/.agent-skill-manager/` removes its configuration,
fingerprint cache, history, staged imports, and backups. It does not remove
Skills already installed in Agent directories.

## 分享诊断信息 / Sharing diagnostics

公开 Issue、截图或日志前，请移除用户名、绝对路径、私人 Skill 内容、访问令牌和其他
可识别信息。维护者不会要求你公开整个 Skill 目录。

Before sharing an Issue, screenshot, or log, remove usernames, absolute paths,
private Skill content, access tokens, and other identifying information.

## 变更 / Changes

如果未来加入可选遥测、在线 Skill 目录或新的联网功能，我们会在合并前更新本说明，
并在相应功能中提供清楚的告知和选择。

If future versions add optional telemetry, an online Skill catalog, or other
network features, this notice will be updated before release and the feature
will provide clear disclosure and choice.
