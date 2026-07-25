# 安全政策 / Security Policy

Skill Control 可以读取和修改本地 Agent Skill 目录。我们会把路径边界、压缩包解析、
备份与明确确认等问题作为安全问题处理。

Skill Control reads and can modify local Agent Skill directories. Path
boundaries, archive parsing, backups, and explicit confirmation are treated as
security-sensitive behavior.

## 支持版本 / Supported versions

在首个稳定版之前，仅维护最新的 `0.1.x` 版本和 `main` 分支。安全修复不会保证回移
到更早的预览版本。

| Version | Supported |
| --- | --- |
| latest `0.1.x` | Yes |
| older previews | No |

Before the first stable release, only the latest `0.1.x` release and `main`
receive security fixes.

## 私下报告漏洞 / Report a vulnerability privately

请不要为尚未修复的漏洞创建公开 Issue。使用 GitHub 的
[Private vulnerability reporting](https://github.com/zifeixu85/skill-control/security/advisories/new)
提交报告。如果该入口不可用，请通过仓库所有者 GitHub 个人资料中的联系方式建立
私人联系。

Do not open a public Issue for an unpatched vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/zifeixu85/skill-control/security/advisories/new).
If it is unavailable, contact the repository owner privately through the
contact details on their GitHub profile.

报告最好包含：

- 受影响的版本、操作系统和安装方式；
- 最小复现步骤或概念验证；
- 实际影响以及攻击者需要具备的条件；
- 可能受影响的本地目录或数据；
- 如果已知，可行的修复或缓解方法。

Please include the affected version and platform, minimal reproduction steps,
impact and prerequisites, affected local data, and any known mitigation.

我们会尽量在 5 个工作日内确认收到报告，在完成初步分析后告知严重程度和后续计划。
修复发布前，请为用户保留合理的修复窗口，不要公开利用细节。本项目当前不提供漏洞
赏金，也不能承诺支付奖励。

We aim to acknowledge a report within five business days and will share
severity and next steps after initial triage. Please coordinate disclosure so
users have a reasonable opportunity to update. This project does not currently
operate a paid bug-bounty program.

## 安全范围 / Security scope

以下情况通常属于安全问题：

- 通过 `.skill` 文件实现路径穿越、任意文件写入或资源耗尽；
- 绕过同步/导入确认，或在没有备份的情况下覆盖目录；
- 越过配置的 Skill 根目录读取文件；
- 本地管理接口被非允许来源调用，或被意外暴露到公网；
- 跨站脚本、命令注入、权限提升或敏感数据泄露；
- 更新包或发布产物的供应链完整性问题。

Requests for a new feature, ordinary UI defects, documentation mistakes, and
expected behavior of intentionally created symbolic links should normally use a
regular Issue unless they create a confidentiality, integrity, or availability
impact.

## 当前安全边界 / Current security boundaries

- 本地服务默认绑定 `127.0.0.1`；
- 源码模式默认只允许 `localhost:3000` 和 `127.0.0.1:3000` 网页来源；桌面模式
  只允许当前本地界面来源；
- 写入操作需要 dry run 计划、确认请求头和确认字段；
- 替换目录前会先完整生成新版本并复制备份，切换失败时恢复旧目录；
- `.skill` 解析包含条目数、压缩包大小、单文件大小、解压总量和路径边界限制；
- 软链接模式会让多个 Agent 共享同一内容，这是用户明确选择的行为，不是隔离机制。

这些边界降低风险，但不表示应用可以安全打开来源不明的文件。请只导入可信来源的
Skill，并在确认前检查文件和安装计划。

These controls reduce risk; they do not make untrusted code or instructions
safe. Import Skills only from sources you trust and inspect their files and
installation plan before confirmation.
