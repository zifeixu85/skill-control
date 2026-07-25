# 项目治理 / Project Governance

Skill Control 目前采用轻量维护者治理模式，适合首个公开版本和早期贡献者社区。

Skill Control currently uses a lightweight maintainer-led model suitable for
the first public release and an early contributor community.

## 角色 / Roles

### 使用者 / Users

使用项目、报告问题并提出需求。任何人都可以成为使用者。

### 贡献者 / Contributors

提交被合并的代码、测试、设计或文档。贡献者不需要长期承诺。

### 维护者 / Maintainers

维护者负责：

- Issue 分类和路线图优先级；
- 代码审查与合并；
- 安全报告的私下处理；
- 版本号、发布说明和签名产物；
- 行为准则的执行；
- 邀请持续、可靠的贡献者成为维护者。

Maintainers triage work, review and merge changes, handle security reports,
publish releases, enforce community standards, and invite new maintainers.

## 决策方式 / Decision process

- 日常修复由维护者在 Pull Request 中审查决定；
- 影响数据格式、安全边界、主要依赖、产品方向或兼容性的变化，应先在 Issue 中公开
  讨论；
- 优先通过清晰的技术证据和共识做决定；
- 无法形成共识时，仓库所有者对当前版本拥有最终决定权，并应记录理由；
- 安全漏洞在修复发布前可以私下讨论。

Routine changes are decided through Pull Request review. Changes to data
formats, security boundaries, major dependencies, product direction, or
compatibility should be discussed in an Issue first. The repository owner has
the final decision when consensus cannot be reached and should document the
reasoning.

## 发布原则 / Release principles

- `main` 应始终保持可构建、可测试；
- 版本遵循 Semantic Versioning；
- 发布内容必须有 Changelog 和可复现的构建记录；
- 安装包只标注实际通过验证的平台；
- 发布产物不得包含真实用户数据、开发者本机路径或密钥；
- 已知限制必须在 Release notes 中明确写出；
- 安全修复可以采用缩短公示时间的紧急发布流程。

`main` should remain buildable and testable. Releases follow Semantic
Versioning, include a changelog and reproducible build record, label only
validated platforms, and disclose known limitations.

具体门禁与冒烟测试见 [发布指南](./docs/RELEASING.md)。
首次公开仓库的设置与安全开关见
[GitHub 仓库配置清单](./docs/REPOSITORY_SETUP.md)。

## 治理变更 / Changes to governance

随着维护者和贡献者增加，本文件可以通过 Pull Request 修改。重要治理变化应至少保留
一个公开讨论期，除非变更用于处理紧急安全或行为准则事件。

This document may evolve through Pull Requests as the community grows.
