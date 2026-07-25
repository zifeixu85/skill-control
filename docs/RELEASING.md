# 发布指南 / Release Guide

本文件供 Skill Control 维护者使用。普通贡献者无需执行发布操作。

This guide is for Skill Control maintainers. Contributors do not need release
credentials to open a Pull Request.

## 发布原则

- 从干净的 `main` 分支构建；
- 版本号遵循 Semantic Versioning，Git tag 使用 `vX.Y.Z`；
- 每个平台只发布在该平台完成构建和冒烟测试的产物；
- 未签名、未公证或仍属实验性的产物必须在 Release notes 中显著说明；
- 不把开发者证书、访问令牌或更新签名密钥保存在仓库中；
- Release 必须包含用户可理解的变化、升级说明和已知限制。

## 1. 准备版本

1. 确认目标 Milestone 中没有阻塞发布的问题。
2. 更新 `package.json` 版本号。
3. 把 [CHANGELOG.md](../CHANGELOG.md) 中的候选条目整理到新版本，并填写
   `YYYY-MM-DD` 日期。
4. 确认 [README.md](../README.md) 和 [README_EN.md](../README_EN.md)
   的平台支持、下载说明和已知限制一致。
5. 审计 `package-lock.json` 和
   [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)，保留打包运行时要求的
   许可证文件。
6. 从全新依赖安装开始执行质量门禁：

```bash
npm ci
npm audit --omit=dev --audit-level=high
npm run lint
npm test
```

7. 检查工作树中没有 `.env`、证书、真实 Skill、`~/.agent-skill-manager`
   内容或其他本机数据。

## 2. 构建候选产物

优先在目标操作系统上构建。不要因为存在交叉编译命令，就把未在目标系统启动过的
产物标记为已支持。

| 平台 | 架构 | 候选格式 | 构建命令 |
| --- | --- | --- | --- |
| macOS | Apple Silicon、Intel | DMG、ZIP | `npm run desktop:build:mac` |
| Windows | x64 | NSIS、portable | `npm run desktop:build:win` |
| Linux | x64 | AppImage、DEB | `npm run desktop:build:linux` |

构建配置的实际产物和名称以 `electron-builder.yml` 为准。正式发布前应使用项目
认可的代码签名、公证或包签名流程；没有完成时必须在 Release notes 中写明。

## 3. 每个平台的冒烟测试

在没有源码目录和开发依赖的普通用户环境中验证：

- [ ] 安装或解压后可以启动，应用名称和图标正确；
- [ ] 应用仅启动预期的本地回环服务，没有弹出终端；
- [ ] 可以检测至少一个真实但不敏感的测试 Agent 目录；
- [ ] 空状态、目录缺失和本地端口占用时给出可理解的错误；
- [ ] Skill 详情默认选择 `SKILL.md`，文件夹可展开/折叠；
- [ ] Markdown 预览与原始内容切换正常；
- [ ] “在文件管理器中定位”会调用当前平台的文件管理器；
- [ ] `.skill` 可以拖入、预览、生成安装计划；
- [ ] 复制同步在确认前不写入，确认后能新增目标；
- [ ] 替换操作创建了可用备份；
- [ ] 软链接模式的行为和说明一致；
- [ ] 导出后的 `.skill` 可以重新导入；
- [ ] 应用退出后，本地界面和管理端口被释放；
- [ ] 卸载行为与 Release notes 描述一致。

测试请使用专门的临时 Agent 目录和虚构 Skill，避免污染个人环境。

## 4. 创建 GitHub Release

推荐流程是从通过全部门禁的提交推送 `vX.Y.Z` tag。Release workflow 会在每个
目标操作系统和架构上构建并启动打包应用；所有冒烟测试通过后，才生成 SHA-256
校验文件并公开 Release。任一平台失败时不会进入发布 job。

需要手工发布时，先创建 Draft Release，上传每个已验证平台的产物，从 Draft
重新下载并复验后再公开。无论自动还是手工流程，都应：

1. 不上传临时目录或未验证构建；
2. 为产物生成 SHA-256 校验值并一同上传；
3. Release notes 至少包含：
   - 主要变化；
   - 支持的平台与架构；
   - 签名、公证和 SmartScreen/包管理器状态；
   - 安装与升级方法；
   - 已知限制；
   - Changelog 链接；
   - 安全相关修复（在协调披露允许的范围内）。
4. 确认 README 的下载入口可用。

## 5. 发布后

- 在干净环境中重新测试公开下载文件；
- 观察安装、启动、同步和平台兼容性反馈；
- 对阻塞使用或涉及本地数据安全的问题优先分级；
- 将下一版本的变化继续记录在 Changelog 的 `Unreleased` 段落；
- 若必须撤回版本，保留公开说明，不静默替换同名产物。

## Release notes 最小模板

```markdown
## Skill Control vX.Y.Z

### 重点变化
- …

### 下载
| 平台 | 架构 | 文件 | 验证状态 |
| --- | --- | --- | --- |
| macOS | arm64 | … | 已测试；签名/公证状态 |

### 已知限制
- …

### 校验
SHA-256 文件已随 Release 上传。

完整变化见 CHANGELOG.md。
```
