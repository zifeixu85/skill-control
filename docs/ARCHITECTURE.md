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
| `server/claude-plugins.mjs` | 只读解析 Claude Code 已安装插件、作用域、启用状态与组件 |
| `server/mcp-inventory.mjs` | 只读汇总 Codex / Claude Code / Cursor / Gemini 的 MCP 服务器 |
| `server/integrations.mjs` | 聚合插件、连接器与 MCP，供 `/api/integrations` 使用 |
| `server/fs-safe.mjs` | 集成扫描共用的限长读取、真实路径边界与 MCP 传输类型判断 |
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

- WorkBuddy 从本机专家插件目录读取 `.codebuddy-plugin/plugin.json`、`agents/*.md`
  和包内资源，优先使用中文名称与介绍；
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
- **Claude Code 插件**（`server/claude-plugins.mjs`）：读取
  `~/.claude/plugins/installed_plugins.json`（v2）、`known_marketplaces.json`
  （仅来源类型）和 `~/.claude/settings.json` 的 `enabledPlugins`。`installPath` 必须解析到
  `~/.claude/plugins` 内，否则跳过；统计 skills、agents、commands、hooks 与 MCP 名称。
  只有 user 作用域能从用户设置判断启用状态；local/project 作用域以及设置中未出现的插件
  为 `enabled: "unknown"`（不打开项目内的设置文件）。
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

## 本地服务防护（新增）

- 除 Origin 检查外，所有请求的 `Host` 必须是 `127.0.0.1:<端口>`、`localhost:<端口>`
  或 `[::1]:<端口>`（端口为当前连接实际监听的端口），否则返回 403，用于阻止 DNS 重绑定。
- 错误信息在返回前会把主目录替换为 `~`；文件系统错误在插件图标、同步目标解析和复制中被
  转换为通用中文提示。
- 集成扫描器读取配置时使用 `O_NONBLOCK` 打开并校验普通文件，避免 FIFO 阻塞；对外字符串
  去除 `\p{Cf}` 格式字符（双向覆盖、零宽字符）并限制长度。

## 本地接口一览（新增部分）

| 接口 | 返回 |
| --- | --- |
| `GET /api/scan` | 原有字段 + `primaryAgentIds`、`suggestedPrimaryAgentIds`、`effectivePrimaryAgentIds`、`agentActivity`、`sharedRoots`、`summary`，Skill 上的新状态字段 |
| `GET/PUT /api/config` | 新增 `primaryAgentIds: string[] \| null` |
| `GET /api/agents/activity` | `{ windowDays, rankedBy: "bytes30d", agents: [{ agentId, status, files30d, bytes30d, activeDays30d, lastActiveAt, truncated }], suggestedPrimaryAgentIds, warnings }`，缓存 10 分钟 |
| `GET /api/integrations` | `{ plugins, connectors, mcpServers, mcpMatrix, sources, warnings, scannedAt }`，缓存 60 秒，`?force=1` 刷新 |
| `GET /api/plugins` | `{ plugins, sources, warnings, scannedAt }`；Codex 与 Claude Code 插件共用同一结构（`id`、`agentId`、`displayName`、`enabled: true \| false \| "unknown"`、`version`、`components` 等） |
| `GET /api/mcp` | `{ servers, matrix, warnings, scannedAt }` |
| `GET /api/connectors` | 原 SmartOrder 结构不变，新增 `codex: { available, source, cachedAt, connectors, warnings }` |
| `GET /api/plugin-asset?id=` | 插件清单引用的图标二进制；未知 ID 返回 404 |
| `POST /api/sync`、`/api/import-install` | 动作新增 `realDestination`、`viaSymlink`、`reason`、`sharedWithAgentId`、`alsoVisibleTo`、`skippedLinks`；计划新增 `sharedDestinations`、`warnings` |

## 已知架构限制

- `server/local-server.mjs` 目前同时包含领域逻辑和 HTTP 路由，后续可在保持测试覆盖的
  前提下拆分；
- 导入预览文件和备份还没有自动保留期限；
- 源码模式使用固定开发端口；桌面进程会验证默认管理端口的服务身份，被占用时自动
  选择空闲回环端口，并只把地址暴露给隔离的 renderer API；
- 当前没有远程 Skill 目录、用户账户或云同步。

限制列表用于帮助贡献者判断影响，不代表对应路线图已经承诺交付。
