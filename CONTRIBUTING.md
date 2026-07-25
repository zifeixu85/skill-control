# 参与贡献 / Contributing

感谢你愿意改进 Skill Control。Bug 修复、Agent 目录适配、可访问性改进、测试和文档
都很有价值。

Thank you for improving Skill Control. Bug fixes, Agent directory adapters,
accessibility improvements, tests, and documentation are all welcome.

## 开始之前 / Before you start

- 小型修复可以直接提交 Pull Request。
- 大型功能、依赖替换、数据格式变化或 UI 重构，请先创建 Feature Request，说明问题、
  使用场景和备选方案。
- 安全漏洞不要创建公开 Issue，请按照 [SECURITY.md](./SECURITY.md) 私下报告。
- 请确认改动没有包含真实 Skill 内容、用户名、主目录、访问令牌或其他个人数据。

For a small, focused fix, a Pull Request is enough. Please open a Feature
Request before a large feature, dependency replacement, data-format change, or
UI rewrite. Report vulnerabilities privately as described in
[SECURITY.md](./SECURITY.md).

## 本地开发 / Local development

要求 Node.js `22.13.0` 或更高版本。

```bash
git clone https://github.com/zifeixu85/skill-control.git
cd skill-control
npm install
npm run dev
```

提交前运行：

```bash
npm run lint
npm test
```

`npm test` 会先构建应用，再运行 Node 测试。涉及 UI 的改动还需要在浏览器中验证
主要交互和至少一个窄屏尺寸。

Before submitting, run both `npm run lint` and `npm test`. UI changes should
also be checked interactively at a normal desktop size and at least one narrow
viewport.

## 分支与提交 / Branches and commits

1. 从最新的 `main` 创建短期分支。
2. 一次 Pull Request 只解决一个清晰问题。
3. 使用能说明动机的提交信息，例如：

```text
fix: keep collapsed directories closed in Skill details
feat: add an Agent directory preset
docs: clarify .skill archive limits
```

4. 不要提交 `node_modules`、构建产物、本地状态、真实备份或导入预览。
5. 如果行为发生变化，同时更新测试和中英文 README。

Conventional Commit prefixes are encouraged but not required. Keep each Pull
Request focused and update tests and both README languages when behavior
changes.

## 必须保持的安全边界 / Security invariants

Skill Control 会读取和写入用户的本地文件。以下约束不是可选项：

- 本地管理服务默认只能监听回环地址，不得静默暴露到局域网或公网；
- 扫描和读取必须限制在用户配置的 Agent/Skill 根目录内；
- 所有来自 `.skill` 包或 HTTP 参数的路径必须做规范化和路径边界检查；
- 导入限制（压缩包、文件数量、单文件和解压总量）只能收紧，放宽时必须说明风险并
  添加测试；
- 替换现有 Skill 前必须成功创建备份；
- 同步和导入必须先生成计划，只有用户明确确认后才能写入；
- 不得在日志、API 响应或错误报告中泄露不必要的绝对路径或 Skill 内容；
- 不得未经明确讨论和用户同意加入遥测、远程内容上传或静默更新；
- 软链接功能必须清楚说明多个工具共享同一份内容的影响。

The local manager handles user files. Loopback-only networking, path-boundary
checks, archive limits, pre-replacement backups, dry-run plans, and explicit
confirmation are required invariants. A change that weakens one of these must
include a clear threat analysis, focused tests, and maintainer approval.

## UI 与文案 / UI and copy

- 界面以中文为主，操作名称应具体，例如“生成同步计划”，避免无法解释的状态文案；
- 中文名称或介绍存在时优先显示，但技术名称必须仍然可查看；
- 常规正文以 `14px` 为基准，任何可见文字不得小于 `12px`；
- 保持键盘可操作、可见焦点、语义化标签和足够的颜色对比度；
- 弹窗应有清楚的标题、关闭方式、加载状态、失败状态和不可逆操作说明；
- 避免页面和弹窗中出现互相竞争的多重滚动区域；
- 新文案应避免承诺尚未验证的平台、安装包或安全能力。

The primary UI language is Chinese. Preserve keyboard access, visible focus,
semantic labels, sufficient contrast, explicit loading/error states, and the
12 px minimum text size. Do not advertise an unverified capability.

## 测试建议 / Testing guidance

根据改动范围补充测试：

- frontmatter 和中文元数据解析；
- 多 Agent 聚合、覆盖率和冲突状态；
- 路径穿越、软链接和目录边界；
- `.skill` 根目录布局、Unicode 文件名、体积与数量限制；
- 同步/导入的 dry run、确认标记、备份和 no-op；
- 服务端渲染的基础页面壳；
- UI 的关键空状态、错误状态和键盘交互。

测试只能使用临时目录和虚构内容，不能依赖贡献者真实的 `~/.codex` 或
`~/.claude` 数据。

Tests must use temporary directories and synthetic fixtures. They must never
depend on a contributor's real Agent directories.

## Pull Request 检查表 / Pull Request checklist

提交前请确认：

- [ ] 改动范围清晰，没有混入无关格式化；
- [ ] `npm run lint` 通过；
- [ ] `npm test` 通过；
- [ ] 新行为有相应测试，或 PR 说明了无法自动测试的原因；
- [ ] 没有真实路径、Skill 内容、凭据或个人数据；
- [ ] 用户可见变化已更新相关文档；
- [ ] UI 变化附带截图或短视频；
- [ ] 文件写入变化保留预览、明确确认和备份边界。

## 审查与合并 / Review and merge

维护者会重点检查用户数据安全、跨平台影响、交互完整度和回归测试。收到审查意见后，
请继续在同一个分支更新；不需要关闭后重新创建 PR。满足检查项并获得维护者批准后，
由维护者合并。

Maintainers review changes for local-data safety, cross-platform impact,
interaction completeness, and regression coverage. Continue pushing revisions
to the same branch until the Pull Request is ready to merge.
