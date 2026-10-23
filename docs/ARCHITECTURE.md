# 架构说明 / Architecture

Skill Control 采用“本地界面 + 本地权限服务”的结构。界面不直接获得 Node.js 文件
权限；扫描、读取、打包和写入都由只监听回环地址的管理服务完成。

Skill Control uses a local UI plus a privileged local service. The renderer
does not receive direct Node.js file-system access. Scanning, reading,
archiving, and writes are handled by a loopback-only manager service.

## 运行结构

```text
┌─────────────────────────────────────────────┐
│ React UI                                    │
│ app/components · app/lib · app/styles       │
└──────────────────────┬──────────────────────┘
                       │ HTTP / JSON, loopback only
┌──────────────────────▼──────────────────────┐
│ Local manager service                      │
│ server/local-server.mjs                    │
│ scan · preview · import/export · sync      │
└───────┬──────┴──────────────────┬───────────┘
        │ worker thread            │
┌───────▼────────────────┐         │
│ server/scan-worker.mjs │         │
│ discovery · fingerprint│         │
└──────────────┬─────────┘         │
               │                   │
┌──────────────▼─────────┐  ┌──────▼─────────────────┐
│ Agent Skill directories│  │ ~/.agent-skill-manager │
│ ~/.codex, ~/.claude…   │  │ config/history/imports │
└────────────────────────┘  │ backups                │
                            └─────────────────────────┘
```

源码模式由 `scripts/local-runner.mjs` 同时启动本地管理服务和 Vinext 界面。

桌面模式在这套结构外增加 Electron：

```text
Electron main process
├── starts the packaged local UI server
├── starts/verifies the local manager service
├── creates the sandboxed BrowserWindow
└── exposes a small, allowlisted preload API
```

Electron renderer 使用 `contextIsolation: true`、`nodeIntegration: false` 和
`sandbox: true`。不要为了方便让渲染进程直接读取文件系统；需要新的系统能力时，
应增加最小化、参数可验证的 IPC 接口。

## 主要模块

| 路径 | 职责 |
| --- | --- |
| `app/page.tsx` → `app/components/App.tsx` | 应用外壳：数据、导航与提示的 Provider，侧栏、当前页面、抽屉和首次启动面板 |
| `app/components/pages/` | 每页一个组件：概览、技能（列表 + 详情面板 + 安装计划）、插件、专家与 Agent、连接器与 MCP、数据、体检、设置、Agent 页 |
| `app/components/files/` | 完整文件浏览（文件树、Markdown 渲染/原文、frontmatter 表格、图片）与脱敏配置详情 |
| `app/components/drawers/` | 插件、专家、MCP 抽屉与 `.skill` 导入对话框（预览 → 计划 → 确认） |
| `app/lib/api.ts`、`app/lib/types.ts` | 类型化本地服务客户端；新接口经 `parse.ts` 宽松解析，404「接口不存在」视为未提供 |
| `app/lib/skill-model.ts` 等 | 纯函数：常用 Agent 槽位（已装 / 只读 / 插件自带 / 拒绝 / 未装）、筛选、副本分组、安装来源、插件合并、格式化、高亮、图表几何（`tests/ui-*.test.mjs`） |
| `app/hooks/` | 共享缓存的 GET（`useResource`）、滚动位置记忆、Esc 分层关闭、焦点陷阱、偏好存储等 |
| `app/globals.css`、`app/styles/*.css` | 浅色 / 深色设计 token 与按区域拆分的样式；Bricolage Grotesque（OFL）随应用打包，不走 CDN |
| `server/local-server.mjs` | 配置、Skill 与专家扫描、指纹、文件读取、`.skill`、同步与备份、HTTP 路由 |
| `server/scan-worker.mjs` | 在后台线程执行目录扫描和指纹计算，避免阻塞桌面主进程 |
| `server/skill-metadata.mjs` | 从 `SKILL.md` 正文推导展示名称（首个 H1）和中文首段介绍，忽略代码块 |
| `server/skill-status.mjs` | 常用 Agent 状态模型、版本比较、共享目录、重复副本与托管来源判断 |
| `server/sync-targets.mjs` | 同步/导入计划：解析真实写入目录（软链接写穿）、去重共享目录、拒绝越界与互相包含 |
| `server/skill-copy.mjs` | 复制 Skill 时只解引用技能目录内的软链接，跳过越界/失效/循环链接并报告 |
| `server/secret-fields.mjs` | 定位 MCP 配置中疑似明文密钥的字段位置（只返回字段名，从不返回值） |
| `server/cached-loader.mjs` | 集成与活跃度扫描的单飞缓存（TTL、强制刷新防抖、失败不缓存） |
| `server/agents-activity.mjs` | 只读 stat 会话文件，统计近 30 天活跃度并建议常用 Agent |
| `server/codex-plugins.mjs` | 只读解析 Codex 插件缓存、启用状态、组件与已连接应用（connectors） |
| `server/installed-plugins.mjs` | 只读解析 Claude Code 与 WorkBuddy 的已安装插件（`installed_plugins.json` v2）、作用域、启用状态与组件 |
| `server/frontmatter.mjs` | 有上限的 frontmatter / YAML 标量读取与 `parseFrontmatter` |
| `server/workbuddy-experts.mjs` | WorkBuddy 专家市场与“我的专家”发现：版本、安装与使用中状态、分发包、技能、提示词、头像 |
| `server/workbuddy-usage.mjs` | 只读查询 WorkBuddy 数据库中的专家使用次数与最近使用时间 |
| `server/config-detail.mjs` | `/api/config-detail`：Agent、MCP、专家、插件、Skill 的只读脱敏配置详情 |
| `server/agent-settings.mjs` | 各 Agent 关键设置的中文行（只取安全标量与计数） |
| `server/config-mask.mjs` | 结构化配置的默认拒绝脱敏（键名保留，值仅在白名单内显示）、命令行与参数令牌化 |
| `server/redact.mjs` | 自由文本脱敏：PEM 私钥、任意协议的 URL 凭据、敏感名赋值、`-u` / `-H`、常见令牌格式 |
| `server/mcp-inventory.mjs` | 只读汇总 Codex / Claude Code / Cursor / Gemini 的 MCP 服务器 |
| `server/integrations.mjs` | 聚合插件、连接器与 MCP，供 `/api/integrations` 使用 |
| `server/fs-safe.mjs` | 集成扫描共用的限长读取、真实路径边界与 MCP 传输类型判断 |
| `server/config-files.mjs` | 限长 YAML（js-yaml 安全模式）与 JSON5 读取、`~` / `${VAR}` 路径展开、`Info.plist` 版本读取 |
| `server/agent-adapters.mjs` | 有自身技能布局的 Agent 适配器（`SKILL_ADAPTERS`）、产品检测路径、按产品规则标记被覆盖副本 |
| `server/hermes.mjs` | Hermes Agent：递归技能发现、来源（内置/Hub/归档/组织/外部目录/Profile）、停用、`.usage.json`、`state.db` 活跃度、Profile、插件、MCP 与设置行 |
| `server/openclaw.mjs` | OpenClaw 与 QClaw：安装定位、六级技能根与优先级、符号链接越界、ClawHub、远程同步元数据、Agent 列表、插件、MCP、会话用量与设置行 |
| `server/related-products.mjs` | 只读识别 LumiClaw / MotiClaw / Clawith 等“相关产品”（不是 Agent） |
| `server/insight-routes.mjs` | 洞察接口路由：Agent 文件、Agent 工具、用量、体检、应用图标（均只读、仅同站） |
| `server/agent-files.mjs` | 各 Agent 的指令、人格、身份、记忆、规则文件列表与脱敏读取（不透明 ID） |
| `server/agent-tools.mjs` | 各 Agent 的功能开关、工具集、MCP、连接器、插件命令、子代理与权限规则 |
| `server/hermes-toolsets.mjs` | 静态解析 Hermes `toolsets.py` 的 `TOOLSETS` 字面量（从不导入或执行 Python） |
| `server/usage-sources.mjs` | 用量来源：会话 JSONL 的逐行处理器（只取计数）与数据库/JSON 快照 |
| `server/usage-index.mjs` | 增量用量索引：按字节偏移续读、时间预算、去重、保留已删除会话的汇总 |
| `server/usage-query.mjs` | 用量查询：概览、单个技能、单个 Agent；标注来源与可信度 |
| `server/usage-service.mjs` / `server/usage-worker.mjs` | 在后台线程分片建立索引并报告进度 |
| `server/health-report.mjs` / `server/path-lookup.mjs` | 体检报告；不执行任何命令的 PATH 查找（含 nvm 识别） |
| `server/agent-icons.mjs` | 用 `sips` 把已安装 macOS 应用的图标转换为 128 px PNG 并缓存 |
| `server/git-tree.mjs` | 不依赖 git 计算目录的 git 树哈希（与 `skillFolderHash` 一致）、从 GitHub 树列表重建目录哈希、`skills-lock.json` v1 的 SHA-256 目录哈希 |
| `server/update-sources.mjs` | 只读本地来源事实：`.skill-lock.json`、lark-cli 安装与状态、Claude/Codex/WorkBuddy 插件登记、技能目录内的 SkillHub/ClawHub 元数据、git 检出 |
| `server/provenance.mjs` | 把技能副本、插件和 CLI 解析成“更新单元”（按真实路径与来源去重），并为无基线的来源记录首次快照 |
| `server/update-transport.mjs` | 更新检查的网络访问：主机白名单、请求预算、超时与大小上限、GitHub 额度跟踪、无 shell 的 `git ls-remote` |
| `server/update-check.mjs` | 各来源的检查器与三方判定（本地 ↔ 基线 ↔ 上游），离线与限流时保留上次结果 |
| `server/update-apply.mjs` | 更新执行：计划（10 分钟有效、单次）→ 确认 → 下载校验 → 备份 → 原子替换 → 改写锁；委托宿主 CLI 执行并返回脱敏输出 |
| `server/update-service.mjs` | 更新接口的状态、缓存文件、后台检查任务与公开视图 |
| `server/home-guard.mjs` | 写入保护：沙箱或测试环境中拒绝写入账户真实主目录 |
| `server/fs-links.mjs` | `lstat` 分类、内容哈希、相对链接；Windows 依次尝试 symlink → junction → 复制 |
| `server/library-agents.mjs` | 各 Agent 的分发档位（原生读取 / 配置目录 / 逐技能链接）与停用开关读取 |
| `server/library.mjs` | 技能库只读视图：条目类型、哈希、来源、按各产品规则的可见性模拟、问题列表 |
| `server/library-plan.mjs` / `library-ops.mjs` | 收编、链接、取消链接、停用、移除与批量整理的计划；可回滚的文件操作；回收站与恢复 |
| `server/library-switches.mjs` / `library-lock.mjs` | 各 Agent 原生停用开关的写入；`library-lock.json`（键排序） |
| `server/library-service.mjs` / `manage-routes.mjs` | 技能库与 CLI 工具的接口 |
| `server/cli-tools.mjs` / `cli-fixes.mjs` | CLI 工具卡片的检测（描述表驱动）与修复计划 |
| `server/restore-service.mjs` / `trash.mjs` | 历史记录、恢复（可再撤销）、单个 Agent 卸载；技能库与卸载共用的回收站 |
| `scripts/local-runner.mjs` | 源码模式下同时管理 Web 与本地服务 |
| `desktop/main.mjs` | Electron 生命周期、本地服务、窗口和导航安全 |
| `desktop/preload.cjs` | 受控的 renderer-to-main API |
| `desktop/dev-runner.mjs` | Electron 开发环境编排 |
| `worker/index.ts` | Web 构建入口 |
| `tests/` | 服务逻辑和页面壳回归测试 |
| `electron-builder.yml` | 桌面产物配置 |

## 扫描与聚合

1. `loadConfig()` 加载 `~/.agent-skill-manager/config.json`；第一次运行时检测内置
   Agent 目录。
2. `scanAll()` 遍历每个配置根目录，寻找含 `SKILL.md` 的 Skill 目录；未展示的
   Agent 只统计目录，不读取和哈希全部文件。
3. 对当前展示 Agent 的 Skills 解析 frontmatter 和正文，得到技术名称、优先中文
   展示名称、介绍和标签。
4. 后台 Worker 对目录内容计算 SHA-256 指纹，并记录文件数、体积、更新时间和
   软链接状态，避免扫描占用 Electron 主线程。
5. 仅针对当前“展示”的 Agents，以大小写不敏感的 frontmatter `name` 聚合实例。
6. 根据内容指纹和安装覆盖生成状态：
   - `synced`：所有展示中的 Agent 都已安装，内容一致；
   - `partial`：多个 Agent 已安装，但覆盖不完整；
   - `single`：只有一个 Agent 安装；
   - `conflict`：同名实例存在多个内容指纹。
7. 每个根目录和 Skill 目录都会解析 `realpath`：同一 Agent 经多个根目录到达的同一
   物理目录只保留一个实例（其余路径记入 `aliases`）；不同 Agent 共享同一物理目录时
   各保留一个实例，并标记相同的 `realPathId` 与 `sharedWith`。多个根目录解析到同一
   真实目录时写入 `sharedRoots`（如 `~/.mirasim/skills` 标记 `managedBy: "Mirasim"`）。
8. 扫描结果在内存中缓存 5 分钟；明确刷新、配置变化和写入完成会使缓存失效。
9. 文件路径、大小、修改时间未变化时复用
   `~/.agent-skill-manager/fingerprint-cache.json` 中的内容指纹；明确刷新会重新
   校验展示中的 Skills。

新增聚合字段时，应同步更新前端 TypeScript 类型、空状态、筛选逻辑和测试。

### 展示名称与介绍

- `displayName`：frontmatter 的 `display_name` / `displayName` / `title` / `name_zh` /
  `name-zh`（及少量兼容键）优先；否则取正文第一个 H1，且它必须出现在任何更深层标题
  之前、不超过 40 个字符；否则回退到技术名称 `name`。围栏代码块中的 `# ...`（如 shell
  注释）、H2/H3、列表和代码行都不会成为名称。
- `description` 始终是 frontmatter 描述；只有当它不是中文、而正文第一段普通段落
  （非标题、列表、表格、引用或代码，≤ 200 字符）是中文时，才另外提供 `descriptionZh`。
  frontmatter 的 `description_zh` 等键优先作为 `descriptionZh`。

## 常用 Agent 与状态模型

目标不是“把每个 Skill 装进每个 Agent”。用户通常装了很多 Agent，但主要使用一两个，
因此状态只针对“常用 Agent”判断：

- 配置新增 `primaryAgentIds: string[] | null`（`null` 表示尚未选择）。保存时过滤掉未配置
  的 ID、最多保留 4 个；类型错误（非数组或含非字符串项）返回 400；常用 Agent 总会并入
  `visibleAgentIds`。
- 扫描结果新增 `primaryAgentIds`、`suggestedPrimaryAgentIds`、`effectivePrimaryAgentIds`
  与 `agentActivity`。有效常用 Agent = 已选择的常用 Agent；未选择时用建议值中当前展示的
  Agent；仍为空则用全部展示 Agent。
- 建议值来自 `server/agents-activity.mjs`：只 stat 会话文件（Codex
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`、Claude Code
  `~/.claude/projects/*/*.jsonl`、WorkBuddy `~/.workbuddy/projects/*/*.jsonl`），
  最多遍历 20,000 个文件，不读内容。按近 30 天写入字节数 `bytes30d` 排序（后台自动化
  会抬高文件数和活跃天数），只在已配置的 Agent 中排名后取前 2 个，并去掉不足第一名 2%
  或近 30 天会话少于 3 个的 Agent。遍历从最新开始：Codex 日期目录按名称倒序，项目目录
  按修改时间倒序，先排序再截断；被截断时返回 `warnings`。Codex 恢复的会话会继续追加到
  原日期目录中的 rollout 文件（近 30 天写入的数据可能有相当一部分位于 30 天前、甚至近
  三个月前的日期目录），因此日期目录只在超过一年时才剪枝，而不是按 30 天窗口剪枝。
  `/api/agents/activity` 缓存 10 分钟，`?force=1` 刷新（5 秒内重复刷新会被忽略）。
- 每个 Skill 新增（旧字段 `status` 等保持不变）：
  - `primaryStatus`：`ok` 或 `differs`（常用 Agent 中非托管实例存在 ≥ 2 种内容指纹）；
  - `inPrimary`、`installedPrimary`、`missingPrimary`（缺失只是信息，不算问题）；
  - `newest`（`differs` 时）：两边都有 frontmatter `version` 时按版本比较，否则按修改
    时间；`behind` 为存在与 newest 不同副本的常用 Agent（同一 Agent 自身有不同重复副本
    时也会出现在其中）；`diverged` 仅在版本相同/缺失且修改时间也相同、无法排序时为 true；
  - `managed`：托管实例所在 Agent。只读托管：SmartOrder 插件/系统技能、Codex 插件缓存
    技能（`source: "codex-plugin-cache"`）、Codex 内置技能 `~/.codex/skills/.system`
    （带 `.codex-system-skills.marker`，`source: "codex-system"`）。托管但可写：
    `~/.codex/vendor_imports/skills`（`codex-vendor-import`）和
    `~/.mirasim/skills/synced/**`（`mirasim-synced`）。托管实例不参与 `differs` 和
    `duplicates` 计算；同步目标优先选择该 Agent 中可写、非托管的副本；Codex 只有
    `.system` 内置副本时，在用户技能目录新建一份（Codex 更新时会重写 `.system`），
    其他只有只读副本的 Agent 拒绝写入；
  - `newest` 只有在所有候选都带数字版本号时才按版本排序，否则统一按修改时间，保证比较
    可传递；
  - `duplicates: [{ agentId, count, identical }]`：同一 Agent 在多个不同真实目录中有
    同名、非托管的 Skill，`identical` 表示这些副本内容一致；
  - `descriptionZh`、实例上的 `version`、`source`、`managed`、`realPathId`、
    `sharedWith`、`aliases`。
- 扫描结果新增 `summary: { total, inPrimary, differs, duplicates: { total, identical,
  differing }, sharedRoots }`，其中 `duplicates` 只统计常用 Agent。`totals.installations`
  按真实目录计数，多个 Agent 共享的目录只算一次。
- 扫描在 Worker 中运行并带 60 秒看门狗；超时会终止 Worker 并返回友好错误（不会回退到主
  进程重扫），之后的扫描可以重试。Markdown 解析对输入长度和正则量词都有上限。

## 专家与 Agent Profile 发现

专家发现与普通 Skill 聚合分开执行，并通过 `/api/capabilities`、
`/api/capability-files`、`/api/capability-file` 和
`/api/capability-asset` 提供只读数据：

- WorkBuddy（`server/workbuddy-experts.mjs`）同时读取专家市场
  `~/.workbuddy/plugins/marketplaces/experts/plugins/<name>/`（`origin: "market"`）和
  用户自建的“我的专家” `marketplaces/my-experts/plugins/<name>/`（`origin: "mine"`），
  以及已安装副本 `plugins/cache/<marketplace>/<name>/<version>/`（带 `.in_use` 表示正在
  使用；只在缓存中存在的专家也会列出）。读取 `.codebuddy-plugin/plugin.json`、
  `agents/*.md` 和包内资源，优先使用中文名称与介绍，并返回 `version`、`installed`、
  `inUse`、`installedVersion`、`packaged`（`marketplaces/<marketplace>/dist/<name>.zip`
  存在）、`skills`、`defaultPrompt`、`quickPrompts`、`tags`（均优先中文）、`category`；
  所有目录都必须解析到 `~/.workbuddy/plugins` 之内；
- 专家和成员头像：清单的 `avatar`（单专家缺省时回退到 `avatars/expert.png`）与
  `members[].avatar`（按成员 `id` 与 agent 文件 `name` 对应）登记为不透明 ID，经
  `GET /api/expert-avatar?id=` 读取，安全模型与 `/api/plugin-asset` 相同：真实路径必须在
  专家目录内，只服务 PNG/JPEG/SVG 且不超过 2 MB，未知 ID 返回 404；
- 使用记录（尽力而为）：用 Node 内置 `node:sqlite` 以只读方式打开
  `~/.workbuddy/workbuddy.db`，只查询 `sessions` 表中 `expert_id` 的次数和
  `MAX(updated_at)`，从不读取标题或内容；忽略云端专家 `ex_…`；`OpcTeam` 这类 PascalCase
  与插件名 `opc-team` 归一化后匹配，返回 `used: { count, lastUsedAt }`。运行环境没有
  `node:sqlite`、数据库被占用或结构不符时跳过并给出警告；结果缓存 10 分钟；
- Hermes Profile 标记为 `origin: "profile"`；
- Hermes 从 `~/.hermes` 及 `~/.hermes/profiles/<name>` 识别默认 Agent 和命名
  Profile，以 `SOUL.md` 作为身份说明；
- Hermes 的“配置摘要”由服务端白名单生成，只包含模型、Agent、委派、显示、
  Terminal、Skills 和看板中的非敏感字段；
- `.env`、认证、凭据、Token、Secret、Session 和 `.git` 路径不会进入文件列表或
  内容预览；
- API 返回前移除真实根目录和服务端文件白名单，前端只能使用不透明 capability ID
  访问已验证的文件。

新增产品适配器时，应把“目录发现、元数据解析、允许预览的文件、安全摘要”封装在
服务端，并保持前端使用统一的 Capability 数据结构。

## 文件预览

文件列表和内容读取分为两个接口。服务会：

- 忽略 `.git`、`node_modules` 等目录；
- 使用 `realpath` 检查目标仍位于 Skill 根目录；
- 不跟随指向根目录之外的文件软链接；
- 把文件树限制在 1,500 个条目；
- 把界面内容预览限制在 2 MB；
- 通过独立的本地资源接口预览不超过 20 MB 的常见图片；
- 在返回 SVG 前阻止脚本、事件处理器、外部链接和可嵌入活动内容；
- 对疑似二进制文件只返回元数据。

Markdown 渲染在前端通过 `react-markdown` 和 `remark-gfm` 完成（`skipHtml`），
配置与代码预览由逐行分词后作为文本节点渲染，脱敏值 `••••••` 显示为“已隐藏”标记。
不要直接把 Skill 中的 HTML 注入 DOM。Agent 图标、插件图标和专家头像同样先经 CORS
请求取得再转成 Blob URL：直接用 `<img>` 跨端口加载会被 Chromium 的
`Cross-Origin-Resource-Policy` 拦截。图片资源只从当前 Skill 或短期导入预览目录读取，
接口会再次执行路径边界和真实路径检查，并使用限制性 CSP 返回 SVG。桌面界面先
通过本地 API 读取图片，再创建短期 Blob URL 交给 Chromium 解码；离开当前文件后
立即释放 URL，避免跨端口图片策略差异和长期内存占用。

“在文件管理器中定位”由本地服务按平台调用 `open -R`、`explorer.exe` 或
`xdg-open`。增加平台分支时必须继续使用参数数组调用进程，不能拼接 shell 命令。

## 同步事务

同步分为 `planSync()` 和 `executeSync()`：

1. 用户可以先通过 `/api/skill-diff` 比较文件增删改，再通过
   `/api/skill-diff-file` 查看文本逐行差异或图片并排预览；
2. 用户根据内容选择来源、目标和复制/软链接模式；
3. dry run 为每个目标生成 `create`、`replace` 或 `noop`；
4. UI 展示目标路径、指纹和备份位置；
5. 执行请求必须同时带确认请求头与 `confirm: true`；
6. 新版本先在目标的同级临时目录中完整生成；
7. `replace` 先复制到按时间分组的备份目录，再以同文件系统重命名切换新旧目录；
8. 切换失败时恢复旧目录；成功后再清理临时旧目录；
9. 写入本机 history，并让扫描缓存失效。

同步与导入计划会解析每个目标的真实目录（目标尚不存在时解析最近的已存在父目录），
执行时写入的正是计划中的 `realDestination`：

- 目标本身是软链接时“写穿”：备份并替换软链接指向的真实目录，软链接保持不变，
  `viaSymlink: true`。真实目录必须位于某个已配置 Agent 的技能根目录内，否则拒绝并给出
  中文说明；失效链接同样拒绝。`materializeSkillDirectory` 也拒绝直接覆盖软链接；
- 目标与来源互相包含时拒绝写入；
- 目标与来源是同一物理目录时规划为 `noop`，`reason: "same-directory"`，即使是软链接
  模式也不会把目录替换成指向自身的链接；
- 两个目标共享同一物理目录时只保留第一次写入，后者为 `noop`、
  `reason: "shared-with-target"` 并给出 `sharedWithAgentId`；
- 每个动作带 `realDestination` 与 `alsoVisibleTo`（写入后同样能看到该目录的其他
  Agent：根目录包含它，或扫描中有实例指向同一真实目录），计划带
  `sharedDestinations: [{ realPath, agentIds }]`；
- 复制模式不再整体解引用：只有真实目标仍在来源 Skill 目录内的软链接才会被复制为普通
  文件/目录；越界、失效、循环链接和特殊文件被跳过，计划与执行结果的动作上带
  `skippedLinks: [{ path, reason }]`，计划带中文 `warnings`。文件保留修改时间与权限位。

新增写入操作必须继续采用“计划 → 展示 → 明确确认 → 备份 → 执行 → 记录”模型。
差异接口保持只读，并继续使用真实路径检查、文件数量限制和内容预览上限。

## `.skill` 导入与导出

`.skill` 是包含单一 Skill 根目录的 ZIP。导入流程：

1. 读取原始 buffer，并限制上传体积；
2. 解压时累计条目数、单文件和总解压体积；
3. 规范化每个路径，拒绝绝对路径、盘符、空字节和 `..`；
4. 寻找 `SKILL.md`，拒绝多个根目录；
5. 解压到 `~/.agent-skill-manager/imports/<id>/`；
6. 在内存中登记短期 import ID，供文件预览和安装计划使用；
7. 用户确认后使用与同步相同的备份和写入原则安装。

导出会重新遍历已安装 Skill，只把根目录以内的普通文件写入 ZIP，并限制条目数、
单文件大小、总未压缩大小和最终压缩包大小，避免无界内存占用。

## 增加 Agent 目录规则

内置 Agent 定义位于 `server/local-server.mjs` 的 `AGENT_CATALOG`。新增规则应包含：

```js
{
  id: "example",
  name: "Example Agent",
  shortName: "EA",
  color: "#abcdef",
  paths: ["~/.example/skills"],
}
```

提交前请：

- 引用该工具的公开文档或可验证安装行为；
- 优先使用稳定、用户级的默认路径；
- 不扫描整个主目录；
- 避免与已有 Agent ID 和目录重复；
- 添加目录存在/缺失、聚合和默认可见性测试；
- 更新中英文 README 的支持表。

用户通过界面添加的自定义 Agent 会进入本地配置，不需要修改内置目录表。

## SmartOrder 本地适配

`server/smartorder.mjs` 使用 smol-toml 解析限定体积的 `.smartorder/config.toml`。
读取均校验真实路径和普通文件；解析失败仅返回通用错误，不输出解析器的原始行内容。
仅配置明确启用的插件可贡献技能目录。单个缓存版本或显式版本才能选定，市场和历史
缓存不参与扫描。插件 manifest 的相对技能目录也须位于对应版本根目录以内。
`scanAll()` 动态增加这些只读扫描源，不把它们加入用户的可写安装目标目录。
SmartOrder 的系统/插件实例带 `readOnly` 和来源标签，安装/同步计划拒绝覆盖。

`GET /api/connectors` 提供纯白名单 MCP 摘要，独立于专家目录。它不返回私有技能根路径、
原始配置或连接凭据，也不向连接器发送网络请求。新增 runtime 依赖应一并核验 Electron
安装产物能解析该模块。

## Hermes Agent 与 OpenClaw 家族

`AGENT_CATALOG` 中的 `hermes`、`openclaw`、`qclaw` 只在检测到产品文件时出现（Hermes：
`$HERMES_HOME` 或 `~/.hermes`；OpenClaw：`$OPENCLAW_STATE_DIR` 或 `~/.openclaw` /
`~/.clawdbot` / `~/.moltbot`；QClaw：`~/.qclaw/qclaw.json`）。它们的技能目录不是“一层
`SKILL.md` 文件夹”，所以 `server/agent-adapters.mjs` 的 `SKILL_ADAPTERS` 为每个产品返回
若干扫描源（各自的发现函数、来源标签、优先级、作用域），`scanAll()` 先合并这些源，再
用 `applyPrecedence()` 按产品自己的规则标记被覆盖的副本。环境变量只在扫描真实主目录时
生效，测试用的临时主目录不会被真实环境变量指回本机产品目录。

**Hermes**（对照 Hermes v0.20.2 `skill_utils`）

- 递归扫描 `skills/`，跟随软链接、按真实路径去重；跳过 `.git`、`.hub`、`.archive`、
  `venv`、`node_modules`，以及技能内的 `references/templates/assets/scripts`；
  `_org/<id>/` 只在 `.active_org` 指向该组织时参与。
- 额外根：`skills.external_dirs`（展开 `~` 与 `${VAR}`，不存在则跳过）。先出现者优先：
  本地目录先于外部目录，后者的同名副本标记 `shadowed`。每个
  `profiles/<name>/skills` 是独立作用域（实例带 `profile`）。
- 来源：`.bundled_manifest` → `hermes-bundled`（托管、可写，界面显示“内置”）；
  `.hub/lock.json` → `hermes-hub`（只读）；`_org` → `hermes-org`；外部目录 →
  `hermes-external`；`.archive/` → `hermes-archived`（只读，不参与状态统计，单独放在
  `scan.archivedSkills`）。
- `skills.disabled` → `disabled: true`；`skills.platform_disabled` → `disabledOn: [平台]`。
- `.usage.json` → 实例 `usage: { count, lastUsedAt, state, pinned, confidence: "recorded" }`。
- 安装目标 `$HERMES_HOME/skills/<name>`，只复制、不建软链接（`copyOnly`）；目标中已有同名
  Hub / 内置 / 组织技能时拒绝写入。
- 活跃度：只读打开 `state.db`（`mode=ro` + `PRAGMA query_only = 1`，不使用
  `immutable`），只聚合 `sessions` 表近 30 天的次数、token 与费用，不读取标题和 `messages`；
  没有数据库时退回 `.usage.json` 的最近使用时间。
- Profile 能力项：`SOUL.md` 摘要（脱敏）、`profile.yaml` 描述、模型（`base_url` 只取主机名）、
  技能数、定时任务数（只取名称、计划、启用）、记忆体积、网关状态（`gateway.pid` +
  `gateway_state.json`）、已启用插件。
- 从不打开 `.env`、`auth.json`（只在设置行里报告是否存在）和 `channel_directory.json`。
  版本取自 `hermes-agent/pyproject.toml` 或应用包，从不执行 `hermes --version`。

**OpenClaw**（对照 OpenClaw 2026.4.21 `loadSkillEntries`）

- 配置：`$OPENCLAW_CONFIG_PATH` 或 `<stateDir>/openclaw.json`（JSON5）；版本取
  `meta.lastTouchedVersion`，或已安装运行时的 `package.json`。
- 技能根（后者覆盖前者）：`skills.load.extraDirs` < 运行时内置 `openclaw-bundled`（只读）
  < `<stateDir>/skills`（`openclaw-managed`，安装目标）< `~/.agents/skills` <
  `<workspace>/.agents/skills` < `<workspace>/skills`。只扫一层，并识别嵌套的 `skills/`。
  每个 Agent 工作区是独立作用域。
- 真实路径离开所在根的软链接标记 `hiddenByProduct: "symlink-escape"`（产品不会加载，
  本应用仍展示），`allowSymlinkTargets` 列出的目标除外。
- `.clawhub/origin.json`（或 `.clawdhub`）→ `clawhub`（只读）；
  `skills.entries.<key>.enabled = false` → `disabled`；frontmatter
  `metadata.openclaw`（及旧键）中的 requires / os / emoji / install → `requirements`
  （只返回名称）。
- Agent：`agents.list[]` 或 `agents.entries`，都没有时隐含 `main`；作为能力项
  （`kind: "agent"`）返回 `IDENTITY.md` 名称与 emoji、工作区文件和体积，文件预览走脱敏管线。
- 插件：`openclaw.plugin.json`（运行时 extensions、`<stateDir>/extensions`）+
  `plugins.entries / allow / deny`；MCP：`mcp.servers`；设置行包含频道（名称与启用）、
  网关（mode / bind / port / auth.mode）和凭据文件（只报告是否存在）。
- 用量：`agents/<id>/sessions/sessions.json` 近 30 天的 token；再从至多 30 个、每个 ≤ 4 MB
  的会话 `jsonl` 中统计 `skills/<name>/SKILL.md` 路径出现次数（只取技能文件夹名，不保留
  其他内容），作为活跃度里的 `skillReads30d`，并附加到产品实际加载的那份副本：
  `usage: { count, confidence: "inferred", windowDays: 30 }`。
- `AGENTS.md` / `LUMICLAW.md` 中的 LumiClaw 标记与插件条目给出 `managedBy`。

**QClaw**：路径来自 `~/.qclaw/qclaw.json`（只取 `stateDir`、`configPath`、
`cli.openclawMjs`，且必须是主目录内的绝对路径；`sharedParams` 中的 guid / sessionId 从不
返回）。在 OpenClaw 规则之外增加 QClaw 配置技能、`~/.qclaw/skills`（`.remote-skills-meta.json`
的版本与来源 → `remote`）、`~/.qclaw/skillhub-skills`（`skillhub`）和工作区技能。第一版全部
只读，安装计划返回“QClaw 的技能由 QClaw 同步管理，请在 QClaw 里安装”。

**共享与写入**

- 多个产品经软链接指向同一物理技能（例如 `~/.openclaw/skills` 与 `~/.hermes/skills`
  链到 `~/.agents/skills`，再到 `~/.mirasim/skills`）时，按真实路径只计一次，并在
  `alsoVisibleTo` 中列出所有会看到这次写入的 Agent（包括 OpenClaw、QClaw、Hermes）。
- 本应用不向技能目录写入标记文件；安装记录只保存在 `~/.agent-skill-manager`。
  目前没有卸载功能。

**相关产品**：LumiClaw（编排）、MotiClaw（管理工具）、Clawith（平台）不是 Agent，只在
`/api/integrations` 的 `relatedProducts` 中列出 `{ id, name, kind, bundleId, version,
stateDir, notes }`。是否存在由各自的状态目录决定，应用包只用来补充版本；从不读取它们的
配置文件（LumiClaw 的 `config.json` 含令牌）。

## 办公小浣熊（SenseTime Office Raccoon）

`server/office-raccoon.mjs`，Agent id `office-raccoon`。应用 `办公小浣熊.app`（Bundle ID
`com.sensetime.desktop.raccoon`，版本取 `Info.plist` 的 `CFBundleShortVersionString`，图标走 agent-icons）。
应用数据在 `~/Library/Application Support/office-raccoon`：`settings.json` 的 `systemSetting.localAgentWorkspaceDir`
决定 Agent 工作目录（只接受主目录内的位置，默认 `~/.box-agent`），`memoryEntries` 是应用里的记忆条目；
`local-chat.sqlite3` 存对话。工作目录下：`skills/`、`config/{config.yaml,mcp.json,expert-profiles.json,
skill-settings.json,workspaces.json}`、`memory/`。`config/auth.json` 从不读取。检测：设置文件、工作目录的
`config/` 或应用包任一存在。

- **技能**（适配器，已对照应用 v1.0.17 的代码核实）：应用用 `readdir(withFileTypes)` 列出 `~/.box-agent/skills`，
  只保留 `isDirectory()` 为真且含 `SKILL.md` 的条目，所以软链接文件夹和散放的 `.md` 文件不会被加载——软链接副本
  标为 `hiddenByProduct: "symlink-not-followed"`，`.md` 文件与 `.backups` 不算技能；`skill-settings.json` 的
  `disabledSkillNames`（名称需匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`）是停用开关；应用包内
  `box-agent-runtime/bin/_internal/box_agent/skills` 是只读的内置技能。安装只能复制（`copyOnly`），技能库档位
  为“不分发”（见 docs/LIBRARY-UPDATES-CLI.md §1.2），停用操作写 `disabledSkillNames`（先备份、可撤销）。
- **专家**：`config/expert-profiles.json` 的 `experts` 与 `teams` 进入专家视图（`productId: "office-raccoon"`），
  每项带 `skillDependencies: { required, default, optional, missing }`（`missing` 为本机用户技能与内置技能里都没有
  的依赖），团队成员带各自的 `skills`；文件视图是一份脱敏后的 `profile.md`；`expert-profiles.json.bak-*` 不读取，
  只计数为 `backupCount`。
- **配置详情**：只给安全的标量行（模型、服务提供方、接口地址只显示主机名、API 密钥只显示“已配置”、记忆开关与
  天数、文件访问范围、MCP 服务名、停用的技能、工作区数、记忆条目数）。
- **Agent 文件**：`memory/MEMORY.md`、`memory_summary.md`、`CONTEXT.archive.md`、`memory/context/**`、
  `memory/v2/**`（`.md`/`.json`，有上限）；`settings.json` 的 `memoryEntries` 逐条列为“记忆条目 n.md”（虚拟文件，
  只渲染这条记忆的来源、时间与正文，经脱敏，不暴露设置文件本身）。
- **用量**：`local-chat.sqlite3` 的 `messages.payload_json` 里每轮 `usage_metadata.token_usage`
  （`promptTokens`/`completionTokens`/`totalTokens`/`calls`）与 `skill_invocations[].skill_code`、`used_skill_codes`；
  只取这些数字和技能名，正文从不读取。会话按 `sessions.created_at_ms` 记日、`last_chatted_at_ms` 为结束日，项目取
  `workspace_dir` 的最后一段。没有模型信息，token 记为未定价（`unpricedTokens`），可信度 reported。

## Agent 集成：插件、连接器与 MCP（只读）

这些扫描器只读本机文件、不联网、不写入，返回前去掉所有配置值：

- **Codex 插件**（`server/codex-plugins.mjs`）：读取 `~/.codex/config.toml` 的
  `[plugins."name@marketplace"].enabled` 与 `[marketplaces.*].source_type`（不返回
  source），以及 `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/.codex-plugin/plugin.json`。
  多个版本目录时优先真实目录（`latest` 等软链接仅列入 `versions`），再取修改时间最新者。
  配置与缓存按 `name@marketplace` 精确匹配；只有缓存、没有配置的插件为
  `enabled: "unknown"`，缓存存在不代表已启用；配置有但无缓存的为 `installed: false`。
  插件目录、清单、技能目录、`.mcp.json`、`.app.json` 和图标都必须通过真实路径检查留在
  缓存/版本目录内；清单上限 256 KB，配置上限 2 MB。
- **Codex 连接器**：读取 `~/.codex/cache/codex_apps_tools/` 中修改时间最新的 JSON
  （上限 20 MB，超限或损坏时返回警告），按 `connector_id` 聚合工具数和前 20 个工具名，
  并用插件 `.app.json` 反查 `providedByPlugins`。不读取 `codex_app_directory`，不返回
  `server_origin`。
- **Claude Code 插件**（`server/installed-plugins.mjs`）：读取
  `~/.claude/plugins/installed_plugins.json`（v2）、`known_marketplaces.json`
  （仅来源类型）和 `~/.claude/settings.json` 的 `enabledPlugins`。`installPath` 必须解析到
  `~/.claude/plugins` 内，否则跳过；统计 skills、agents、commands、hooks 与 MCP 名称。
  只有 user 作用域能从用户设置判断启用状态；local/project 作用域以及设置中未出现的插件
  为 `enabled: "unknown"`（不打开项目内的设置文件）。
- **WorkBuddy 插件**（同一模块）：读取 `~/.workbuddy/plugins/installed_plugins.json`
  （与 Claude Code 相同的 v2 结构）和 `~/.workbuddy/settings.json` 的 `enabledPlugins`，
  清单为 `<installPath>/.codebuddy-plugin/plugin.json`（`displayName` 可为 `{en,zh}`）；
  `installPath` 必须在 `~/.workbuddy/plugins` 内。来自 `experts` / `my-experts` 市场的条目
  标记 `kind: "expert"`，其余为 `kind: "plugin"`。
- **MCP 清单**（`server/mcp-inventory.mjs`）：Codex `[mcp_servers.*]`、Claude Code
  `~/.claude.json` 顶层与 `projects.<path>.mcpServers`（`scope: "project"`，路径以 `~`
  表示；该文件上限 30 MB，只读一次、从不写入）、Cursor `~/.cursor/mcp.json`、Gemini
  `~/.gemini/settings.json`。每个服务器只返回名称、作用域、传输类型、HTTP 主机名、
  启用标记和 `secretFields`——疑似含明文密钥的**字段位置**（如 `headers.X-API-Key`、
  `env.TOKEN`、`args[2]`、`url.userinfo`、`url.query.key`、`url.path`），从不返回值。
  规则（`server/secret-fields.mjs`）：`headers`/`http_headers`/`env` 下的每个字面量值都算；
  其他位置按键名（大小写与驼峰无关，如 `access_token`、`clientSecret`、`Authorization`）
  或值形态（`Bearer …`、`ghp_`、`github_pat_`、`sk-`、`xox…`、JWT、≥ 24 位高熵串）判断；
  参数中识别 `--flag=value`、`--flag value`、`KEY=VALUE`、`Header: value` 和带凭据或
  令牌查询的 URL；URL 检查 userinfo（用户名也算）、敏感查询参数和令牌状路径段；嵌套
  对象最多 4 层。整个值只由 `${VAR}`、`${env:VAR}`、`{env:VAR}`、大写 `$VAR`（可带
  `Bearer ` 前缀）组成时视为环境变量引用、不算明文。`secretFields` 按上述保守规则列出
  全部字面量位置；`likelySecretFields` 只保留键名或值形态像凭据的位置（以及 URL、参数
  命中），供界面重点提示。命令、参数、完整 URL 都不返回。
  另提供按名称跨 Agent 的 `matrix`。

插件图标通过不透明 ID 访问：`/api/plugin-asset?id=<24 位十六进制>` 只服务最近一次
集成扫描时由插件清单 `interface.logo` / `logoDark` / `composerIcon` 引用、位于该版本
目录内的 PNG/JPEG/SVG，≤ 2 MB；它不会触发重扫，未知 ID 返回 404。插件 SVG 只应通过
`<img>` 使用；服务端仍复用安全过滤（另外拒绝带命名空间前缀的 script、`<set>`/`<animate*>`、
`image-set(` 以及样式中的反斜杠转义），并以 `sandbox` CSP 和 `nosniff` 返回。

集成扫描使用单飞缓存（60 秒，`?force=1` 刷新，5 秒内重复强制刷新会被忽略）。每个扫描器
相互隔离：某个扫描器失败只会让对应部分为空并附带通用警告，`/api/connectors` 中
SmartOrder 部分照常返回、`codex` 部分为 `{ available: false, warnings }`。

## 配置详情（只读、脱敏）

`GET /api/config-detail?kind=<kind>&id=<id>[&instance=<instanceId>]` 返回
`{ title, rows: [{ label, value }], files: [{ path, label, language, text, truncated }], location }`：

- `kind=agent`（`codex` / `claude` / `workbuddy` / `gemini` / `cursor`）：只有中文设置行，
  不返回文件（完整配置含密钥和项目列表）。Codex：模型、推理强度、审批策略
  （`never` →“从不询问（never）”、`on-request` →“需要时询问”、`on-failure` →
  “失败后询问”、`untrusted` →“只放行已知安全命令”）、沙箱模式（`danger-full-access`
  →“完全访问，不使用沙箱”、`workspace-write` →“只能写当前工作区”、`read-only` →
  “只读”）、功能开关、MCP 服务数、已启用插件数、插件市场、Hooks 事件
  （`~/.codex/hooks.json`）、受信任项目数、Shell 环境变量（只计数）、MCP 凭据存储。
  Claude Code：允许/拒绝/询问规则、默认权限模式、Hooks 事件、已启用插件、额外插件市场、
  跳过危险模式确认、状态栏、主题、MCP 服务数、环境变量（只计数）。WorkBuddy：沙箱
  额外可写目录数、沙箱规则数、网络默认拒绝迁移、插件启用数、已安装插件数、Hooks 事件。
  Gemini、Cursor 只给模型/认证方式/主题/MCP 等安全字段。
- `kind=mcp&id=<服务名>`：每个配置了该服务的 Agent 一个文件，按原生格式渲染该服务自己的
  段落（Codex 为 TOML `[mcp_servers.<name>]` 及子表，Claude/Cursor/Gemini 为 JSON
  `{ "<name>": {...} }`），值经默认拒绝脱敏（见下）。行：服务名、配置在、连接方式、地址
  （只给主机名）、启用状态、提醒（如“请求头里写着密钥”）。
- `kind=expert&id=<capabilityId>`：类型、名称、技术名、版本、职业、成员、最大轮次（来自
  agent 文件 frontmatter `maxTurns`）、依赖技能、开场提示、快捷提示、标签、来源、安装状态、
  分发包、使用记录、位置；文件为 `.codebuddy-plugin/plugin.json` 和 `agents/*.md`
  （各 ≤ 20 KB，超出截断并标记）。Hermes Profile 返回模型、轮次、委派和 `SOUL.md`。
- `kind=plugin&id=<agent>:<name@marketplace>`：插件信息行，加上整个清单（含 lspServers、
  hooks、userConfig、settings 和未知字段）的脱敏 JSON，以及清单声明的 JSON 文件
  （`mcpServers` 为字符串时、`.mcp.json`、`apps`、字符串形式的 `hooks`）——它们必须解析到
  插件目录内、文件名不能是敏感名（`.env*`、`*.pem`、`*.key`、`id_*`、`.npmrc`、`.netrc`、
  `auth*.json`、`credentials*`、`settings.json` 等），且只接受 `.json`，读取后解析并脱敏，
  从不原样返回。
- `kind=skill&id=<skillId>&instance=<instanceId>`：frontmatter 顶层字段（敏感键名直接
  脱敏，其余值经自由文本脱敏；嵌套字段只标注）加所属 Agent、来源、内容指纹、位置，以及
  脱敏后的 `SKILL.md`（≤ 64 KB，超出截断）。

**默认拒绝脱敏**（`server/config-mask.mjs`，用于 MCP 段落、插件与专家清单、声明的 JSON
文件、Hermes 配置摘要和专家文件预览中的 JSON）：键名总是显示；标量值只有属于以下白名单才
显示，否则一律为 `••••••`——布尔值、≤ 6 位整数、已知枚举词（日志级别、传输方式、Codex /
Claude 的策略值等）、纯环境变量引用、颜色值、主机名（含端口）、URL（只保留协议、主机和
不像令牌的路径段；userinfo、`;参数`、整个查询串和片段被遮盖；任何 `scheme://` 都按 URL
处理，包括 postgres、mongodb+srv、redis、ssh、git+https 及前导空格）、不含 `@ = ? :` 的
绝对路径 / `~/` / Windows 盘符路径（像令牌的路径段被遮盖）、已知标识键（model、type、
transport、name、version、scope、category、provider 等）下不像令牌的标识符，以及已知描述键
（description、displayName、keywords、tags、author.name 等）下经自由文本脱敏的文字。
键名匹配 auth / secret / token / credential / cookie / session / header / password /
pass / pwd / passphrase / pat / dsn / key / creds / salt / hmac / private 的整棵子树都被
遮盖（纯环境变量引用除外）；`env` 对象与 `["K=V"]` 数组中的值同样只按白名单显示；
`*_env_var`、`env_vars`、`env_http_headers` 只显示形如 `UPPER_SNAKE` 的变量名。
`args`、`command`/`cmd`/`*_args` 会被令牌化（支持简单引号）：`--flag=value` 拆开后重新
判断（`--env=K=V` 与 `-e K=V` 一致），`-e -p -u --user --pass --password --passphrase
--token --api-key --key --secret --header -H --env --database-url --url --dsn --cookie` 及
名称命中敏感词的参数会遮盖后一个值，`K=V` 只在白名单内显示值，`Header: value` 遮盖值，
`-pX`、`-eFOO=X`、`-u admin:X` 也会处理。每个字符串上限 8 KB，每个渲染文件上限 64 KB
（超出时 `truncated: true`）。

**自由文本脱敏**（`server/redact.mjs`，用于 SKILL.md、agents/*.md、SOUL.md、描述、
frontmatter 行、权限规则和状态栏命令，所有对外文本字段也会经过它）：PEM 私钥块、任意协议
URL 中的 userinfo、敏感名赋值（`API_KEY=…`、`"password": "…"`、`X-Api-Key: …`、
`Authorization: Bearer …`）、“key is X / 密钥是 X”这类说明中像令牌的值、命令行中的
`-u user:pass` 与 `-H "Name: value"`，以及 AWS、Slack、Stripe、GitHub、OpenAI/Anthropic、
JWT、Google 等令牌格式；`Bearer`/`Basic` 只有后面跟着 ≥ 16 位令牌字符时才会被遮盖。所有
正则都有上限、线性执行。Claude 权限规则会拆出工具名和括号内的命令再逐个令牌脱敏，命令中的
`NAME=value` 赋值一律遮盖；状态栏命令同样处理。

所有文件都经过真实路径包含检查和体积上限；所有返回字符串都会去除 `\p{Cf}`，并在序列化
前后把主目录替换为 `~`（同时识别 `C:\Users\x`、`C:/Users/x`、JSON 转义的
`C:\\Users\\x` 和大小写不同的盘符，不会误替换 `/Users/xyz` 这类前缀相同的路径）。
`~/.claude.json` 等 MCP 来源解析结果缓存 30 秒。找不到对象返回 404，参数无效返回 400。

`/api/capability-file` 读取 WorkBuddy 专家与 Hermes Profile 文件时使用同一套管线：JSON
解析后默认拒绝脱敏，其他文本经自由文本脱敏；`.mcp.json`、`.npmrc`、`.netrc`、`*.pem`、
`*.key`、`id_*` 等敏感文件不会出现在列表中，也无法读取。Hermes 文件用有上限、FIFO 安全的
方式读取，配置摘要中的模型提供方等值同样经过白名单。

## 洞察接口（只读）

以下接口都只读、只接受同站请求（`Sec-Fetch-Site: cross-site` 返回 403），错误统一为
`{ error }`，状态码 400 / 403 / 404。返回内容中的路径一律压缩为 `~/…`，不会出现主目录。

### Agent 文件

`GET /api/agent-files?agent=<id>[&profile=<name>][&agentId=<OpenClaw agent>]`

```ts
{
  agentId: string,
  groups: Array<{
    id: string,               // instructions | rules | memories | memory-summaries | agents | commands |
                              // identity | persona | cron | workspace | memory | agent-state | state
    label: string,            // 中文分组名
    note?: string,            // 例如 "由 LumiClaw 写入"
    files: Array<{
      id: string,             // 24 位十六进制不透明 ID
      name: string,
      kind: "instructions" | "persona" | "identity" | "user" | "memory" | "tools" | "heartbeat"
          | "bootstrap" | "lessons" | "rules" | "other",
      size: number,           // 字节
      modifiedAt: string,     // ISO
      displayPath: string,    // "~/.codex/AGENTS.md"
      note?: string,
    }>,
  }>,
  profiles?: string[],        // 仅 Hermes："default" 与 ~/.hermes/profiles/* 名称
  profile?: string,           // 仅 Hermes：当前 profile
  agents?: string[],          // 仅 OpenClaw/QClaw：配置中的 agent 与 <stateDir>/agents/* 目录
  agentId?: string,           // 仅 OpenClaw/QClaw：当前 agent（注意与顶层 agentId 同名，值为子 agent）
  capabilities: Array<{ capabilityId, name, kind, origin }>, // 可在 /api/capability-files 查看的专家/Profile/Agent
}
```

分组由声明式规则生成（`specGroups`：已知的人格 / 记忆文件名 + 已知子目录的有界扫描）。
来源（只列出存在的文件）：Codex `~/.codex/AGENTS.md`、`AGENTS.override.md`、`rules/*.rules`、
`memories/*.md`、`memories/rollout_summaries/*.md`（最近 50 个）；Claude Code `~/.claude/CLAUDE.md`、
`projects/*/memory/*.md`（最近 50 个）、`rules/**/*.md`（4 层、200 个）、`agents/*.md`、`commands/` 下两层内的 `*.md`；
WorkBuddy `~/.workbuddy/{SOUL,IDENTITY,USER,MEMORY,AGENTS}.md`（全局）与账号目录
`user-<id>-personal/{SOUL,IDENTITY,USER,MEMORY}.md`（没有设置标明哪一份生效，两份都列出并加说明）、
`memory/*.md`（不含 `.bak`）、`automations/*/memory.md`（“自动化记忆”）、`plans/*.md`（“计划”）；
办公小浣熊见上文；Gemini `~/.gemini/GEMINI.md`；
Cursor `~/.cursor/rules/**/*.{md,mdc}`；Hermes（按 profile）`SOUL.md`、`AGENTS.md`、`profile.yaml`、
`memories/*.md`、`cron/jobs.json`（只渲染名称、计划、状态、技能、工具集、上次/下次运行，不含提示词、
脚本、错误与投递目标）；OpenClaw/QClaw 工作区 `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、
`USER.md`、`TOOLS.md`、`HEARTBEAT.md`、`BOOTSTRAP.md`、`BOOT.md`、`MEMORY.md`、`memory/*.md`
（最近 50 个，含 `YYYY-MM-DD.md`），`<stateDir>/agents/<id>/` 下两层内的 `*.md`（如 `LESSONS.md`；凭据与会话
不列出）、`<stateDir>/{AGENTS,LUMICLAW}.md` 与 `<stateDir>/.lumiclaw/*.md`（“LumiClaw 任务”）。不带 `agentId`
时列出所有 agent（最多 30 个）的工作区与目录，分组 id 带 `:<agent>` 后缀（如 `workspace:lumi`、`agent-state:ceo`），
另含 `agents.defaults.workspace`（默认 `<stateDir>/workspace`）的 `workspace:default` / `memory:default`；带
`agentId` 时只列这个 agent，分组 id 不带后缀。工作区必须位于主目录内。

`GET /api/agent-file?id=<id>`

```ts
{ name: string, language: "md" | "yaml" | "json" | "text", text: string, truncated: boolean, redactions: number }
```

读取时重新校验：真实路径必须在登记的根目录内（软链接指向外部会被拒绝）、必须是普通文件、
以 `O_NONBLOCK` 打开（FIFO 不会阻塞）、最多 512 KB（超出时 `truncated: true`）。`.env*`、
`auth*.json`、`credentials*`、`*.key`、`*.pem`、含 token/secret/session 等字样的文件名一律不列出也不读取。
Markdown 与文本经自由文本脱敏（`redactions` 为本次新增的遮盖数）；YAML/JSON 先解析再按默认拒绝规则
遮盖，解析失败时退回为脱敏文本。ID 在服务重启后仍可用（未命中时会重新列出所有 Agent 的文件）。

### Agent 工具

`GET /api/agent-tools?agent=<id>`

```ts
{
  agentId: string,
  groups: Array<{
    id: string, label: string, source: string,   // source 为 "~/.codex/config.toml" 等说明文字
    items: Array<{
      name: string,
      description: string,                       // 脱敏、≤ 300 字
      kind: "builtin" | "toolset" | "mcp" | "connector" | "plugin-command" | "subagent" | "permission" | "feature",
      enabled: boolean | null,                   // null 表示未知或不适用（如 ask 规则）
      tools?: string[],                          // 连接器或工具集包含的工具名（≤ 50）
    }>,
  }>,
  notes: string[],
}
```

Codex：`[features]` 开关、已连接应用及其工具名（`~/.codex/cache/codex_apps_tools`）、MCP 服务（工具清单只在
运行时获取，标注“未缓存工具清单”）、插件提供的技能与命令。Claude Code：`settings.json` 的
`permissions.defaultMode` 与 allow / ask / deny 规则（参数部分按配置详情的规则遮盖；allow 为 `true`、
deny 为 `false`、ask 为 `null`）、MCP、子代理、命令、插件命令与子代理。WorkBuddy：
`mcp-tool-list.json` 中按服务摘要分组的工具（无法对应到服务名，组名为摘要前 8 位）、连接器名称与开关
（只读 `connectors/<账号>/connector-states.json` 的 `connectors`，不读 header/env 覆盖与凭据文件）、插件。
Hermes：静态解析的全部工具集（`enabled` 表示配置启用或被其包含）、启用工具集的工具、
`command_allowlist`（遮盖后）、MCP、插件。OpenClaw/QClaw：`tools.profile`、allow / alsoAllow / deny、
`tools.<分区>.<名称>.enabled`、`browser.enabled`、MCP、插件（插件清单不声明工具，列出频道与技能）。

### 用量分析

索引文件：`~/.agent-skill-manager/usage-index.json`（权限 0600）。只保存计数与汇总：每个会话文件的
字节偏移、大小、修改时间、头部摘要、按天的 `[会话数, 输入, 输出, 缓存读, 缓存写, 合计]`、按天的技能次数、
工作目录名（只取最后一段）；每个数据库会话的日期、token 与费用；消息 ID 只以 12 位摘要保存，用于识别
续接/分叉会话复制的旧消息。消息正文、工具参数与输出、标题从不写入。文件键为路径摘要，不含路径。

索引版本 2（`USAGE_INDEX_VERSION`，旧索引自动全量重建）另按模型保存 token，用于按官方价格估算费用：
每个文件的 `m`：`模型 → 日期 → 分档 → [未缓存输入, 输出, 缓存读, 缓存写（5 分钟）, 缓存写（1 小时）, 请求数]`；
`km`：`技能 → 模型 → 日期 → 分档 → [...]`（Claude `attributionSkill`）；数据库会话记录另有 `m`（模型）、
`b`（分档）、`n`（请求数）、`rc`（产品自报费用）。模型 id 只保存匹配 `/^[\w.:@/<>-]{1,80}$/` 且不像凭据的
字符串，否则记为 `unknown`；`<synthetic>` 不记。分档 = 提示大小档 `s`（≤200K）/ `l200`（≤272K）/
`l272`（≤512K）/ `l512`（>512K），提示 = 未缓存输入 + 缓存读 + 缓存写（每次请求）；价格条目带 `offPeak`
的模型在峰时以外再加 `:off`；Claude `usage.speed === "fast"` 加 `:fast`。数据库会话没有单次提示大小，
只记 `s` 和 `:off`。价格在查询时计算，换价不需要重建索引。

| 来源 | token | 技能 | 可信度 |
| --- | --- | --- | --- |
| Claude Code `~/.claude/projects/**/*.jsonl`（含子代理） | assistant 消息 `usage`（按消息 ID 全局去重）；模型 `message.model`；`cache_creation.ephemeral_5m/1h_input_tokens` 拆分缓存写 | `Skill` 工具调用（按调用 ID 去重）；`attributionSkill` 的 token | exact |
| Codex `~/.codex/sessions/**`、`archived_sessions/*` | `token_count` 累计值的差；分叉/续接会话的首条与回退后只计 `last_token_usage`；`input_tokens` 含缓存读与缓存写，未缓存 = 输入 − 缓存读 − 缓存写；模型取最近一条 `turn_context.payload.model` | 函数调用参数中出现的 `skills/<名称>/SKILL.md`（从不看输出） | token exact，技能 inferred |
| WorkBuddy `~/.workbuddy/projects/**/*.jsonl` | `message.usage`（输入扣除缓存命中）；模型 `providerData.model` | `Skill` 调用；`usage-log.json` 的使用日期补足未覆盖的日子 | exact / reported |
| WorkBuddy `workbuddy.db` | — | — | `session_usage.credit_json` 合计为 `credits`（reported） |
| Hermes `state.db` | `sessions` 表 token、`model`、`api_call_count` 与自报费用（只读、`query_only`）；`input_tokens` 已扣除缓存，`reasoning_tokens` 是 `output_tokens` 的子集（Hermes 源码 `cli.py` 标为 “Reasoning (subset)”） | `skills/.usage.json` 计数，每次运行的增量计入当天 | reported |
| OpenClaw/QClaw `sessions.json` | 会话 token 与费用；有 `model`（及 `modelProvider`）时记模型 | 会话 JSONL 中工具调用读取的 SKILL.md | token reported，技能 inferred |
| 办公小浣熊 `local-chat.sqlite3` | 每轮 `usage_metadata.token_usage`（无模型，不计价） | `skill_invocations` / `used_skill_codes` 按天计数 | reported |
| Codex `~/.codex/state_<n>.sqlite` 的 `threads`（会话记录文件已删除、索引里也没有的线程） | 每个线程一个总数 `tokens_used`，按本机已索引会话中该模型（否则全部 Codex）的输入 / 输出 / 缓存读 / 缓存写比例拆分；没有可参考的会话时只计 tokens 不计价 | — | estimate |

每轮索引有 3 秒预算，按修改时间从新到旧处理，每轮至少推进一个文件；服务在后台线程中连续分片执行直到
完成，此后请求发现索引超过 60 秒未更新时再增量刷新。会话文件被产品删除后其汇总仍保留（保留 400 天）；
文件被截短或头部变化时重新统计该文件。量级参考（示例：数千个会话文件、数十 GB）：首次索引在一分钟左右，
增量刷新约 0.1 秒，索引文件为 MB 级；按官方价计算 30 天费用为数十毫秒。
Codex 续接 / 压缩后的会话可能在第一条 `turn_context` 之前就有用量：先记为 `unknown`，拿到模型后移到该模型下。

**Codex 数据库里的线程**。Codex 已把会话迁入 `state_<n>.sqlite`（取编号最大的一个），并删除旧的 rollout 文件。每轮索引在处理完
会话记录文件后，只读 `threads` 的 `id`、`rollout_path`（文件名即会话记录的索引键）、`created_at(_ms)`、`updated_at(_ms)`、
`model`、`cwd`（只取文件夹名）、`tokens_used`、`source`（只看是不是派生的子代理），以及 `thread_spawn_edges` 的子线程 id；
从不读标题、首条消息、预览或 `thread_history` 的条目，最多 50,000 行。rollout 文件还在或索引里已有这个文件（包括已删除但保留了
汇总的）的线程跳过，所以不会重复计算；记录每轮重建，之后被索引的 rollout 会取代对应记录。
- 日期：用 `created_at`。在已索引的会话里，一个线程的 tokens 有 54% 落在创建当天、35% 落在最后更新当天，所以只能选一天时
  创建日更接近；`updated_at` 记为结束日，用于“窗口内活跃的会话”。
- 计价：basis 为 `estimate`，费用行带 `reason`（“Codex 已把会话迁入数据库，只剩总 tokens，按本机历史比例拆分估算”）；
  价格档位按提示长度最小的一档。
- 子代理线程（`thread_spawn_edges` 的子线程，或 `source.subagent.thread_spawn`）：它的 `tokens_used` 从父线程复制来的上下文
  开始累计，数据库里没有可以拆出自身用量的字段（实测：与父线程相减、按创建时间插值都偏差数倍），所以只计会话、不计 tokens，
  总数另存为 `i`（不计入任何合计）。
- `/api/usage/summary`（每个 Agent）、`/api/usage/agent`、`/api/usage/totals`（`byAgent`）带 `notes: [{ kind: "codex-db-estimate",
  text, sessions, tokens, spawnedSessions, uncountedTokens, unpricedTokens }]`，界面据此说明这部分是估算。

**会话数 = 窗口内活跃的会话**（`server/usage-sessions.mjs`）：会话在某天开始、用了 token 或调用 / 读取了技能，就算
那天活跃；窗口的 `sessions` 是至少活跃过一天的不同会话数，所以更早开始、仍在使用的长会话也算。子代理等嵌套
记录（`<目录>/<会话>/subagents/*.jsonl`，索引项的 `s`）的活动算在父会话上；`sf` 标记文件是不是会话本身（旧
索引项没有时，以记录过会话开始为准）。数据库会话在开始那天活跃，Hermes 有 `ended_at` 时结束那天也算（记录的
`e`）；token 和费用仍记在开始那天。按天序列里一个会话在它活跃的每一天各计一次（各天相加会大于窗口合计）。
原来按开始日的计数保留为 `sessionsStarted`；`activeDays` 不变（有会话开始或有 token 的天数）。项目里一个会话
在它工作过的每个项目各计一次（父会话与子代理在不同文件夹时两边都算）。首页 Agent 卡片的“近 30 天 N 个会话”
来自 `/api/agents/activity`：转录类 Agent 按会话文件在窗口内被修改过计数，Hermes 改为按
`COALESCE(ended_at, started_at)` 落在窗口内计数，口径同为“窗口内活跃”。

`GET /api/usage/status`

```ts
{ state: "idle" | "indexing" | "partial" | "complete" | "error", indexedFiles, totalFiles, indexedBytes, totalBytes,
  lastRunAt: string | null, lastRunMs: number | null, updatedAt: string | null, error: string | null }
```

#### 预估费用（按各厂商官方 API 价格）

价目表 `server/pricing/model-prices.json`（随应用打包，人工核对，每条带官方来源；单位 USD / 1M tokens）；
规则在 `server/pricing.mjs`（纯函数 `normalize`、`resolve`、`priceFor(entry, day, bucket)`、`costOf`、
`isOffPeak(schedule, timestamp)`、`bucketFor`），查询时的汇总在 `server/usage-cost.mjs`。加载时校验表结构
（价格为非负数、别名不重复、长上下文阈值必须是索引分档 200K / 272K / 512K 之一、估算与系列指向存在的模型、
时段存在），不合格直接报错。

- 解析顺序：精确 id → 别名 → `estimates` → `families`（按数组顺序，先具体后宽泛）→ 未定价。id 先小写、去掉
  `provider/` 前缀，找不到时再去掉结尾日期（`-20251001`、`@20251101`、`-2026-04-23`）匹配一次。带 `agent` 的
  估算只对该 Agent 生效（WorkBuddy `auto`）。
- 单价：先按使用日应用 `changes`（如 Gemini Flash 2027-01-01 起），再按分档应用 `long`（提示超过 `above`
  时整次请求所有 token 都按长上下文价），再应用 `offPeak`（DeepSeek，按请求时间，`schedules` 为 UTC 峰时，
  结束小时不含），然后补缺：缓存读、缓存写缺失按输入价，1 小时缓存写缺失按缓存写价；最后 `:fast` 乘 `fast`
  （只有带 `fast` 的模型）。
- 费用 = 未缓存输入 × 输入价 + 输出 × 输出价 + 缓存读 × 缓存读价 + 缓存写 × 缓存写价 + 1 小时缓存写 × 1 小时
  缓存写价。输出含思考 token。Batch、区域加价（Claude `inference_geo`，通常为 not_available）、缓存存储费、
  服务档位都不计。订阅内的用量同样按 API 等价估算，不等于实际支出。
- `@agent-average`（WorkBuddy `auto`）：每种 token 按同一窗口内该 Agent 其他已定价模型的 token 加权平均单价计
  （缓存读 / 写没有样本时按平均输入价）；没有可平均的模型时依次用估算的 `fallback` 模型（`auto` 为 `glm-5.2`，
  WorkBuddy 常见的默认模型）、id 的系列、产品自报费用，否则未定价。加载时校验 `fallback` 指向存在的模型。
- 复核日期：模型条目可带 `reviewBy`（YYYY-MM-DD，促销 / 预览价的复核日，如 `gpt-5.6-sol` 2026-11-21、三个
  Gemini Flash 促销价 2026-12-31）；表头 `reviewAfterDays: 90`。本地日期晚于 `reviewBy` 的条目列入
  `pricingStale`，`checkedAt` 距今超过 `reviewAfterDays` 天时 `tableStale` / `pricingTable.stale` 为 true，
  界面据此提示“价格可能已变，请核对”。
- 数据库会话（Hermes、OpenClaw、QClaw）：有可定价模型时按官方价估算，产品自报的费用另列为 `reportedCostUsd`；
  没有模型或模型未定价时用产品自报费用（`basis: "reported"`）。
- 依据 `basis`：`official` | `estimate` | `family` | `reported` | `unpriced`（未定价的 token 计入 `unpricedTokens`，
  不计费用）。金额保留到 0.000001 美元。
- 项目费用（`server/usage-projects.mjs`）：项目 = 索引里保存的工作目录最后一段（从不返回完整路径），所以不同位置的
  同名文件夹会合并成一个项目；没有工作目录的会话和数据库记录归入 `name: null`（界面显示“未识别项目”）。每个项目
  用与 Agent 合计完全相同的行、分档和规则计价（`@agent-average` 用该 Agent 整个窗口的平均单价），所以一个 Agent
  的各项目之和等于它的合计；超出行数上限的项目汇总为 `otherProjects` / `other`，列表与合计始终对得上。

`days` 取 1–3650；`days=all`（或 `0`）表示所有时间：响应里 `windowDays` 为 null、`windowLabel` 为“所有时间”，
序列从索引里最早的一天开始（最多 3650 天）；其他窗口 `windowLabel` 为“最近 N 天”。索引版本 3 不再在 400 天后删除
旧日期（保留 3650 天），升级后全量重建一次，找回转录里仍在的旧日期。

`GET /api/usage/summary?days=30`（默认 30）

```ts
type Cost = { costUsd: number, costBasis: { official: number, estimate: number, family: number, reported: number }, unpricedTokens: number };
type ModelRow = {
  model: string,                       // 日志里的 id（未知或不可显示时为 "unknown"）
  name: string,                        // official 为价目表名称，其余为 id 本身
  vendor: string | null,               // 定价所用条目的厂商
  basis: "official" | "estimate" | "family" | "reported" | "unpriced",
  priceAs?: string,                    // estimate / family 实际所用的价目 id，或 "@agent-average"
  priceRef?: { section: "models" | "estimates" | "families", id: string },  // 价格表中对应的行
  unitPrice?: { input, output, cacheRead, cacheWrite, cacheWrite1h },        // 仅 @agent-average：算出的单价
  tokens: { input, output, cacheRead, cacheWrite /* 5 分钟或通用 */, cacheWrite1h, total },
  requests: number,
  costUsd: number,
  longShare: number,                   // 按长上下文价计的 token 占比（0–1）
};
{
  generatedAt, windowDays,
  index: { complete: boolean, updatedAt: string | null, indexedFiles: number, totalFiles: number },
  status: /* 同 /api/usage/status */,
  cost: Cost,                                                   // 全部 Agent 合计
  agents: Array<Cost & {
    agentId, sessions /* 窗口内活跃 */, sessionsStarted /* 窗口内开始 */, activeDays,
    tokens: { input, output, cacheRead, cacheWrite, total },   // input 不含缓存命中
    reportedCostUsd?: number,                                   // 仅 Hermes / OpenClaw / QClaw：产品自报
    byModel: ModelRow[],                                        // 按费用从高到低
    credits?: number,                                           // 仅 WorkBuddy
    series: Array<{ date: "YYYY-MM-DD", sessions /* 当天活跃 */, sessionsStarted, tokens, costUsd }>,  // 每天一项（本地日期），tokens 为合计
    sources: Array<{ id: "tokens" | "skills" | "credits", label, confidence: "exact" | "inferred" | "reported" }>,
  }>,
  topSkills: Array<{ name, count, tokens, costUsd: number | null /* 有 token 归因时 */,
                     agents: Array<{ agentId, count, confidence, lastUsedAt: "YYYY-MM-DD", costUsd?: number }> }>, // ≤ 50
}
```

`GET /api/usage/models?days=30`

```ts
{ generatedAt, windowDays, index, status, totals: Cost,
  models: Array<ModelRow & { agents: Array<{ agentId, tokens /* 合计 */, costUsd }> }>,  // 同一 id 与依据合并
  unpriced: string[],                                                                    // 未定价的模型 id
  pricingStale: { ids: string[], since: "YYYY-MM-DD" /* 最早过期的 reviewBy */ } | null,
  pricingTable: { checkedAt, ageDays: number | null, reviewAfterDays: number | null, stale: boolean } }
```

`GET /api/usage/projects?days=30`（常用 7 / 30 / 90 / all）：跨 Agent 的项目费用

```ts
{ generatedAt, windowDays, index, status, totals: Cost,
  projects: Array<Cost & { name: string | null, sessions, sessionsStarted, tokens /* 合计 */,
                           agents: Array<{ agentId, tokens, costUsd }>,           // 按费用从高到低
                           topModels: Array<{ model, name, costUsd }> }>,         // ≤ 3，跨 Agent 合并
  other: { count, costUsd, tokens } }                                            // 第 31 个起的项目合计；projects ≤ 30
```

`GET /api/usage/pricing` → 价目表：`{ schema, checkedAt, reviewAfterDays, checkedAgeDays, tableStale, pricingStale,
currency: "USD", unit, vendors, schedules, fx, buckets: [{ id: "s" | "l200" | "l272" | "l512", floor }], models, estimates,
families }`（`models` 各条含 `source`、`note`、`status`、`reviewBy`、`aliases`、`long`、`offPeak`、`changes`、`fast`；
`estimates` 可带 `fallback`；`families[].match` 为正则文本）。

`GET /api/usage/skill?name=<技能名>&days=90`（名称也匹配 `插件:技能` 的后半段）

```ts
{ name, windowDays, index, status,
  agents: Array<{ agentId, name, total, tokens, lastUsedAt, confidence, reportedTotal?: number /* Hermes 累计 */,
                  costUsd: number | null, costBasis?, unpricedTokens?, byModel?: ModelRow[], // 有 token 归因时
                  series: Array<{ date, count }> }> }
```

`GET /api/usage/agent?id=<agentId>&days=90`

```ts
{ agentId, windowDays, index, status,
  totals: Cost & { sessions, sessionsStarted, activeDays, tokens: { input, output, cacheRead, cacheWrite, total }, reportedCostUsd? },
  byModel: ModelRow[],
  series: Array<{ date, sessions, sessionsStarted, tokens: { input, output, cacheRead, cacheWrite, total }, costUsd }>,
  topSkills: Array<{ name, count, tokens, costUsd: number | null, lastUsedAt, confidence }>,  // ≤ 30
  topProjects: Array<Cost & { name: string | null /* 工作目录最后一段；null = 未识别项目 */, sessions, sessionsStarted, tokens /* 合计 */,
    tokenSplit: { input, output, cacheRead, cacheWrite, cacheWrite1h },   // 计价所用的拆分
    topModels: Array<{ model, name, costUsd }> }>,                         // ≤ 3；项目按费用、再按 token 排序，≤ 20
  otherProjects: { count, costUsd, tokens },                               // 其余项目合计，与 totals 对得上
  sources }
```

### 体检报告

`GET /api/health-report[?force=1]`（缓存 5 分钟；`force=1` 受 5 秒防抖限制）

```ts
{
  generatedAt,
  counts: { error, warn, info },
  categories: Record<string, number>,
  findings: Array<{
    id: string,                                // 16 位十六进制，稳定
    severity: "error" | "warn" | "info",
    category: "broken-link" | "missing-skill-md" | "frontmatter" | "name-mismatch" | "oversize" | "differing-copies"
            | "hidden-by-product" | "shadowed" | "disabled" | "archived" | "missing-bin" | "missing-env" | "nvm-only"
            | "mcp-command-missing" | "mcp-literal-secret" | "plugin-state" | "shared-root"
            | "update-available" | "locally-modified" | "lock-drift" | "codex-tmp-leftovers"
            | "library-drift" | "library-external-link" | "cli-version-skew" | "cli-workspace-unconfigured" | "cli-not-on-agent-path",
    title: string, detail: string,            // 中文
    agentId?: string, skillName?: string, path?: string,   // path 为 "~/…"
    fix: { kind: "none" | "open" | "reinstall" | "remove-link" | "enable" | "configure", label: string },
    hint?: { command?, env?, mcp?, workspace? },            // 生成修复命令用的名称（从不含值）
    remedy: Remedy,                                          // 见“修复建议”
  }>,
  remedyAll: Remedy,                                         // 需要处理 + 建议处理（error + warn）按类别分组
}
```

技能相关检查覆盖当前“展示”的 Agent（与 `/api/scan` 一致），根目录检查覆盖所有已配置 Agent。
检查项：各技能根目录顶层的失效软链接（error）与缺少 SKILL.md 的目录（空目录、只含隐藏文件或子目录的
目录、带 `DESCRIPTION.md` 的 Hermes 分类目录除外）；SKILL.md 缺少
frontmatter 或 `name` / `description`；技能名与目录名不一致（info）；SKILL.md 超过 256 KB（OpenClaw 不加载，
warn）或 1 MB（error）；同一 Agent 内生效副本内容不同；被产品隐藏、被覆盖、已停用、已归档（info）；
OpenClaw `metadata.openclaw.requires.bins` 找不到（在服务 PATH、Homebrew、`~/.local/bin`、`~/.cargo/bin`、
各 nvm 版本等目录中查找，只检查可执行文件是否存在，从不执行）、只在 nvm 中存在（图形界面启动的 Agent
可能看不到）、`requires.env` 未设置（只看名称）；MCP `command` 找不到或只在 nvm 中；MCP 配置里的明文密钥
字段（只报字段名）——`command` 按程序路径处理（可含空格，`~/` 会展开，相对路径不检查）；插件只在缓存中、未安装或启用状态未知；被多个 Agent 共用的技能目录（info）。
每个“类别 + Agent”最多 30 条，超出部分合并为一条说明；总数最多约 1,000 条；按严重程度排序。

### 应用图标

`GET /api/agent-icon?id=<agentId>` → `image/png`（128 px），没有安装或非 macOS 时 404（前端回退为字母）。
在 `/Applications` 与 `~/Applications` 中按已知名称查找应用，并核对 Bundle ID（codex、claude、workbuddy、
cursor、trae、hermes、qclaw、lumiclaw、moticlaw、smartorder、kiro、windsurf、office-raccoon）；读取 `CFBundleIconFile`，
图标文件必须位于应用包内且不超过 20 MB；用 `/usr/bin/sips`（参数数组，不经 shell，10 秒超时）转换，
结果须是 ≤ 512 KB 的 PNG，缓存在 `~/.agent-skill-manager/icons/<id>-<摘要>.png`，应用更新后自动重新转换。
测试通过 `SKILL_MANAGER_APPLICATION_DIRS` 指向临时目录，从不读取真实的 `/Applications`。

## 修复建议（Remedy）

`server/remedies.mjs`。`Remedy = { commands?: Array<{ label?: string, command: string }>, prompt: string }`：
`prompt` 是给用户自己的 AI 助手（Codex 或 Claude Code）的中文提示词，写明问题、涉及的 Agent 与 `~/…` 路径、
目标状态和安全步骤（改动前备份到 `~/.agent-skill-manager/backups/`、不打印或移动任何密钥、删除前先问、
完成后验证并汇报）；命令只给安全且确切的：只读检查（`ls -l`、`head -20`、`command -v`、`which -a`、
`npm ls -g`）、官方更新命令（`claude update`、`hermes update`、`lark-cli config bind --source <ws>`、
`<该 Node 的 npm> install -g <包>@latest`）和 `mv -n … ~/.Trash/`；从不包含 `rm` 或 `sudo`，路径不安全时不给命令。
所有文本经密钥擦除与主目录压缩；单条提示词不超过 1,500 字，`remedyAll` 不超过 8,000 字（每类最多列 12 项、
合并的检查命令最多 20 条且不含移动）。用在：体检的每条发现与 `remedyAll`；`/api/updates` 的每个单元
（`remedy`，没有可执行更新时只给一句说明）与 `remedyAll`（全部可更新项，按“在 Skill Control 里更新 / 用各自的
命令 / 按说明手动”分组）；`/api/agent-versions` 的每个产品（有新版本时；无法查询的应用给“在应用里检查更新”）。

## Agent 产品版本

`server/agent-versions.mjs`。本机版本只读文件、从不执行程序：应用包 `Info.plist`；npm 全局包——在已知 PATH 目录
里解析命令、`realpath` 后向上找到同名 `package.json`；Claude Code 原生安装看 `~/.local/share/claude/versions/<版本>`；
Hermes 同时记下 `install-stamp.json` 的 `baseVersion`（0.21.x，v0.22 起它的 GitHub 版本标签用这一套）与
`hermes_cli/__init__.py` 的 `__release_date__`（日历版本，旧标签用这一套），按最新标签的格式选一个比较和显示；自带的 CLI（`~/.hermes/node/bin/lark-cli`）。最新版本只来自官方来源：CLI
包查 npm registry 的 `latest`；应用查自己的更新源——electron-updater 的 `Contents/Resources/app-update.yml`
（`generic` → `<url>/<channel>-mac.yml`，`github` → 该仓库的 latest release）、Sparkle 的 `SUFeedURL` appcast；
Hermes 按自己的 git 远端（GitHub）查 latest release。占位或不安全的地址（`example.com`、`.test`、IP、非 https）
与没有更新源的应用一律 `unknown` 并说明原因。请求不带任何标识（只有固定 User-Agent 与 Accept），10 秒超时，最多
4 个并发，每个来源只请求一次，响应最多 2 MB；`SKILL_MANAGER_UPDATES_OFFLINE=1` 时不发请求。结果缓存在
`~/.agent-skill-manager/agent-versions.json`；服务启动时若缓存超过 24 小时就检查一次，此后每 24 小时一次。

`GET /api/agent-versions`、`POST /api/agent-versions/check`（只读联网，普通 POST，受来源与跨站检查，不需要确认头）→

```ts
{ checkedAt: string | null, nextCheckAt: string | null, offline: boolean,
  agents: Array<{
    agentId: string,                 // codex、claude、hermes、office-raccoon、lark-cli …（同一 Agent 可有应用与 CLI 两行）
    id: string,                      // codex-cli、codex-app、lark-cli-hermes …
    name: string,
    installed: { version: string | null, source: "app" | "npm" | "cli" | "bundled", path: string /* ~/… */ },
    latest: { version, source: "npm" | "github" | "electron-updater" | "sparkle", url, releasedAt?, notesUrl? } | null,
    status: "up-to-date" | "update-available" | "unknown" | "error",
    error?: string, reason?: string, // reason：为什么是 unknown（没有更新源、占位地址、还没检查过）
    active: boolean,                 // 同一产品有多份（原生安装与 npm）时，用户 PATH 上排第一、真正运行的那份为 true
    openApp?: { bundleId: string }, downloadUrl?: string,   // 桌面应用：用 open -b 打开让它自己更新；官方下载页
    remedy?: Remedy & { action?: { kind: "agent-update", id: string } },   // action：可以一键更新
  }> }
```

同一命令在 PATH 上有多份时（例如 `~/.local/bin/claude` 原生安装和某个 nvm 下的 npm 包），每份一行：第一份 id 不变，
其余加 `-2`、`-3`，名称后注明“（原生安装）/（npm）”，`active` 标出生效的一份。

**一键更新（v0.2 §2）**。只有已核实的官方更新命令可以一键执行，其余一律只给 AI 提示词：

| 产品 | 命令（无 shell，参数数组） | 依据 |
| --- | --- | --- |
| Codex CLI、Gemini CLI、Claude Code（npm 安装）、lark-cli（含 Hermes 自带的一份） | `<拥有这份安装的 npm> install -g --prefix <它的前缀> <包>@latest` | npm 官方升级方式；Claude Code 文档 “To upgrade an npm installation, run npm install -g @anthropic-ai/claude-code@latest”；`--prefix` 固定到拥有这份副本的全局目录（Hermes 的那份用 `~/.hermes/node/bin/npm`） |
| Claude Code（原生安装） | `<~/.local/bin/claude> update` | code.claude.com/docs/en/setup：手动更新 `claude update` |
| OpenClaw（npm 安装） | `<openclaw> update` | OpenClaw 文档 install/updating：“Recommended: openclaw update”（会重启 Gateway） |

`POST /api/agent-versions/plan { id }` → `{ planId, expiresAt, title, steps: [{ display }], effects: string[], afterCheck: { kind: "version", id } }`；
必须先检查到新版本（否则 409 `up-to-date` / `check-required`），不在白名单 409 `refused`，命令目录被固定
（`SKILL_MANAGER_COMMAND_DIRS`）且程序不在其中 403 `command-not-allowed`，程序已不存在 409 `stale-plan`。
`POST /api/agent-versions/apply { planId, confirm: true }` + `x-skill-manager-confirm: yes` → `{ ok, steps: [{ display, exitCode, output }],
version: { before, after }, historyEntry }`：计划 10 分钟内有效、只能用一次；离线模式 409 `updates-offline`；每步 5 分钟超时，
环境只有 `PATH`（程序自己的目录 + 系统目录）、`HOME`、`LANG`，工作目录是主目录；输出经密钥擦除与主目录压缩、只留最后 4 KB；
执行后重新读本机版本，并在历史里记一条不可撤销的 `agent-update`。`POST /api/agent-versions/open { id }` 用 `open -b <bundleId>`
打开桌面应用（不下载、不改文件；命令目录被固定时拒绝）。

## v0.2 后台新增

### 新 Agent 与发现（§1）

`config.json` 新增 `knownAgentIds`（首次运行时把当前检测到的 Agent 全部记为已知，避免全部显示“新”）与
`ignoredDiscoveries`（用户忽略的候选路径，`~/…`）。`GET /api/config` 另返回 `newAgentIds`；`GET /api/scan` 的每个
Agent 带 `isNew`（已检测到、且不在 `knownAgentIds` 中）。`POST /api/agents/acknowledge { ids }` → `{ knownAgentIds, newAgentIds }`。
保存配置时用户自己加的 Agent 自动记为已知，未传的 `knownAgentIds` / `ignoredDiscoveries` 保持原值。

`GET /api/agents/discover`（`server/agent-discovery.mjs`，只读、3 秒预算）→ `{ candidates: [{ id, guessName, path, skillCount,
appPath?, launcher?, reason }], truncated }`：在 `~/.*` 与 `~/Library/Application Support/*`（及其下一层）找
`skills/<名>/SKILL.md`，跳过缓存与工具链目录、已知 Agent 的目录与忽略的路径，不跟随离开主目录的链接；应用包只读
`Info.plist`，按名称 / bundle id 对应 `~/.<名>`、`Application Support/<名>`；`~/.local/bin` 中指向 `.app` 内部的链接
（取最内层，如 pcsuite.app 里的 VClaw.app）即使还没有技能目录也列为候选，同名启动脚本记为 `launcher`。

### 排序字段（§3）

技能：`installedAt`（各副本中最早的创建时间）、`updatedAt`（最晚的修改时间）、`lastUsedAt` / `uses30d` / `usesAll`
（来自用量索引，任何 Agent，名称不区分大小写，`plugin:name` 也按 `name` 匹配）；实例另有 `createdAt`。技能库条目
`installedAt`；插件 `installedAt` / `updatedAt`（安装目录）与 `lastUsedAt`（它的任一技能最近一次使用）；MCP
`updatedAt`（所在配置文件的修改时间）；能力条目（专家等）`createdAt` / `updatedAt` / `lastUsedAt`。没有的值为 `null`。

### 连接器详情（§5）

`/api/integrations` 的 Codex 连接器新增 `providers: [{ id, name }]`（提供它的插件）、`iconAssetId`（插件图标，经
`/api/plugin-asset`）、`auth: { status: "connected" | "unknown", basis }`（Codex 只在连接过的应用缓存工具列表，有缓存即
`connected`；不读任何账号信息）与 `tools: [{ name, description, readOnly }]`（最多 200 个，说明经密钥擦除、200 字）。

### 密钥清单（§6）

`GET /api/secrets`（`server/secrets-inventory.mjs`，同站）→ `{ generatedAt, items: [{ id, service, keyName, location, storage,
agents, usedBy: [{ kind: "mcp" | "skill" | "cli", name }], fingerprint?, modifiedAt, note?, firstSeenAt, changedAt, remedy }],
changes: [{ id, kind: "added" | "changed" | "removed", at, keyName? }], summary: { total, plaintext, byStorage } }`，
`storage` ∈ `plaintext`、`env-ref`、`keychain`、`credential-file`、`oauth`。

来源：各 Agent 的 MCP（复用 `readMcpSources` 与 `secret-fields`）；Claude `settings.json` / `~/.claude.json` 的 `env`；
Gemini、WorkBuddy、Hermes 的 `.env`；Gemini `settings.json`、WorkBuddy `env`、Hermes `config.yaml`（不含 MCP 段）；
OpenClaw / QClaw 配置（不含 `mcp`）、SQLite 认证库（`agents/<id>/agent/openclaw-agent.sqlite`、`state/openclaw.sqlite`：
只记存在，从不打开）与旧版 `auth-profiles.json`、`auth.json`、`credentials/oauth.json`；办公小浣熊 `config.yaml`、`mcp.json`；
技能目录里的 `.env*`（只列名称，不算指纹，`.env.example` 等不算）；`gh` 的 `hosts.yml`（没有令牌时注明存在钥匙串）；
`~/.npmrc`、`~/.netrc`、`~/.aws/credentials`；Docker `config.json`（`credsStore` / `credHelpers` 注明凭据助手）；
lark-cli `config.json`（`appSecret` 来源为 keychain 时注明）。

隐私：值只在解析函数里出现一次，`classify()` 判定类型后丢弃；变量名字段（`*_env_var`、`env_http_headers`）里只有
大写变量名算引用，其他内容按“误填的值”记为 plaintext；超时、调试开关等设置项不算密钥。不少于 16 个字符的值
记 8 位 HMAC-SHA256 指纹，盐是 `~/.agent-skill-manager/secret-salt`（随机、0600），只用来判断“变了没有”。
`secret-snapshot.json`（0600）只存 id、键名、指纹与时间；第一次是基线，之后报告新增、变化、删除（最多保留 200 条）。
从不读取 macOS 钥匙串。每条带 `remedy`（按存储类型给出整改提示，例如把明文改成环境变量引用）。

### 用量合计（§7）

`GET /api/usage/totals` → `{ generatedAt, index, status, windows: [{ id: "today" | "7" | "30" | "90" | "all", label, windowDays,
from, to, tokens, costUsd, costBasis, unpricedTokens, sessions, activeDays, byAgent: [{ agentId, tokens, costUsd, sessions }] }] }`，
与 `/api/usage/summary` 同一索引、同一计费规则。

### 通用 CLI 清单（§12）

`server/cli-inventory.mjs`，从不执行程序。来源（每个目录最多 400 项）：`~/.local/bin`；每个 nvm 版本、`~/.npm-global`、
Hermes 自带 node 的 npm 全局 bin（只收 `lib/node_modules` 里的包，不含 node、npm、corepack）；系统前缀 `/opt/homebrew`、
`/usr/local` 的 bin（npm 包照收；Homebrew 命令只收技能或 Agent 放行规则提到的；命令目录被固定时不看系统前缀）；
pnpm（`~/Library/pnpm`）、`~/.bun/bin`、`~/.cargo/bin`、`~/go/bin`、`~/.deno/bin`；uv tools 的 `uv-receipt.toml` 入口。
同名且同一真实文件的多个入口合并为一行（其余入口在 `links`）。`*.bak`、`*.old` 当作备份隐藏并计数。

每个工具：`{ id, name, path, source, sourceLabel?, kind: "script" | "binary" | "symlink" | "other", fileKind, interpreter?, target?,
links?, owner: { type: "npm" | "uv" | "pipx" | "app" | "native" | "homebrew" | "cargo", name, version, manager?, bundleId? } | null,
description, size, mtime, referencedBySkills (≤20), referencedCount, aiRelated, aiReasons, agents: [{ agentId, agentName, available,
detail, allowed }] }`。类型与解释器只看前 512 字节（shebang / Mach-O / ELF）；归属看真实路径（`.app` 的 Info.plist、
`versions/<版本>`、`package.json`、dist-info、`Cellar/<formula>/<版本>`、`.crates.toml`）；说明取脚本开头最多 3 行注释，
没有时用 npm 包的 `description`，都经密钥擦除与主目录压缩、200 字。`referencedBySkills`：SKILL.md（最多 2,000 个、
每个前 64 KB）里代码中处于命令位置的名称，或带 `-`、`_`、`.`、数字的名称在正文中作为单词出现；按文件大小与修改
时间缓存在 `cli-skill-mentions.json`（0600，只存命中的名称）。`agents` 复用 lark-cli 卡片的 PATH 来源与放行规则
（`available`：该 Agent 的 PATH 上第一个同名命令就是这一份）。`aiReasons`：`skill-reference`、`known-ai-cli`、`ai-app`
（链接指向 AI 应用）、`npm-keywords`（ai / agent / llm / mcp）、`local-bin`（在 `~/.local/bin` 且不是 uv、python、pnpm
等通用工具）。

`GET /api/cli-tools` → `{ tools, summary: { total, aiRelated, referencedBySkills, hiddenBackups, bySource, byKind,
skillFilesScanned, truncated, deep } }`：先是深度卡片（lark-cli、gh、uv，带各 Agent 的工作区 / 钥匙串 / 放行规则检查与
修复项，并合并其首选副本的清单字段），再是其余命令。

## 更新检测与执行

设计见 `docs/LIBRARY-UPDATES-CLI.md` 第 2 节，这里记录实现与接口。

**更新单元**：`provenance.mjs` 先按真实路径合并同一物理目录的多个 Agent 视图，再按来源聚合。判定顺序：
宿主托管目录（Codex `.system` 与插件缓存、Mirasim、Hermes 内置/组织、OpenClaw 内置、QClaw 同步与 SkillHub、
订单来了）→ `~/.agents/.skill-lock.json`（只读；github 条目成为 `skills-cli` 单元，`open.feishu.cn` 的 well-known
条目并入 `lark-cli` 单元）→ 技能目录内的 `_skillhub_meta.json` / `.clawhub/origin.json` → git 检出（`.git` 位于某个
Agent 技能根目录之内）→ frontmatter `homepage` / `repository` 中的 GitHub 地址（只作 `possibleSource`，不自动绑定）
→ 来源未知。另有来自插件登记的单元：Claude Code 插件、Codex git 插件市场与远程插件、WorkBuddy zip 插件市场。
内容相同的同名副本并入对应的 `skills-cli` 单元。单元键不含路径（git 单元用检出目录的摘要）。

**哈希与基线**：`skills-cli` 用 git 树哈希（排除 `.git`、`__pycache__`、`__pypackages__`、`metadata.json`，与 vercel
`skills` 安装器一致），基线是锁里的 `skillFolderHash`；GitHub 树接口按提交 SHA 请求时返回的 `sha` 是提交而不是
树，所以目录哈希一律由列表重建。没有基线的来源（未知、SkillHub、ClawHub、lark-cli 官方技能）在首次解析时把扫描
指纹记入 `~/.agent-skill-manager/update-baselines.json`；带版本的来源在版本变化时重记。

**检查**（`POST /api/updates/check`，手动触发，后台执行）：每个仓库先 `git ls-remote` 取 HEAD，HEAD 变化时才请求一次
`api.github.com/repos/<o>/<r>/git/trees/<sha>?recursive=1`（列表被截断时经父目录内容接口取子树）；lark-cli 读 npm
`@larksuite/cli/latest` 与 `open.feishu.cn/.well-known/skills/index.json`（新技能名差集）；Claude 插件读
`raw.githubusercontent.com/<repo>/HEAD/.claude-plugin/marketplace.json`，条目无版本时读插件的 `plugin.json`，再无版本
时用条目里固定的 `source.sha` 或 ls-remote 比较提交，插件在上游改名时按相同来源路径匹配；Codex git 市场与 git
检出用 ls-remote；Codex 远程插件只比较 Codex 自己缓存的远程目录（不发请求）；WorkBuddy zip 市场用 `HEAD` +
`If-None-Match`；SkillHub 与 ClawHub 读各自注册表的 `latestVersion`，ClawHub 绝不跨注册表回退，`AMBIGUOUS_SKILL_SLUG`
视为检查失败。每次检查默认最多 80 个请求，超出的单元保留上次结果并说明原因；GitHub 返回额度耗尽时记录
`x-ratelimit-reset`，在重置前不再请求 GitHub 接口；网络失败时保留上次的上游事实并标 `stale`。结果写入
`~/.agent-skill-manager/update-cache.json`（只存上游事实，不存令牌）。状态在每次读取时由“当前本地内容 + 缓存事实”
计算，修改技能后无需重新检查。允许访问的主机：api.github.com、github.com、raw.githubusercontent.com、
registry.npmjs.org、open.feishu.cn、clawhub.ai、api.skillhub.cn、download.codebuddy.cn。

配置 `updates.useGhAuth: true`（“使用 gh 登录提升额度”）后，检查开始时以参数数组运行 `gh auth token`，令牌只在本次
检查的内存中、只附加到 api.github.com 请求，不写入缓存、日志或响应。检查阶段从不调用 `npx skills check`。

**三方判定**：本地 = 上游 → `up-to-date`（锁记录落后时 `lockDrift: true`）；本地 = 基线 ≠ 上游 → `update-available`；
本地 ≠ 基线 = 上游 → `locally-modified`；三者都不同 → `conflict`。其他状态：`managed-by-host`、`unknown-source`
（未知来源内容自首次记录后变化时为 `locally-modified`）、`check-failed`、`unchecked`（尚未检查）。

### 接口

`GET /api/updates`（只读缓存，不联网）

```ts
{
  checkedAt: string | null, hosts: string[] /* 上次检查访问过的主机 */, allowedHosts: string[],
  github: { remaining: number | null, resetAt: string } | null,
  counts: Record<Status, number>,
  units: Array<{
    unitKey: string, title: string, sourceType: "skills-cli" | "well-known" | "lark-cli" | "claude-plugin" | "codex-marketplace"
      | "codex-remote-plugin" | "workbuddy-marketplace" | "workbuddy-skillhub" | "clawhub" | "hermes-hub" | "host" | "git" | "unknown",
    sourceLabel: string, owner: "skill-control" | `host:${string}` | "unknown", confidence: "exact" | "none",
    instances: Array<{ agentId, path /* ~/… */ }>, instanceCount: number,
    status: "up-to-date" | "update-available" | "locally-modified" | "conflict" | "managed-by-host" | "unknown-source" | "check-failed" | "unchecked",
    current: string | null, latest: string | null,       // 版本，或 7 位提交/哈希
    changes?: Array<{ title: string }>,                   // 新增官方技能、注册表 changelog
    lockDrift?: true, localModified?: true, reason?: string, stale?: true,
    checkedAt: string | null, error?: { kind, message, resetAt? },
    action: { kind: "self" | "delegate" | "guide" | "none", label: string, command?: string /* 仅用于展示 */ },
    binaries?: Array<{ path, version, hermes }>,          // lark-cli 的每一份二进制
    pluginPath?: string, possibleSource?: string,
  }>,
  job: CheckJob,
}
```

`POST /api/updates/check` `{ unitKeys?: string[] }` → `CheckJob`；`GET /api/updates/check-status` → `CheckJob`：
`{ state: "idle" | "running" | "done" | "error", startedAt, finishedAt, done, total, requests, hosts, error }`。

`GET /api/updates/changes?unitKey=` → `{ unitKey, source: "github" | "local", changes: Array<{ sha?, title, date? }>, error? }`：
`skills-cli` 用 commits 接口（限定目录、自安装时间起），插件与 git 单元用 compare 接口（已装提交…最新提交），各 1 个请求。

`POST /api/updates/plan` `{ unitKey, choice?: "keep-local" | "overwrite" | "save-as" }` →

```ts
| { requiresChoice: true, unitKey, status, choices: string[], message }          // 本地修改过：必须先选
| { planId: string, unitKey, kind: "self" | "delegate" | "none", expiresAt,
    steps: Array<{ type: "download" | "save-as" | "replace" | "lock" | "keep-local" | "command", description?, path?, backup?, agentId?, alsoVisibleTo?, command? }>,
    changes?: { added: string[], modified: string[], removed: string[] },        // self：文件级差异
    notes?: string[] }
| { planId: null, unitKey, kind: "guide" | "none", steps: [], instructions, command }
```

`POST /api/updates/apply` `{ planId, confirm: true }`，必须带请求头 `x-skill-manager-confirm: yes` →
self：`{ planId, unitKey, kind: "self", changed: [{ agentId, path, backup }], lockBackup, savedAs, historyEntry }`；
delegate：`{ ..., kind: "delegate", ok, commands: [{ command, exitCode, stdout, stderr }], historyEntry }`（输出只保留末尾
4 KB，脱敏并压缩主目录）。计划只能由本进程在 10 分钟内生成、只能执行一次；跨站请求与外部 Origin 返回 403。

**自更新（skills-cli GitHub）**：按检查时缓存的提交，从 `raw.githubusercontent.com/<repo>/<commit>/<path>` 下载目录内
文件（≤ 1,500 个、单个 ≤ 25 MB、合计 ≤ 100 MB，上游含软链接或子模块时拒绝），逐个校验 git blob 哈希，暂存目录的
树哈希必须等于上游；执行前再次确认本地内容与锁条目未在计划后变化。写入沿用同步的计划模型：经写入跟踪器按真实
路径去重（共享目录只写一次、目标必须在 Agent 技能根目录内），逐个备份到 `~/.agent-skill-manager/backups/<时间>/`、
原子替换，写后复核树哈希，失败则从备份恢复全部已写目录；成功后先备份 `.skill-lock.json`，再原子改写该条目的
`skillFolderHash`（上游原始目录哈希）与 `updatedAt`。冲突时：`keep-local` 不改动；`overwrite` 先备份再覆盖；
`save-as` 先把本地版本复制为同级的 `<名称>@local` 再更新。

**委托执行**：lark-cli `update --json`（Hermes 自带的那份不会被更新，会在计划中说明）；Claude
`plugin marketplace update <市场>` + `plugin update <插件>@<市场> --json [-s 作用域]`（需重启）；Codex
`plugin marketplace upgrade <市场> --json`；Hermes `skills update <名称>`；git 检出在 `status --porcelain` 为空时
`-C <目录> pull --ff-only`。二进制用 PATH 与常见安装目录解析为绝对路径，`execFile` 参数数组、5 分钟超时，环境变量加
`DO_NOT_TRACK=1`、`DISABLE_TELEMETRY=1`、`NO_COLOR=1`、`GIT_TERMINAL_PROMPT=0`。gstack 只给出 `/gstack-upgrade`
指引；WorkBuddy、Codex 远程插件、SkillHub、ClawHub 只给出指引。

测试与本地调试：`SKILL_MANAGER_UPDATES_OFFLINE=1` 时传输层在发出任何请求或启动任何子进程之前就返回离线
（无论是否注入了 fetch / ls-remote 实现），检查结果保留上次事实并标 stale，委托执行的更新命令一律拒绝（409）；
`SKILL_MANAGER_COMMAND_DIRS` 固定可查找与可执行命令的目录，设置后目录之外的二进制一律拒绝执行。`git ls-remote`
默认用 `/usr/bin/git`，可注入实现；固定命令目录时只接受位于这些目录内的 `SKILL_MANAGER_GIT_PATH`，没有则视为没有
git（ls-remote 返回 unavailable）。测试服务器设置离线、固定命令目录，PATH 只保留系统目录。

体检报告读取缓存的更新结果（不联网），新增类别 `update-available`、`locally-modified`（只针对有来源的单元）、
`lock-drift`，以及 `codex-tmp-leftovers`（`~/.codex/.tmp/git-*` 的数量与体积，统计有时间与条目上限）。

## 统一技能库与 CLI 工具卡片

设计见 `docs/LIBRARY-UPDATES-CLI.md` 第 1、3 节。

**写入保护**：所有技能库与 CLI 写入先经过 `home-guard.mjs`：服务的主目录不是账户真实主目录（`os.userInfo()`，不看
`$HOME`）时，拒绝写入真实主目录下的任何路径；测试运行器在场（`NODE_TEST_CONTEXT` 或 `SKILL_CONTROL_TEST=1`）时，
即使配置的就是真实主目录也一律拒绝。删除一律是移动到 `~/.agent-skill-manager/backups/<时间>/` 或 `trash/`，
从不 `rm -rf` 实体目录。

**分发档位与可见性**（`library-agents.mjs`）：原生读取 = Codex、Gemini CLI、Cursor、Copilot、OpenCode、Windsurf、
Amp、OpenClaw、QClaw；配置目录 = Hermes（`skills.external_dirs`）；逐技能相对链接 = Claude Code、Kiro、CodeBuddy、
WorkBuddy、Trae；其余 Agent 只用自己的副本。可见性按产品规则模拟：OpenClaw/QClaw 隐藏真实路径越出根目录的
链接，库（个人目录）覆盖自有目录里的同名副本；Codex 不合并同名技能（自有目录的同名副本标“重复”，与库条目是
同一物理目录时不算）；Hermes 本地同名优先，内容不同则标重复；链接档位看自有目录里是否是指向库的链接；停用开关
读取 Codex `[[skills.config]]`（`name` / `path` + `enabled = false`）、Gemini `skills.disabled`、OpenClaw/QClaw
`skills.entries.<名称>.enabled`、Hermes `skills.disabled`。git 检出（如 gstack）与应用目录里的技能标为外部托管，
不计算内容哈希、不搬动。

`GET /api/library`

```ts
{
  root: "~/.agents/skills", realRoot: string | null, exists: boolean,
  owner?: { kind: "symlink", realPath, manager: string | null, appInstalled: boolean | null },
  entries: Array<{
    name, kind: "real" | "link-internal" | "link-external" | "broken", target?: string /* ~/… */,
    hash: string | null /* 16 位 */, externalManaged?: "git",
    sourceFromLocks?: { source, sourceType, file }, recorded?: { adoptedFrom, updatedAt },
    fanout: Record<agentId, { tier: "native" | "config" | "link" | "none",
      state: "visible" | "hidden" | "missing" | "duplicate" | "private-copy" | "none", reason: string | null, path?: string }>,
  }>,
  agents: Array<{ agentId, name, tier, primary, collapsed /* 非常用 Agent 默认折叠 */, notes, directories: string[] }>,
  issues: Array<{ id: "library-external-link" | "library-broken-link" | "library-drift" | "library-owner-missing", severity, title, detail, agentId?, names? }>,
  trash: Array<{ trashId, name, removedAt, links }>,
}
```

涉及的 Agent：常用 Agent（未设置时用扫描得出的有效常用 Agent）、所有存在技能目录的 Agent，以及原生读取的 Agent。

`POST /api/library/plan` `{ action: "adopt" | "link" | "unlink" | "disable" | "remove" | "batch", skill?, agents?, choice?, choices?: Record<itemId, choice>, from? }`
（所有操作都接受 `choices`，冲突条目的键为 `conflict:<agentId>:<技能名>`；单个操作的 `choice` 优先）→

```ts
{
  planId: string | null, action, expiresAt?, needsChoice: number, message?,
  summary: Record<kind, number>,
  items: Array<{
    id: string,               // 例如 "adopt-link:rev-1"、"dedupe:codex:x"、"conflict:claude:x"、"external:gstack"
    title, kind: "adopt" | "link" | "dedupe" | "conflict" | "external" | "config" | "unlink" | "disable" | "remove" | "instructions",
    skill, agentId?, choices?: string[], choice, requiresChoice?: true,
    steps: Array<{ type: "backup" | "move" | "stash" | "unlink" | "link" | "write" | "command", path?, from?, to?, target?, command?, diff? }>,
  }>,
}
```

写入前用 `lstat` 分类目标：absent / link-to-library / foreign-link / broken-link / real-dir / real-file。规则：
- 收编（adopt）：库里指向某个 Agent 自有目录的链接 → 先备份，再把真实目录移入库（跨卷时复制 + 校验后把原目录
  移到备份），原先指向旧位置的其他链接改为指向库的相对链接，原位置按档位处理（链接档位回链，原生读取的不留
  链接，Hermes 未配置外部目录时回链）。Agent 独有、库里没有的技能也可单独收编。
- 同名副本：内容相同 → 链接档位改为相对链接、原生读取的移到备份；内容不同 → 冲突，必须选择
  `keep-library` / `use-this` / `save-as`（存为 `<名称>@<agent>`）/ `skip`，默认 `skip`；外部链接（指向 git
  检出或应用目录）不处理。
- 批量整理（batch）：收编全部反向链接、git 检出与应用目录里的技能标外部托管、常用 Agent 中与库相同的副本改为
  链接或移除、冲突逐项选择；Hermes 是常用 Agent 时附加 `skills.external_dirs` 配置项（默认不选），优先运行
  `hermes config set skills.external_dirs '<JSON 列表>'`，没有 hermes 命令时才直接编辑 YAML（先备份，注释不保留）。
- 停用：Codex 在 `config.toml` 末尾追加 `[[skills.config]]` 块；Gemini / OpenClaw（标准 JSON 时）改 JSON；
  OpenClaw 配置含注释时只给指引；Hermes 用 `hermes config set skills.disabled`；链接档位移除链接。
- 移除：撤掉所有指向库的链接，把条目移到 `~/.agent-skill-manager/trash/<id>/` 并写清单。

`POST /api/library/apply` `{ planId, confirm: true }` + `x-skill-manager-confirm: yes` →
`{ planId, results: [{ id, title, status: "applied" | "failed" | "rolled-back", error?, trashId? }], backups, visibility: Record<skill, fanout>, historyEntry }`；
`historyEntry.restorable` 为 true 表示至少一个已执行条目有可撤销的操作（或进了回收站），与历史列表的判断相同。
每个条目是一个事务：任一步失败即按相反顺序撤销本条目已完成的步骤；全部执行后重新做一次可见性体检，预期 Agent
看不到技能的条目自动回滚。成功后更新 `library-lock.json`（来源只读导入自 `~/.agents/.skill-lock.json`，键排序）
并写入历史。`POST /api/library/restore` `{ trashId, confirm: true }`（同样需要确认头）→ `{ trashId, name, path, links }`。

**CLI 工具卡片**：描述表（`CLI_DESCRIPTORS`）驱动，目前完整描述 lark-cli，gh、uv 只检测二进制与各 Agent 能否
找到。版本从 npm 包的 `package.json` 读取，从不执行 CLI；只在生产环境运行 `launchctl getenv PATH` 这一个只读
探测。各 Agent 的 PATH 来源：Codex / Claude Code / WorkBuddy 读各自最新的 shell snapshot（支持 `export PATH=…` 与
zsh `export -T PATH path=( … )`）；Hermes 读 `~/Library/LaunchAgents/ai.hermes.gateway.plist` 的 PATH，并据
`HERMES_HOME` 判断改用 hermes 工作区；OpenClaw / QClaw 用图形界面默认 PATH（openclaw 工作区）；Gemini / Cursor /
OpenCode 参考最新 shell snapshot。工作区是否配置只看 `config.json` 是否存在、`appSecret` 的来源类型（如 keychain），
从不读取密钥；Codex 处于沙箱且凭据在钥匙串、没有 `master.key.file` 时为 `needs-downgrade`。

`GET /api/cli-tools` →

```ts
{ tools: Array<{
  id: "lark-cli" | "gh" | "uv", name,
  binaries: Array<{ path, version: string | null, kind: "npm-global" | "bundled" | "manual" | "wrapper", via: "PATH" | "nvm" | "bundled", target? }>,
  latest: string | null, versionSkew: boolean,
  agents: Array<{
    agentId, agentName, pathSource: string, resolves: { path, version } | null,
    // 仅 lark-cli：
    workspace?: "local" | "hermes" | "openclaw", workspaceConfigured?: boolean, secretSource?: string | null,
    keychainReachable?: "yes" | "needs-downgrade" | "unknown", skill?: { name, inLibrary, visible },
    allowRule?: "present" | "missing" | "n/a", sandboxNetwork?: "ok" | "blocked" | "n/a", plist?: string,
  }>,
  fixes: Array<{ id: "wrapper" | "allow-rules" | "hermes-path" | "workspace-binding" | "keychain-downgrade", label, kind: "self" | "guide", applicable, reason?, instructions?,
    agentIds: string[] /* 文字中提到的 Agent（文字使用显示名称，如 Codex、Claude Code、OpenClaw） */ }>,
}> }
```

`POST /api/cli-tools/plan` `{ toolId, fixId, agents? }` → `{ planId, kind: "self", steps: [{ type: "write", path, backup, diff }], notes, agentIds, skipped: [{ agentId, agentName, reason }], expiresAt }`
或 `{ planId: null, kind: "guide" | "none", instructions?, message? }`；`POST /api/cli-tools/apply` `{ planId, confirm: true }` +
确认头 → `{ changed: [{ path, backup }], historyEntry /* 含 restorable */ }`。写入的修复只有两项：`~/.local/bin/lark-cli` 启动脚本
（`#!/bin/sh` + `exec "<原生程序真实路径>" "$@"`，已有文件先备份）和放行规则（Claude `permissions.allow`
`Bash(lark-cli *)`、Codex `~/.codex/rules/default.rules` 追加 `prefix_rule(pattern=["lark-cli"], decision="allow")`、
Gemini `tools.allowed`、已有配置的 Cursor CLI `permissions.allow` 与 OpenCode `permission.bash`；JSON 编辑保留其他键，
非标准 JSON 不改）。Hermes 网关 PATH、工作区绑定（`lark-cli config bind --source hermes|openclaw`）与钥匙串降级
（`lark-cli config keychain-downgrade`）只给指引，不改 launchd 配置，不碰机器人凭据。

体检报告新增 `library-drift`、`library-external-link`、`cli-version-skew`、`cli-workspace-unconfigured`、`cli-not-on-agent-path`。

## 历史、恢复与卸载

同步、导入与自更新的历史记录现在附带恢复所需的信息：每个写入的 `agentId`、`action`（create / replace）、真实目标、
备份位置，以及写入后的内容指纹 `afterHash`。旧记录没有这些字段，列出时标为不可恢复。

`GET /api/history?limit=50`（最多 500）→

```ts
{ entries: Array<{
  id: string, at: string | null, action: "sync" | "import" | "update" | "restore" | "uninstall" | "library" | "cli-fix" | string,
  skill: string | null, agents: string[], mode: "copy" | "symlink" | null,
  backups: Array<{ agentId, path /* ~/… */, target, restorable: boolean, reason? }>,
  trashId?: string,                 // uninstall：可从回收站恢复
  units?: Array<{ id, title }>,     // 按单元撤销的记录（技能库、CLI 修复、它们的恢复）
  restorable: boolean, reason?: string,
}> }
```

技能库执行与 CLI 修复的历史记录会保存每个已执行操作的记录（move / stash / unlink / link / write / command，不含文件
内容，路径与绝对链接目标都压缩为 `~/…`），以及操作后的指纹；`hermes config set` 之前会先给 `config.yaml` 拍快照。
这些记录按“单元”撤销：技能库每个条目一个单元，CLI 修复每个文件一个单元，单元内按相反顺序执行反向操作
（移回原位、重建链接、移除新建的链接、从备份恢复文件、把新建的文件移到备份），任一步失败即撤销本单元。

`POST /api/history/plan-restore` `{ historyId, select?: string[] }` →
`{ planId, historyId, steps: [{ type: "restore-backup" | "trash-created" | "restore-trash", agentId?, target, from?, precondition /* 当前内容指纹前 16 位，或 "absent" */, trashId? }], warnings, expiresAt }`；
按单元撤销的记录另返回 `units: [{ id, title, selected, conflict?, unrestorable?, steps: [{ type, path, from? }] }]`：
自那次操作后被改动过的路径（或原位置已被占用）标为 `conflict`，默认不选；在 `select` 中列出单元 id 才会恢复（覆盖前
仍先备份当前内容）。没有可直接恢复的单元时 `planId` 为 null。冲突说明只放在各自单元上：`warnings` 不逐条重复，
只在选中了有冲突的单元时给一条汇总（“选中的 N 项……当前内容会先备份”）。
replace 的反向是把备份放回原位（共享的真实目录只写一次），create 的反向是把创建出的目录移到回收站，卸载的反向是
从回收站恢复。目标在那次写入之后又被修改过（`afterHash` 不同）会给出警告。

`POST /api/history/apply-restore` `{ planId, confirm: true }` + `x-skill-manager-confirm: yes` →
`{ planId, restored: [{ agentId, path, backup }], trashed: [{ agentId, path, trashId }], historyEntry }`（按单元撤销时为
`{ planId, restoredUnits: [{ id, title }], historyEntry }`）。执行前逐个核对
目标指纹与生成计划时一致，否则 409；放回前先把当前内容备份到 `backups/<时间>-restore/`，所以这次恢复本身也会作为
`restore` 记录出现在历史里、可以再撤销。所有写入都经过写入保护。

`POST /api/skills/plan-uninstall` `{ skillId, agentId }` →
`{ planId, skillId, agentId, kind: "link" | "real", steps: [{ type: "unlink" | "move-to-trash", path, to?, description? }], alsoAffects: string[], warning?, expiresAt }`。
链接只移除链接本身；实体目录移到 `~/.agent-skill-manager/trash/<id>/` 并写清单；只读或托管的实例（Codex 内置、
插件缓存、Hermes 内置 / Hub、QClaw 同步等）拒绝并说明原因；目标必须在某个 Agent 技能目录或技能库内。
`alsoAffects`：删除实体目录时，经同一真实目录看到它的其他 Agent；删除链接时，经同一路径（共享根目录）看到它的
其他 Agent。`alsoAffects` 是 Agent id，`warning` 用展示名称（如“Claude Code 也会因此看不到这个技能。”）。
`POST /api/skills/apply-uninstall` `{ planId, confirm: true }` + 确认头 → `{ planId, trashId, historyEntry }`。

`GET /api/trash` → `{ items: [{ trashId, name, source: "library" | "uninstall" | "restore", agentId, kind: "real" | "link", originalPath, removedAt, links }] }`；
`POST /api/trash/restore` `{ trashId, confirm: true }` + 确认头 → `{ trashId, name, path, links }`（原位置必须仍在某个 Agent
技能目录或技能库内且为空）。`POST /api/library/restore` 保留，使用同一套回收站。

**默认可见的 Agent**：配置新增 `visibleCustomized`（默认 false）。在用户第一次修改可见 Agent 之前（`PUT /api/config`
中 `visibleAgentIds` 与当前不同，或请求显式带 `visibleCustomized: true`），所有检测到的 Agent 都可见，包括 Hermes、
OpenClaw、QClaw；修改后按用户的选择保存。状态判断仍只看常用 Agent。十几个 Agent 全部可见时，`scanAll`
冷启动与只有几个可见时相近（数百毫秒），内存缓存后更快，因此可见 Agent 仍做完整元数据与指纹。

`GET /api/scan` 的每个 Agent 新增 `iconAvailable: boolean`：只检查已知应用包是否存在并核对 Bundle ID 与图标文件，
不转换图标；前端只在为 true 时请求 `/api/agent-icon`（未知仍返回 404）。

## 错误码

所有错误响应为 `{ error: string /* 中文说明，主目录已压缩为 ~ */, code?: string }`。`code` 是机器可读的原因，界面按它
分类，旧服务没有 `code` 时才回退到按状态码和文案判断（`app/lib/plan-flow.ts` 的 `classifyApplyError`）。
计划保存在进程内存中（`server/plan-store.mjs`），10 分钟有效、只能执行一次。

| code | 状态 | 含义 | 界面处理 |
|---|---|---|---|
| `stale-plan` | 409 | 生成计划后目标指纹或前提变了（恢复目标被改动、更新前本地内容或锁文件被改、技能库 / CLI 操作时目标已被占用或不再是链接、同步目标变成软链接） | 自动重新生成计划并提示再看一遍 |
| `plan-expired` | 404 | 计划超过 10 分钟 | 同上 |
| `plan-not-found` | 404 | 计划 id 不存在、已执行过或类型不符 | 同上 |
| `updates-offline` | 409 | 离线模式下拒绝会联网的更新命令 | 显示错误 |
| `refused` | 409 / 400 | 策略拒绝：托管或只读技能不能卸载、目标不在技能目录内、修复项不适用、记录没有可恢复的写入、来源不能由本工具更新 | 显示错误 |
| `conflict` | 409 | 需要用户先处理的占用：另存目标已存在、回收站原位置已有同名条目、仓库有未提交的改动 | 显示错误 |
| `up-to-date` / `check-required` / `unsupported` / `too-large` / `missing-command` | 409 | 更新计划的前置条件不满足 | 显示错误 |
| `integrity` | 409 / 500 | 下载或写入后的校验失败，已停止并恢复 | 显示错误 |
| `backup-missing` / `nothing-to-do` | 409 | 恢复所需的备份已不存在 / 没有需要恢复的内容 | 显示错误 |
| `confirm-required` | 400 | 缺少 `confirm: true` 或确认头 | 显示错误 |
| `invalid-request` | 400 | 参数无效 | 显示错误 |
| `home-guard` / `command-not-allowed` / `forbidden` | 403 | 写入保护拒绝真实主目录 / 命令不在允许目录 / Host、Origin 或跨站检查不通过 | 显示错误 |
| `not-found` / `route-missing` | 404 | 对象不存在 / 接口不存在（旧版本服务，界面据此做功能探测） | 显示错误 / 降级 |

没有显式 `code` 的 403 / 404 / 409 分别默认为 `forbidden`、`not-found`、`conflict`；Node 的系统错误码（如 `ENOENT`）
不会透出。`ApiError` 带 `code`（旧服务为 null）。

## 桌面应用

打包后的应用拒绝 `navigator.clipboard`（会话的权限检查处理器返回 false，保持不变），复制走主进程：preload 在
`window.skillManagerDesktop` 上提供 `copyText(text): Promise<boolean>`，经 IPC `desktop:copy-text` 调用 Electron
`clipboard.writeText`。主进程只接受来自本应用主窗口顶层框架的请求，内容必须是字符串且 UTF-8 不超过 1 MB
（校验在 `desktop/copy-text.mjs`）。

### 应用自身更新

主进程负责全部更新步骤，界面只经 IPC 读状态（`desktop/app-updater.mjs` 控制流程，纯规则在
`desktop/app-update-core.mjs`，macOS 安装步骤在 `desktop/app-update-mac.mjs`）。preload 在
`window.skillManagerDesktop.appUpdate` 上提供 `status()`（不联网）、`check()`、`download()`、`install()`
（都返回状态、从不 reject）和 `onProgress(cb)`（每次状态变化都推送完整状态，返回取消订阅函数）。
IPC 通道 `desktop:app-update-*` 只接受本应用主窗口顶层框架、来源为应用自身地址、且不带参数的调用
（`desktop/ipc-guard.mjs`）。

```ts
{ status: "up-to-date" | "available" | "downloading" | "ready" | "error" | "unsupported",
  current, latest?, notes?, url?, publishedAt?, checkedAt?, error?,
  canInstall: boolean,                 // false 时界面改为“打开下载页”
  reason?: "offline" | "development" | "platform" | "portable" | "package" | "location",
  manual?, notice?, transferred?, total?, percent?, installing? }
```

- 来源：`GET https://api.github.com/repos/zifeixu85/skill-control/releases/latest`（草稿和预发布不会返回；
  404 或最新版本不比当前新都是 `up-to-date`）。启动 15 秒后在上次检查超过 24 小时时检查，之后每小时
  判断一次是否满 24 小时；手动 `check()` 一分钟内复用上次结果。结果存在 `userData/app-update.json`。
  `SKILL_MANAGER_UPDATES_OFFLINE=1`、源码运行（未打包）和冒烟测试都不检查。请求走 Electron `net.fetch`
  （遵循系统代理）。
- macOS（ad-hoc 签名，Squirrel.Mac 无法安装）：从 Release 资产读 `latest-mac.yml`（FAILSAFE 解析，
  各字段校验），按 `-mac-<arch>.zip` 选包，下载到系统临时目录的 `skill-control-update-*`（只接受本仓库
  的 Release 资产，最终地址必须在 GitHub 下载域名，大小与清单一致、≤ 1 GB，60 秒无数据即中止），
  校验 sha512，`/usr/bin/ditto -x -k` 解压，确认 `CFBundleIdentifier = dev.skillcontrol.desktop`、
  版本一致、可执行文件存在。安装：当前 `.app` 先在同一目录改名为
  `Skill Control <旧版本> (replaced <时间>).app`，新包移入原路径（跨卷时先 `ditto` 到隐藏的同级目录），
  再次校验；任何一步失败都把旧包放回。成功后用 `shell.trashItem` 把旧包移到废纸篓（失败则保留并在
  `notice` 里说明），由一个等待本进程退出的 `/bin/sh` 辅助进程执行 `open -n <路径>`，然后退出。
  应用在 App Translocation、DMG 等不可写位置时 `canInstall: false`，下载与安装改为打开下载页。
- Windows / Linux：只在这两个平台动态加载 electron-updater，显式构造 `NsisUpdater` / `AppImageUpdater`
  （`.deb` 不会用到 `DebUpdater`），关闭自动下载与退出时自动安装；便携版、`.deb`、缺少
  `resources/app-update.yml` 时只提供下载页。安装包未签名，状态里带 `notice` 提示 SmartScreen。
- 发布：`electron-builder.yml` 的 `publish`（GitHub）让构建生成 `latest*.yml` 与 `app-update.yml`，构建
  命令保持 `--publish never`；release workflow 上传 yml 和 blockmap，合并两个架构的 `latest-mac.yml`，
  由 `publish` job 创建 Release（notes 的 front matter `prerelease: true` 时为预发布）。

## 本地服务防护（新增）

- 除 Origin 检查外，所有请求的 `Host` 必须是 `127.0.0.1:<端口>`、`localhost:<端口>`
  或 `[::1]:<端口>`（端口为当前连接实际监听的端口），否则返回 403，用于阻止 DNS 重绑定。
- 错误信息在返回前会把主目录替换为 `~`；文件系统错误在插件图标、同步目标解析和复制中被
  转换为通用中文提示。
- 集成扫描器读取配置时使用 `O_NONBLOCK` 打开并校验普通文件，避免 FIFO 阻塞；对外字符串
  去除 `\p{Cf}` 格式字符（双向覆盖、零宽字符）并限制长度。
- `/api/config-detail`、`/api/capability-file` 和所有图片资源接口拒绝
  `Sec-Fetch-Site: cross-site` 请求（返回 403）。
- SVG 校验前先限制为 256 KB，所有匹配都有长度上限，CSS `url(...)` 通过线性扫描检查；
  文件列表中的软链接目标若是绝对路径，会转换为技能内相对路径、`~/…` 或省略。
- WorkBuddy 数据库以只读方式打开，并设置 `PRAGMA query_only = 1`。

## 本地接口一览（新增部分）

| 接口 | 返回 |
| --- | --- |
| `GET /api/scan` | 原有字段 + `primaryAgentIds`、`suggestedPrimaryAgentIds`、`effectivePrimaryAgentIds`、`agentActivity`、`sharedRoots`、`summary`、`archivedSkills`，Skill 上的新状态字段；Agent 新增 `installRoot`、`copyOnly`、`refuseInstall`、`archivedCount`、`managedBy`、`productVersion`；实例新增 `disabled`、`disabledOn`、`shadowed`、`shadowedBy`、`hiddenByProduct`、`usage`、`requirements`、`remote`、`profile` |
| `GET/PUT /api/config` | 新增 `primaryAgentIds: string[] \| null` |
| `GET /api/agents/activity` | `{ windowDays, rankedBy: "weight30d", agents: [{ agentId, status, basis, files30d, bytes30d, weight30d, activeDays30d, lastActiveAt, truncated }], suggestedPrimaryAgentIds, warnings }`；Hermes / OpenClaw / QClaw 的 `basis` 为 `tokens`（另有 `tokens30d`、`costUsd30d`，OpenClaw / QClaw 另有 `skillReads30d`；`weight30d = tokens × 4` 以便与会话字节数比较），缓存 10 分钟 |
| `GET /api/integrations` | `{ plugins, connectors, mcpServers, mcpMatrix, sources, relatedProducts, warnings, scannedAt }`；`plugins` 含 Codex、Claude Code、WorkBuddy、Hermes、OpenClaw 与 QClaw，缓存 60 秒，`?force=1` 刷新 |
| `GET /api/plugins` | `{ plugins, sources, warnings, scannedAt }`；Codex 与 Claude Code 插件共用同一结构（`id`、`agentId`、`displayName`、`enabled: true \| false \| "unknown"`、`version`、`components` 等） |
| `GET /api/mcp` | `{ servers, matrix, warnings, scannedAt }` |
| `GET /api/connectors` | 原 SmartOrder 结构不变，新增 `codex: { available, source, cachedAt, connectors, warnings }` |
| `GET /api/plugin-asset?id=` | 插件清单引用的图标二进制；未知 ID 返回 404 |
| `GET /api/capabilities` | 专家条目新增 `origin`（`mine` / `market` / `profile`）、`version`、`installed`、`inUse`、`installedVersion`、`packaged`、`skills`、`defaultPrompt`、`quickPrompts`、`avatar`、`used`，成员新增 `avatar` |
| `GET /api/expert-avatar?id=` | 专家与成员头像（PNG/JPEG/SVG ≤ 2 MB）；未知 ID 返回 404 |
| `GET /api/config-detail` | 见“配置详情（只读、脱敏）” |
| `GET /api/agent-files`、`/api/agent-file` | 见“洞察接口 · Agent 文件” |
| `GET /api/agent-tools` | 见“洞察接口 · Agent 工具” |
| `GET /api/usage/summary`、`/api/usage/skill`、`/api/usage/agent`、`/api/usage/models`、`/api/usage/projects`、`/api/usage/pricing`、`/api/usage/status` | 见“洞察接口 · 用量分析” |
| `GET /api/agent-versions`、`POST /api/agent-versions/check`、`/api/agent-versions/plan`、`/api/agent-versions/apply`、`/api/agent-versions/open` | 见“Agent 产品版本” |
| `POST /api/agents/acknowledge`、`GET /api/agents/discover`、`GET /api/secrets`、`GET /api/usage/totals` | 见“v0.2 后台新增” |
| `GET /api/health-report` | 见“洞察接口 · 体检报告” |
| `GET /api/agent-icon` | 见“洞察接口 · 应用图标” |
| `GET /api/updates`、`/api/updates/check-status`、`/api/updates/changes`；`POST /api/updates/check`、`/api/updates/plan`、`/api/updates/apply` | 见“更新检测与执行” |
| `GET/PUT /api/config` | 新增 `updates: { useGhAuth: boolean }`（默认 false） |
| `GET /api/library`；`POST /api/library/plan`、`/api/library/apply`、`/api/library/restore` | 见“统一技能库与 CLI 工具卡片” |
| `GET /api/cli-tools`；`POST /api/cli-tools/plan`、`/api/cli-tools/apply` | 同上 |
| `GET /api/history`、`/api/trash`；`POST /api/history/plan-restore`、`/api/history/apply-restore`、`/api/skills/plan-uninstall`、`/api/skills/apply-uninstall`、`/api/trash/restore` | 见“历史、恢复与卸载” |
| `GET /api/scan` | Agent 新增 `iconAvailable` |
| `GET/PUT /api/config` | 新增 `visibleCustomized`（见“历史、恢复与卸载”中的默认可见规则） |
| `POST /api/sync`、`/api/import-install` | 动作新增 `realDestination`、`viaSymlink`、`reason`、`sharedWithAgentId`、`alsoVisibleTo`、`skippedLinks`；计划新增 `sharedDestinations`、`warnings` |

## 已知架构限制

- `server/local-server.mjs` 目前同时包含领域逻辑和 HTTP 路由，后续可在保持测试覆盖的
  前提下拆分；
- 导入预览文件和备份还没有自动保留期限；
- 源码模式使用固定开发端口；桌面进程会验证默认管理端口的服务身份，被占用时自动
  选择空闲回环端口，并只把地址暴露给隔离的 renderer API；
- 当前没有远程 Skill 目录、用户账户或云同步。

限制列表用于帮助贡献者判断影响，不代表对应路线图已经承诺交付。
