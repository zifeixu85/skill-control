# Skill Control（技能管理器）

[简体中文](./README.md) · [English](./README_EN.md)

本地优先的 Agent 工作台。Skill Control 扫描你电脑上的 Codex、Claude Code、WorkBuddy、
Hermes、OpenClaw 等 Agent，把技能、插件、专家、连接器与 MCP、密钥位置、更新、用量和
预估费用放进同一个界面，并围绕你常用的 Agent 判断哪里需要处理。

<!-- TODO(v0.2.0): 用临时 HOME 下的示例数据重新截图（概览、技能、数据），替换 docs/images/ 中 v0.1 的旧截图后在此引用。不要使用真实用户数据。 -->

> 最新版本：`v0.2.0`。可下载的桌面产物和各平台的验证状态以 [Releases](../../releases)
> 为准。

## 为什么需要 Skill Control

同一个技能经常同时装在好几个 Agent 里，插件、MCP 服务、密钥和用量也分散在各自的
配置目录。手动维护很容易漏装、版本不一致、覆盖错误，也很难说清楚“这个月到底用了多少”。
Skill Control 把这些信息读到一起：

- 你常用的 Agent 里，哪些技能内容不一致、哪边较新；
- 哪些技能、插件和 Agent 本身有新版本；
- 每个 Agent、技能、项目用了多少 token，按官方价格大约值多少钱；
- 哪些配置有问题，怎么修。

所有扫描都在本机完成；任何写入都先展示计划，确认后才执行，并可以撤销。

## 功能

### 围绕常用 Agent

- 在设置里选出你主要使用的 Agent（最多 4 个），技能状态只针对它们判断；没有选择时
  按近 30 天的会话活跃度给出建议；
- 检测到新的 Agent 时在概览和设置里提示，可以加入常用或标为已知；也能找出用户目录里
  含 `skills/*/SKILL.md` 的未知目录，添加为自定义 Agent；
- 每个 Agent 一页：技能、指令 / 记忆 / 规则等文件（敏感内容脱敏）、工具与权限、用量。

### 技能与技能库

- 按常用 Agent 显示技能是否一致、哪边较新、重复副本和共享目录；
- 浏览技能文件树，Markdown 渲染与原文切换，常见图片与安全过滤后的 SVG 预览；
- 近 90 天的技能使用次数（标明精确或推算）；
- 冲突版本可以分别打开查看，文件级变化、逐行差异和图片并排比较，然后选定权威来源；
- 同步支持“复制”和“软链接”两种方式，替换前自动备份；
- 导入、预览、安装和导出 `.skill` 技能包，也可以导出通用 `.zip`；
- **技能库**：统一管理 `~/.agents/skills` 共享技能库，按每个 Agent 自己的读取规则模拟它
  实际能看到哪些技能；收编副本、改为链接、停用、卸载到废纸篓都先出计划、确认后执行；
- 技能、插件、专家、MCP 和技能库列表可以按最近使用、最新安装、最常用或名称排序。

### 更新

- **技能与插件**：识别每个技能和插件的来源（skills CLI、Claude / Codex 插件、WorkBuddy、
  SkillHub、ClawHub、git 等），检查上游新版本；本地改过的内容需要你选择保留还是覆盖；
- **Agent 软件**：每天检查一次各 Agent 有没有新版本，只读取官方来源；有官方更新命令的
  命令行工具可以“一键更新”，执行前先显示命令和影响；
- **Skill Control 自身**：应用内更新，见下文“应用更新”。

### 数据与预估费用

- 汇总 Claude Code、Codex、WorkBuddy、Hermes、OpenClaw、QClaw 和办公小浣熊的 token、会话、
  技能调用与项目，支持今天、近 7 天、近 30 天、近 90 天和所有时间；
- 每个数字标明是精确、推算还是产品自报；只保存计数，不保存对话内容；
- **预估费用**按各厂商官方 API 价格计算（含长上下文、缓存读写、错峰价），订阅内的用量也按
  API 等价估算，不等于实际账单；
- **模型价格表**列出全部已定价模型、官方来源和核对日期，价格可能过期时会提示。

### 体检与 AI 指令

- 检查失效链接、缺失或无效的 `SKILL.md`、过大的技能、不一致的副本、缺少的命令与环境变量、
  配置里的明文密钥、插件状态和技能库问题；
- 每个问题都有“复制 AI 指令”：只复制一段说明，交给你自己的 AI 处理，不改任何东西；
- 能安全自动修复的问题提供“预览修复”：先列出将改动的文件，确认后执行，可以从历史撤销。

### 专家、插件、连接器与密钥

- **专家与 Agent**：WorkBuddy 的“我的专家”、市场专家与专家团，Hermes Profile，OpenClaw
  Agent，办公小浣熊的专家与团队，按产品分组；
- **插件**：Codex、Claude Code、WorkBuddy、Hermes、OpenClaw 与 QClaw 的插件、启用状态和组件；
- **连接器与 MCP**：跨 Agent 的 MCP 服务清单与连接器，配置只读、密钥打码；
- **密钥**：哪些服务的密钥存在哪里、谁在用、最近有没有变化。只显示名称和位置，从不读取或
  显示密钥的值。

### 历史、恢复与卸载

- 同步、导入、更新、技能库和修复都有操作记录，可以从历史恢复；
- 从某个 Agent 卸载技能会先移到 Skill Control 的废纸篓，可以还原。

Windows 创建目录软链接时可能需要开启“开发人员模式”；不确定时请使用默认的“复制”方式。

## 支持的 Agent

应用只会把本机检测到或你手动添加的 Agent 加入数据源；检测到的 Agent 默认都会显示，
可以在“设置 → 常用 Agent”中调整。

| Agent | 默认技能目录 |
| --- | --- |
| Codex | `~/.codex/skills`、`~/.agents/skills`、`~/.codex/vendor_imports/skills` |
| Claude Code | `~/.claude/skills` |
| WorkBuddy | `~/.workbuddy/skills`、`~/.workbuddy/connectors/skills` |
| Hermes Agent | `~/.hermes/skills`（按 Hermes 的规则递归，含 Profile 和外部目录） |
| OpenClaw | `~/.openclaw/skills` 等 OpenClaw 的六个技能来源 |
| QClaw | `~/.qclaw/skills`（只读） |
| 办公小浣熊 | `~/.box-agent/skills`（只复制，不使用软链接） |
| 订单来了（SmartOrder） | `~/.smartorder/skills`，以及配置中已启用插件的技能目录 |
| Cursor | `~/.cursor/skills` |
| Gemini CLI | `~/.gemini/skills` |
| Kiro | `~/.kiro/skills` |
| Trae | `~/.trae/skills` |
| OpenCode | `~/.config/opencode/skills`、`~/.opencode/skills` |
| Windsurf | `~/.windsurf/skills` |
| Cline | `~/.cline/skills` |
| Roo Code | `~/.roo/skills`、`~/.roo-code/skills` |
| CodeBuddy | `~/.codebuddy/skills` |
| Qwen Code | `~/.qwen/skills`、`~/.qwen-code/skills` |
| GitHub Copilot | `~/.copilot/skills`、`~/.github/copilot/skills` |

不在表中的工具可以通过名称、简称、颜色和一个或多个技能目录手动添加。移除一个 Agent
只会删除这项配置，不会删除目录里的技能文件。LumiClaw、MotiClaw 和 Clawith 只读显示
是否安装、版本和数量。

### 订单来了：技能与连接器

自动检测当前用户目录下的 `.smartorder`，Windows 与 Mac 使用相同的相对目录规则。
可以查看本地技能、内置技能和已启用插件内的技能；遵循 `skills.config` 的停用项，市场清单、
未登记缓存和历史版本不会混入已安装列表。插件与系统内置技能只读，不允许通过普通安装或
同步覆盖。连接器只展示配置摘要，不访问远程服务、不执行连接器命令，也不展示凭据、
环境变量值、启动参数或 URL 的路径 / 查询部分。

## 获取与运行

### 桌面版

从 [Releases](../../releases) 下载与你的系统对应的文件：

| 你的系统 | 应选择的文件 |
| --- | --- |
| Apple Silicon Mac（M1/M2/M3/M4/M5…） | `Skill-Control-<版本>-mac-arm64.dmg` |
| Intel Mac | `Skill-Control-<版本>-mac-x64.dmg` |
| Windows x64 | `Skill-Control-<版本>-win-x64-setup.exe`（安装版）或 `…-portable.exe`（便携版） |
| Linux x64 | `Skill-Control-<版本>-linux-x86_64.AppImage` 或 `…-linux-amd64.deb` |

不确定 Mac 是哪种芯片：点屏幕左上角苹果菜单 →“关于本机”，看“芯片”一行。

Apple Silicon 用户不要选择 `mac-x64`，否则 macOS 会把它当作 Intel 应用。Release 中的
`*.zip`、`latest*.yml` 和 `*.blockmap` 供应用内更新使用，不需要手动下载；
`SHA256SUMS.txt` 提供全部文件的校验值。

### 首次打开（macOS）

Skill Control 是个人开源项目，安装包没有经过 Apple 开发者证书签名和公证，所以 macOS
第一次打开时会拦一下。应用本身是完整签名的（ad-hoc），可以放心按下面的步骤打开：

1. 打开 dmg，把 Skill Control 拖进“应用程序”文件夹，然后双击打开。
2. 如果提示“Apple 无法验证‘Skill Control’是否包含恶意软件”或“无法打开”，先点“完成”。
3. 打开“系统设置 → 隐私与安全性”，滚到页面底部的“安全性”，点“Skill Control”旁边的
   “仍要打开”，输入开机密码确认。以后就能正常打开了。
   （macOS 14 及更早的版本，也可以在“应用程序”里右键点 Skill Control →“打开”。）

**如果提示“已损坏，无法打开，你应该将它移到废纸篓”**：这是 v0.2.0 的 macOS 安装包签名
不完整造成的，v0.2.1 起已修复，建议下载最新版本。已经装好的 v0.2.0 可以在“终端”里运行下面
这条命令，去掉下载时系统加的隔离标记，然后再打开：

```bash
xattr -dr com.apple.quarantine "/Applications/Skill Control.app"
```

这条命令只移除“从网上下载”的标记，不改动应用本身；请只对从本仓库 Releases 下载的文件
这样做，必要时可以用 `SHA256SUMS.txt` 核对下载文件的校验值（`shasum -a 256 文件名`）。

### 首次打开（Windows / Linux）

- **Windows**：SmartScreen 可能提示“未知发布者”，点“更多信息 → 仍要运行”。
- **Linux**：AppImage 需要先赋予执行权限：`chmod +x Skill-Control-*.AppImage`。

### 应用更新

从 v0.2.0 开始，Skill Control 会检查 GitHub Releases 上的新版本：启动后（距上次检查超过
24 小时时）和之后每天一次，也可以在“设置 → 关于”里手动检查。

- **macOS**：校验 sha512 并确认新应用的标识和版本后替换当前应用，旧版本移到废纸篓，
  然后自动重启；任何一步失败都会恢复原来的版本。请把应用放在“应用程序”文件夹里，
  从 DMG 直接运行或放在不可写的位置时会改为打开下载页；
- **Windows**：安装版可以应用内下载并安装（安装包未签名，SmartScreen 可能提示）；
  便携版需要手动下载替换；
- **Linux**：AppImage 可以应用内更新；`.deb` 请手动下载新的安装包；
- 只提供正式版本，不提供预发布版本；离线模式和从源码运行时不检查。

### 从源码运行

需要 Node.js `22.13.0` 或更高版本、npm 和 Git。

```bash
git clone https://github.com/zifeixu85/skill-control.git
cd skill-control
npm install
npm run dev
```

打开 [http://localhost:3000](http://localhost:3000)。`npm run dev` 会同时启动界面和只监听
`127.0.0.1:43110` 的本地管理服务。

```bash
npm run build && npm start   # 构建后运行
npm run desktop:dev          # Electron 开发窗口
```

桌面打包命令列在 `package.json` 中；发布维护者应只在对应平台构建并验证产物，
见 [发布指南](./docs/RELEASING.md)。

## `.skill` 与 ZIP 导出

Skill Control 使用 ZIP 容器作为 `.skill` 格式，包内必须包含一个 `SKILL.md`，可以位于
压缩包根目录或单一顶层文件夹中。导出时可以保留 `.skill` 扩展名，也可以选择通用 `.zip`。
导入时的限制：压缩包和单个文件不超过 25 MB、最多 1,500 个条目、解压后总大小不超过
100 MB，拒绝路径穿越和包含多个技能根目录的包。导入文件先解压到本机预览区，选择文件
不会直接修改任何 Agent 目录。

## 数据与隐私

Skill Control 的数据位于：

```text
~/.agent-skill-manager/
├── config.json            配置（常用 Agent、显示的 Agent、自定义目录等）
├── history.jsonl          操作记录
├── backups/               替换前的备份
├── trash/                 卸载和清理移出的技能
├── imports/               .skill 导入预览
├── usage-index.json       用量索引（只有计数，不含对话内容）
├── fingerprint-cache.json 内容指纹缓存
└── …                      更新检查、Agent 版本、密钥变化快照等缓存
```

应用更新的检查结果保存在桌面应用的用户数据目录（macOS 为
`~/Library/Application Support/Skill Control/app-update.json`）；下载的更新包放在系统临时
目录，安装或失败后删除。

Skill Control 没有遥测，也不会上传技能内容。会联网的只有：应用更新检查（本项目在
`api.github.com` / `github.com` 上的 Release）、Agent 版本检查与技能 / 插件更新检测
（npm registry、GitHub 和各产品自己的更新源），以及你确认执行的一键更新命令。设置
`SKILL_MANAGER_UPDATES_OFFLINE=1` 会关闭全部检查。完整说明见 [PRIVACY.md](./PRIVACY.md)。

## 开发

```bash
npm run dev         # 本地管理服务 + 开发界面
npm run dev:ui      # 在旁路端口启动界面开发环境
npm run build       # 构建界面
npm start           # 运行构建产物 + 本地管理服务
npm run desktop:dev # Electron 开发窗口
npm test            # 构建并运行 Node 测试
npm run lint        # ESLint
npm run typecheck   # TypeScript 类型检查
```

```text
app/       React 界面
desktop/   Electron 主进程、预加载脚本、应用更新和开发启动器
server/    本地扫描、预览、同步、更新、用量与体检服务
scripts/   开发、打包与发布脚本
tests/     Node 测试
resources/ 桌面图标、许可证与平台资源
worker/    Web 构建入口
```

本地服务默认只接受 `http://localhost:3000` 和 `http://127.0.0.1:3000` 来源的请求。
修改涉及文件写入、压缩包解析或路径解析的代码前，请先阅读
[CONTRIBUTING.md](./CONTRIBUTING.md) 中的安全约束；架构说明见
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 路线图

- 应用签名与公证；
- 可选 CLI，供自动化和高级用户使用；
- 可审计的 Agent 目录规则扩展机制。

路线图是方向说明，不代表相应能力已经在当前版本可用。

## 参与贡献

欢迎提交 Bug、交互改进、Agent 适配和安全修复：

- [贡献指南](./CONTRIBUTING.md)
- [行为准则](./CODE_OF_CONDUCT.md)
- [安全政策](./SECURITY.md)
- [第三方声明](./THIRD_PARTY_NOTICES.md)
- [版本记录](./CHANGELOG.md)
- [架构说明](./docs/ARCHITECTURE.md)
- [发布指南](./docs/RELEASING.md)
- [GitHub 仓库配置](./docs/REPOSITORY_SETUP.md)

## 作者

由 A梦 开发和维护。

- 仓库：[github.com/zifeixu85/skill-control](https://github.com/zifeixu85/skill-control)
- 网站：[ameng.blog](https://ameng.blog)

问题与建议请提交到 [GitHub Issues](https://github.com/zifeixu85/skill-control/issues)。

## 许可证

本项目使用 [MIT License](./LICENSE)。
