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
│ app/page.tsx + app/globals.css              │
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
| `app/page.tsx` | 页面状态、Agent 切换、详情、导入和同步交互 |
| `app/globals.css` | 视觉系统、布局、响应式与组件状态 |
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
  原日期目录中的 rollout 文件（本机近 30 天写入的 8.8 GB 中有 3.7 GB 位于 30 天前的
  日期目录，最早 89 天前），因此日期目录只在超过一年时才剪枝，而不是按 30 天窗口剪枝。
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

Markdown 渲染在前端通过 `react-markdown` 和 `remark-gfm` 完成。不要直接把
Skill 中的 HTML 注入 DOM。图片资源只从当前 Skill 或短期导入预览目录读取，
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

来源（只列出存在的文件）：Codex `~/.codex/AGENTS.md`、`AGENTS.override.md`、`rules/*.rules`、
`memories/*.md`、`memories/rollout_summaries/*.md`（最近 50 个）；Claude Code `~/.claude/CLAUDE.md`、
`projects/*/memory/*.md`（最近 50 个）、`rules/**/*.md`（4 层、200 个）、`agents/*.md`、`commands/` 下两层内的 `*.md`；
WorkBuddy `~/.workbuddy/{SOUL,IDENTITY,USER,MEMORY,AGENTS}.md`；Gemini `~/.gemini/GEMINI.md`；
Cursor `~/.cursor/rules/**/*.{md,mdc}`；Hermes（按 profile）`SOUL.md`、`AGENTS.md`、`profile.yaml`、
`memories/*.md`、`cron/jobs.json`（只渲染名称、计划、状态、技能、工具集、上次/下次运行，不含提示词、
脚本、错误与投递目标）；OpenClaw/QClaw（按 agent）工作区 `AGENTS.md`、`SOUL.md`、`IDENTITY.md`、
`USER.md`、`TOOLS.md`、`HEARTBEAT.md`、`BOOTSTRAP.md`、`BOOT.md`、`MEMORY.md`、`memory/*.md`
（最近 50 个），`<stateDir>/agents/<id>/*.md` 与 `<stateDir>/{AGENTS,LUMICLAW}.md`。工作区必须位于
主目录内。

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

| 来源 | token | 技能 | 可信度 |
| --- | --- | --- | --- |
| Claude Code `~/.claude/projects/**/*.jsonl`（含子代理） | assistant 消息 `usage`（按消息 ID 全局去重） | `Skill` 工具调用（按调用 ID 去重）；`attributionSkill` 的 token | exact |
| Codex `~/.codex/sessions/**`、`archived_sessions/*` | `token_count` 累计值的差；分叉/续接会话的首条与回退后只计 `last_token_usage` | 函数调用参数中出现的 `skills/<名称>/SKILL.md`（从不看输出） | token exact，技能 inferred |
| WorkBuddy `~/.workbuddy/projects/**/*.jsonl` | `message.usage`（输入扣除缓存命中） | `Skill` 调用；`usage-log.json` 的使用日期补足未覆盖的日子 | exact / reported |
| WorkBuddy `workbuddy.db` | — | — | `session_usage.credit_json` 合计为 `credits`（reported） |
| Hermes `state.db` | `sessions` 表 token 与费用（只读、`query_only`） | `skills/.usage.json` 计数，每次运行的增量计入当天 | reported |
| OpenClaw/QClaw `sessions.json` | 会话 token 与费用 | 会话 JSONL 中工具调用读取的 SKILL.md | token reported，技能 inferred |

每轮索引有 3 秒预算，按修改时间从新到旧处理，每轮至少推进一个文件；服务在后台线程中连续分片执行直到
完成，此后请求发现索引超过 60 秒未更新时再增量刷新。会话文件被产品删除后其汇总仍保留（保留 400 天）；
文件被截短或头部变化时重新统计该文件。本机实测：约 2,000 个文件、22.7 GB 首次索引约 38 秒，增量约 0.1 秒，
索引约 1.4 MB。

`GET /api/usage/status`

```ts
{ state: "idle" | "indexing" | "partial" | "complete" | "error", indexedFiles, totalFiles, indexedBytes, totalBytes,
  lastRunAt: string | null, lastRunMs: number | null, updatedAt: string | null, error: string | null }
```

`GET /api/usage/summary?days=30`（`days` 取 1–400，默认 30）

```ts
{
  generatedAt, windowDays,
  index: { complete: boolean, updatedAt: string | null, indexedFiles: number, totalFiles: number },
  status: /* 同 /api/usage/status */,
  agents: Array<{
    agentId, sessions, activeDays,
    tokens: { input, output, cacheRead, cacheWrite, total },   // input 不含缓存命中
    costUsd: number | null,                                     // 只有 Hermes / OpenClaw / QClaw 有费用
    credits?: number,                                           // 仅 WorkBuddy
    series: Array<{ date: "YYYY-MM-DD", sessions, tokens }>,    // 每天一项（本地日期），tokens 为合计
    sources: Array<{ id: "tokens" | "skills" | "credits", label, confidence: "exact" | "inferred" | "reported" }>,
  }>,
  topSkills: Array<{ name, count, tokens, agents: Array<{ agentId, count, confidence, lastUsedAt: "YYYY-MM-DD" }> }>, // ≤ 50
}
```

`GET /api/usage/skill?name=<技能名>&days=90`（名称也匹配 `插件:技能` 的后半段）

```ts
{ name, windowDays, index, status,
  agents: Array<{ agentId, name, total, tokens, lastUsedAt, confidence, reportedTotal?: number /* Hermes 累计 */,
                  series: Array<{ date, count }> }> }
```

`GET /api/usage/agent?id=<agentId>&days=90`

```ts
{ agentId, windowDays, index, status,
  totals: { sessions, activeDays, tokens: { input, output, cacheRead, cacheWrite, total }, costUsd: number | null },
  series: Array<{ date, sessions, tokens: { input, output, cacheRead, cacheWrite, total } }>,
  topSkills: Array<{ name, count, tokens, lastUsedAt, confidence }>,       // ≤ 30
  topProjects: Array<{ name /* 工作目录最后一段 */, sessions, tokens }>,   // ≤ 20
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
  }>,
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
cursor、trae、hermes、qclaw、lumiclaw、moticlaw、smartorder、kiro、windsurf）；读取 `CFBundleIconFile`，
图标文件必须位于应用包内且不超过 20 MB；用 `/usr/bin/sips`（参数数组，不经 shell，10 秒超时）转换，
结果须是 ≤ 512 KB 的 PNG，缓存在 `~/.agent-skill-manager/icons/<id>-<摘要>.png`，应用更新后自动重新转换。
测试通过 `SKILL_MANAGER_APPLICATION_DIRS` 指向临时目录，从不读取真实的 `/Applications`。

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

测试与本地调试：`SKILL_MANAGER_UPDATES_OFFLINE=1` 让检查不联网；`SKILL_MANAGER_COMMAND_DIRS` 固定可查找与可执行
命令的目录，设置后目录之外的二进制一律拒绝执行（测试服务器两者都设置，PATH 只保留系统目录）。

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

`POST /api/library/plan` `{ action: "adopt" | "link" | "unlink" | "disable" | "remove" | "batch", skill?, agents?, choice?, choices?: Record<itemId, choice>, from? }` →

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
`{ planId, results: [{ id, title, status: "applied" | "failed" | "rolled-back", error?, trashId? }], backups, visibility: Record<skill, fanout>, historyEntry }`。
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
    agentId, pathSource: string, resolves: { path, version } | null,
    // 仅 lark-cli：
    workspace?: "local" | "hermes" | "openclaw", workspaceConfigured?: boolean, secretSource?: string | null,
    keychainReachable?: "yes" | "needs-downgrade" | "unknown", skill?: { name, inLibrary, visible },
    allowRule?: "present" | "missing" | "n/a", sandboxNetwork?: "ok" | "blocked" | "n/a", plist?: string,
  }>,
  fixes: Array<{ id: "wrapper" | "allow-rules" | "hermes-path" | "workspace-binding" | "keychain-downgrade", label, kind: "self" | "guide", applicable, reason?, instructions? }>,
}> }
```

`POST /api/cli-tools/plan` `{ toolId, fixId, agents? }` → `{ planId, kind: "self", steps: [{ type: "write", path, backup, diff }], notes, skipped, expiresAt }`
或 `{ planId: null, kind: "guide" | "none", instructions?, message? }`；`POST /api/cli-tools/apply` `{ planId, confirm: true }` +
确认头 → `{ changed: [{ path, backup }], historyEntry }`。写入的修复只有两项：`~/.local/bin/lark-cli` 启动脚本
（`#!/bin/sh` + `exec "<原生程序真实路径>" "$@"`，已有文件先备份）和放行规则（Claude `permissions.allow`
`Bash(lark-cli *)`、Codex `~/.codex/rules/default.rules` 追加 `prefix_rule(pattern=["lark-cli"], decision="allow")`、
Gemini `tools.allowed`、已有配置的 Cursor CLI `permissions.allow` 与 OpenCode `permission.bash`；JSON 编辑保留其他键，
非标准 JSON 不改）。Hermes 网关 PATH、工作区绑定（`lark-cli config bind --source hermes|openclaw`）与钥匙串降级
（`lark-cli config keychain-downgrade`）只给指引，不改 launchd 配置，不碰机器人凭据。

体检报告新增 `library-drift`、`library-external-link`、`cli-version-skew`、`cli-workspace-unconfigured`、`cli-not-on-agent-path`。

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
| `GET /api/usage/summary`、`/api/usage/skill`、`/api/usage/agent`、`/api/usage/status` | 见“洞察接口 · 用量分析” |
| `GET /api/health-report` | 见“洞察接口 · 体检报告” |
| `GET /api/agent-icon` | 见“洞察接口 · 应用图标” |
| `GET /api/updates`、`/api/updates/check-status`、`/api/updates/changes`；`POST /api/updates/check`、`/api/updates/plan`、`/api/updates/apply` | 见“更新检测与执行” |
| `GET/PUT /api/config` | 新增 `updates: { useGhAuth: boolean }`（默认 false） |
| `GET /api/library`；`POST /api/library/plan`、`/api/library/apply`、`/api/library/restore` | 见“统一技能库与 CLI 工具卡片” |
| `GET /api/cli-tools`；`POST /api/cli-tools/plan`、`/api/cli-tools/apply` | 同上 |
| `POST /api/sync`、`/api/import-install` | 动作新增 `realDestination`、`viaSymlink`、`reason`、`sharedWithAgentId`、`alsoVisibleTo`、`skippedLinks`；计划新增 `sharedDestinations`、`warnings` |

## 已知架构限制

- `server/local-server.mjs` 目前同时包含领域逻辑和 HTTP 路由，后续可在保持测试覆盖的
  前提下拆分；
- 导入预览文件和备份还没有自动保留期限；
- 源码模式使用固定开发端口；桌面进程会验证默认管理端口的服务身份，被占用时自动
  选择空闲回环端口，并只把地址暴露给隔离的 renderer API；
- 当前没有远程 Skill 目录、用户账户或云同步。

限制列表用于帮助贡献者判断影响，不代表对应路线图已经承诺交付。
