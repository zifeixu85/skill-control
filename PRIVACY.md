# 隐私说明 / Privacy Notice

最后更新：2026-07-26

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
| 同步与导入摘要 | 展示最近操作 | `~/.agent-skill-manager/history.jsonl` |
| 被替换的旧 Skill | 出错时保留恢复副本 | `~/.agent-skill-manager/backups/` |
| 导入的 `.skill` 解压内容 | 安装前预览 | `~/.agent-skill-manager/imports/` |

The application reads configured Skill directories to calculate metadata and
show previews. It stores configuration, operation summaries, backups, and
staged imports under `~/.agent-skill-manager/`.

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

安装依赖时，npm 会按照你的 npm 配置访问包注册表。访问 GitHub、下载 Release 或
检查未来版本更新也可能产生由相应平台处理的网络请求；这些行为与核心本地 Skill
扫描不同。

In source mode, the UI communicates with a loopback-only local service. npm
dependency installation, visiting GitHub, downloading a release, or a future
update check may make network requests governed by the corresponding provider;
these are separate from local Skill scanning. Packaged desktop mode also uses
loopback-only UI and manager services, automatically chooses a free local port
when needed, and restricts the manager's allowed origin to the active local UI.

## 保留与删除 / Retention and deletion

项目当前不会自动设定备份和导入预览的保留期限。退出应用后，相关文件仍可能保留，
以便恢复或再次检查。

在确认不再需要备份后，可以关闭 Skill Control，然后删除：

```text
~/.agent-skill-manager/
```

这会删除 Skill Control 的配置、历史、导入预览和备份，但不会删除各 Agent
目录中已经安装的 Skills。若只想清除部分数据，可以单独删除 `history.jsonl`、
`imports/` 或 `backups/`。

The project currently applies no automatic retention period. After closing
Skill Control, deleting `~/.agent-skill-manager/` removes its configuration,
history, staged imports, and backups. It does not remove Skills already
installed in Agent directories.

## 分享诊断信息 / Sharing diagnostics

公开 Issue、截图或日志前，请移除用户名、绝对路径、私人 Skill 内容、访问令牌和其他
可识别信息。维护者不会要求你公开整个 Skill 目录。

Before sharing an Issue, screenshot, or log, remove usernames, absolute paths,
private Skill content, access tokens, and other identifying information.

## 变更 / Changes

如果未来加入可选遥测、在线 Skill 目录或自动更新网络请求，我们会在合并前更新本说明，
并在相应功能中提供清楚的告知和选择。

If future versions add optional telemetry, an online Skill catalog, or update
network requests, this notice will be updated before release and the feature
will provide clear disclosure and choice.
