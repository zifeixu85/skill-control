# GitHub 仓库配置清单

目标仓库：`zifeixu85/skill-control`

代码文件本身不能保证 GitHub 仓库设置正确。首次公开仓库时，维护者应在 GitHub
网页或 `gh` CLI 中完成下面的配置。

## 基本信息

- Visibility：`Public`
- Default branch：`main`
- Description：

```text
Local-first desktop manager for Skills shared across AI coding agents.
```

- Website：首版可以留空，后续指向产品主页；
- Topics：

```text
agent-skills
codex
claude-code
electron
local-first
skill-manager
developer-tools
```

- 启用 Issues；
- 需要社区问答时启用 Discussions；
- 保留 Releases 和 Packages 的默认可见性。

公开前检查 Git 历史，确认任何提交中都没有访问令牌、证书、`.env`、真实 Skill、
用户主目录、备份或其他私人资料。仅删除当前文件不足以清除历史中的秘密。

## 合并设置

早期项目建议：

- 启用 Squash merge；
- 可保留 Rebase merge；
- 关闭 Merge commit，保持 `main` 历史简洁；
- 合并后自动删除 head branch；
- 启用“Automatically update pull request branches”可以减少过期分支。

## `main` 保护

在首个 CI workflow 成功运行后创建 branch ruleset：

- 禁止 force push 和删除 `main`；
- 要求 Pull Request 才能合并；
- 要求所有对话已解决；
- 要求实际存在的 lint/test/build 检查通过；
- 要求分支在合并前保持最新（如果 CI 成本可接受）；
- 至少一位审查者仅在有第二位维护者后启用，避免单维护者仓库无法发布紧急修复；
- 保留维护者处理紧急安全发布的受审计 bypass 权限。

不要预先填写一个尚不存在的 required check 名称，否则仓库可能无法合并任何 PR。

## 安全设置

在 Settings → Security 中启用：

- Dependency graph；
- Dependabot alerts；
- Dependabot security updates；
- Secret scanning 和 push protection（公开仓库可用时）；
- Private vulnerability reporting。

私密漏洞入口启用后，检查 [SECURITY.md](../SECURITY.md) 与 Issue 模板中的链接可以
打开报告表单。

GitHub Actions：

- 默认使用最小 `GITHUB_TOKEN` 权限；
- 普通测试 workflow 只需要 `contents: read`；
- Release workflow 仅在发布 job 中使用 `contents: write`；
- 第三方 Action 固定到可信版本，重要发布流程优先固定完整 commit SHA；
- 签名、公证和发布密钥只放在 GitHub Environments/Secrets，不写入仓库；
- 当前自动流程在全部目标平台原生冒烟通过后直接发布，不绑定 Environment；
- 后续若引入签名密钥或人工闸门，应先让发布 job 使用受保护的 Environment，再为
  该 Environment 配置审批和 Secrets。

## 标签

Issue Forms 和自动 Release notes 会使用以下标签。新仓库中的默认标签不足时，需手动
补齐：

| 标签 | 用途 |
| --- | --- |
| `bug` | 可复现缺陷 |
| `enhancement` | 功能建议 |
| `feature` | 已接受的新功能 |
| `security` | 可公开的安全修复跟踪 |
| `agent-adapter` | Agent 路径和兼容性 |
| `design` | 视觉与交互 |
| `accessibility` | 可访问性 |
| `documentation` | 文档 |
| `skip-changelog` | 不进入自动 Release notes |
| `needs-reproduction` | 等待最小复现 |
| `help-wanted` | 欢迎社区实现 |
| `good-first-issue` | 范围明确的新贡献者任务 |
| `dependencies` | 依赖与供应链维护 |

不要为未修复漏洞创建公开 `security` Issue；它应先进入 Private vulnerability
reporting。

## 首版发布前

- [ ] 仓库已公开，README 的语言切换和所有相对链接可用；
- [ ] License 在 GitHub 仓库首页被正确识别为 MIT；
- [ ] Issue Forms 与 PR 模板正常显示；
- [ ] Private vulnerability reporting 已启用；
- [ ] CI 在 `main` 上通过，实际检查已加入 ruleset；
- [ ] `package.json`、Changelog、Git tag 和 Release 版本一致；
- [ ] 每个平台只上传通过 [发布指南](./RELEASING.md) 冒烟测试的产物；
- [ ] Release notes 明确签名、公证和已知限制；
- [ ] 从公开 Release 下载并重新验证 SHA-256；
- [ ] 使用无维护者权限的浏览器窗口验证代码、Issue 和 Release 可公开访问。

## 社区维护

- 定期分类没有标签的 Issue；
- 对无法复现的问题说明还需要哪些信息；
- 路线图变化通过 Issue 或 Discussion 留下可追踪的决定；
- 每个 Release 后更新 Changelog；
- 至少每季度检查依赖告警、私密安全报告和仓库权限；
- 维护者变化同步更新 [GOVERNANCE.md](../GOVERNANCE.md)。
