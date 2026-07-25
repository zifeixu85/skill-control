# 第三方声明 / Third-Party Notices

Skill Control 使用开源第三方软件。各第三方组件仍受其各自许可证约束；本项目的
MIT License 不会替代这些许可证。

Skill Control uses third-party open-source software. Each component remains
subject to its own license; the project's MIT License does not replace those
terms.

## JavaScript 与桌面依赖

直接和传递依赖记录在 `package.json` 与 `package-lock.json` 中，包括但不限于
Electron、React、Vinext、Vite、Tailwind CSS、fflate、react-markdown 和
remark-gfm。准确版本以对应 Release 的 lockfile 和构建记录为准。

Direct and transitive JavaScript dependencies are recorded in `package.json`
and `package-lock.json`. The lockfile and build record for a release are the
authoritative source for exact versions.

桌面运行时包含 Vinext 代码，其许可证副本位于：

```text
resources/licenses/vinext-LICENSE
```

Electron 和 electron-builder 生成的产物还可能包含其运行时许可证和 Chromium
相关声明。重新分发修改后的安装包时，请保留产物中的全部许可证文件，并重新审计
修改后依赖的许可证义务。

The packaged runtime includes Vinext code; its license is preserved in
`resources/licenses/vinext-LICENSE`. Electron-generated artifacts may also
contain runtime and Chromium notices. Keep all included license files when
redistributing a modified build and audit the licenses of any dependencies you
add.

## 产品与商标名称

Codex、Claude Code、WorkBuddy、Cursor、Gemini、Kiro、Trae、OpenCode、
Windsurf、Cline、Roo Code、CodeBuddy、Qwen Code 和 GitHub Copilot 等名称
仅用于描述兼容的本地目录与互操作目标。相关商标归各自权利人所有。除非另有明确
说明，Skill Control 与这些产品的所有者没有隶属、赞助或背书关系。

Product names are used only to describe compatible local directories and
interoperability targets. Their trademarks belong to their respective owners.
No affiliation, sponsorship, or endorsement is implied unless expressly
stated.

## 发现遗漏

如果你发现发布产物缺少应保留的许可证或声明，请创建 Bug 报告；若遗漏可能造成
供应链或法律风险，也可以按照 [SECURITY.md](./SECURITY.md) 私下联系维护者。

If a release artifact is missing a required notice, open a Bug report. If the
omission creates a supply-chain or security risk, contact the maintainers
privately as described in [SECURITY.md](./SECURITY.md).
