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
| `server/local-server.mjs` | 配置、Skill 与专家扫描、指纹、文件读取、`.skill`、同步与备份 |
| `server/scan-worker.mjs` | 在后台线程执行目录扫描和指纹计算，避免阻塞桌面主进程 |
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
7. 扫描结果在内存中缓存 5 分钟；明确刷新、配置变化和写入完成会使缓存失效。
8. 文件路径、大小、修改时间未变化时复用
   `~/.agent-skill-manager/fingerprint-cache.json` 中的内容指纹；明确刷新会重新
   校验展示中的 Skills。

新增聚合字段时，应同步更新前端 TypeScript 类型、空状态、筛选逻辑和测试。

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

## 已知架构限制

- `server/local-server.mjs` 目前同时包含领域逻辑和 HTTP 路由，后续可在保持测试覆盖的
  前提下拆分；
- 导入预览文件和备份还没有自动保留期限；
- 源码模式使用固定开发端口；桌面进程会验证默认管理端口的服务身份，被占用时自动
  选择空闲回环端口，并只把地址暴露给隔离的 renderer API；
- 当前没有远程 Skill 目录、用户账户或云同步。

限制列表用于帮助贡献者判断影响，不代表对应路线图已经承诺交付。
