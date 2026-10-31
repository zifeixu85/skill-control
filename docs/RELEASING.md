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
4. 写 `docs/releases/vX.Y.Z.md`（中文在前、英文在后）。要先以预发布形式公开时，在文件开头
   加上 front matter：

   ```markdown
   ---
   prerelease: true
   ---
   ```

   Release workflow 会去掉 front matter，把正文作为 Release notes，并用 `--prerelease`
   创建 Release。front matter 只接受 `prerelease: true | false`，拼错会让发布失败。
5. 确认 [README.md](../README.md) 和 [README_EN.md](../README_EN.md)
   的平台支持、下载说明和已知限制一致。
6. 审计 `package-lock.json` 和
   [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)，保留打包运行时要求的
   许可证文件。
7. 从全新依赖安装开始执行质量门禁：

```bash
npm ci
npm audit --omit=dev --audit-level=high
npm run lint
npm run typecheck
npm test
```

8. 检查工作树中没有 `.env`、证书、真实 Skill、`~/.agent-skill-manager`
   内容或其他本机数据；对 `git ls-files` 做一次隐私扫描（个人绝对路径、邮箱、
   令牌、内部主机名、真实姓名）。

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

## macOS 签名（固定的自签名证书）

macOS 版用一张固定的自签名代码签名证书签名（还没有 Developer ID，也没有公证）。
证书不变，应用的“指定要求”（designated requirement，形如
`identifier "dev.skillcontrol.desktop" and certificate leaf = H"…"`）就不变：macOS 按它
记住的授权（App管理、完全磁盘访问等）在更新后继续有效，应用内更新也用它确认新版本
来自同一张证书。ad-hoc 签名的指定要求只是 cdhash，每次构建都会变。

### 怎么签

`electron-builder.yml` 里 `mac.identity: null`，由 `afterPack` 钩子
`scripts/sign-mac.mjs` 统一签名（identity 为 null 时 electron-builder 自己不签，也不会调用
afterSign 钩子）：先签所有内嵌的二进制、框架和 Helper，再签应用本身（由内向外，不用
`--deep`），最后执行 `codesign --verify --deep --strict` 并打印指定要求和证书 SHA-1。
签名方式由环境变量决定：

| 环境 | 方式 |
| --- | --- |
| GitHub Actions，且设置了 `MAC_SIGN_P12_BASE64` + `MAC_SIGN_P12_PASSWORD` | 导入临时钥匙串，在 runner 上把证书设为代码签名可信（`sudo security add-trusted-cert`，自签名证书不受信任时 codesign 会报 “no identity found”），签名后删除钥匙串、搜索列表条目和信任设置 |
| 本机，设置了 `MAC_SIGN_IDENTITY`（SHA-1 或名称） | 用钥匙串里已经信任的身份签名，不改任何钥匙串或信任设置 |
| 都没有 | ad-hoc 签名（与 v0.2.1 相同），本地构建默认如此 |

在本机设置 `MAC_SIGN_P12_*` 会直接报错：导入 p12 需要创建钥匙串、修改搜索列表和信任
设置，脚本只在 CI 的一次性 runner 上自动做这些事。

### 设置仓库（一次）

1. 在 Settings → Secrets and variables → Actions 添加 secrets：
   - `MAC_SIGN_P12_BASE64`：`base64 -i skill-control-signing.p12 | pbcopy`；
   - `MAC_SIGN_P12_PASSWORD`：p12 的密码。

   p12 用传统加密导出（OpenSSL 3：`openssl pkcs12 -export -legacy …`），否则 macOS 的
   `security import` 可能读不了。
2. 添加 variable `MAC_SIGN_CERT_SHA1` = `313A65FF9080E447216EBC2C090344785D2652B1`
   （当前证书：CN “Skill Control Code Signing (zifeixu85)”，RSA-3072，有效期到 2036-10-28）。
   用证书签名的构建，证书 SHA-1 必须与它一致；它不会让 ad-hoc 构建失败（fork 和 PR 没有签名
   secrets，照常 ad-hoc 签名）。
3. 运行 **macOS signing check**：在 Actions 里手动运行（这个文件进了默认分支以后才能手动
   运行），或者把要检查的提交推到 `sign-check/…` 分支（例如
   `git push origin HEAD:sign-check/v0.3.0`）。它构建 arm64 应用、用证书签名并校验，打印
   指定要求和证书 SHA-1，再把改动过的副本重新签名，确认指定要求相同、cdhash 不同。
4. 检查通过后添加 variable `MAC_SIGN_REQUIRED` = `true`。此后缺少证书时 macOS 构建直接
   失败，不会再静默退回 ad-hoc。没设置时，只要 secrets 存在，发布也会用证书签名。

`desktop/code-signature.mjs` 的 `TRUSTED_SIGNER_SHA1` 也写着这张证书的 SHA-1，供更新器在
轮换证书时使用（见下）。

### 校验一个构建

```bash
codesign --verify --deep --strict --verbose=2 "Skill Control.app"
codesign -d -r- "Skill Control.app"            # 指定要求
node scripts/sign-mac.mjs verify "Skill Control.app"   # 同上，并对照 MAC_SIGN_CERT_SHA1
```

### 应用内更新怎样核对签名

更新器在下载后、替换前都会检查新版本：签名必须有效；如果正在运行的版本是用证书签的，
新版本还要满足它的指定要求，或者由 `TRUSTED_SIGNER_SHA1` 里的证书签名。正在运行的是
ad-hoc 版本（0.2.x）时只检查签名有效，所以 0.2.x 可以更新到第一个用证书签名的版本。

### 轮换证书

1. 生成新证书（同样是代码签名用途），记下它的 SHA-1。
2. 把新 SHA-1 加进 `desktop/code-signature.mjs` 的 `TRUSTED_SIGNER_SHA1`，仍用**旧证书**
   发布一个版本 N。装了 N 的用户之后能接受新证书签名的更新。
3. 大多数用户更新到 N 以后，替换 secrets `MAC_SIGN_P12_*` 和 variable
   `MAC_SIGN_CERT_SHA1`，运行 macOS signing check，再发布 N+1。
4. 还停在 N 之前版本的用户，应用内更新会提示签名证书不一致，需要从下载页手动更新一次。
   证书变了以后，macOS 给过的授权（App管理、完全磁盘访问）需要用户重新允许一次。
5. 旧证书的 SHA-1 可以在之后的版本里从列表删掉；旧 p12 离线保存，直到不再支持 N 之前的
   版本。

私钥泄露时按同样步骤尽快轮换，并在 Release notes 里说明。更新器只从本仓库的 Release
下载、按 Release 里的 `latest-mac.yml` 校验 sha512，单凭私钥推不了应用内更新；但用它签名
的同标识应用能满足同一个指定要求，可能沿用用户给 Skill Control 的系统授权。

## 3. 每个平台的冒烟测试

在没有源码目录和开发依赖的普通用户环境中验证：

- [ ] 安装或解压后可以启动，应用名称和图标正确；
- [ ] 应用仅启动预期的本地回环服务，没有弹出终端；
- [ ] 可以检测至少一个真实但不敏感的测试 Agent 目录；
- [ ] 空状态、目录缺失和本地端口占用时给出可理解的错误；
- [ ] Skill 详情默认选择 `SKILL.md`，文件夹可展开/折叠；
- [ ] Markdown 预览与原始内容切换正常；
- [ ] 常见图片可以预览，SVG 可切换渲染效果与原始内容；
- [ ] “在文件管理器中定位”会调用当前平台的文件管理器；
- [ ] `.skill` 可以拖入、预览文本与图片、生成安装计划；
- [ ] 冲突版本可分别打开完整详情，高级比较正常，并可切换权威来源；
- [ ] 复制同步在确认前不写入，确认后能新增目标；
- [ ] 替换操作创建了可用备份；
- [ ] 软链接模式的行为和说明一致；
- [ ] 导出后的 `.skill` 可以重新导入；
- [ ] 应用退出后，本地界面和管理端口被释放；
- [ ] “设置 → 关于”能检查应用更新；离线模式下显示不检查；
- [ ] 卸载行为与 Release notes 描述一致。

测试请使用专门的临时 Agent 目录和虚构 Skill，避免污染个人环境。

## 4. 创建 GitHub Release

推荐流程是从通过全部门禁的提交推送 `vX.Y.Z` tag。Release workflow 会在每个
目标操作系统和架构上构建并启动打包应用；所有冒烟测试通过后，才生成 SHA-256
校验文件并公开 Release。任一平台失败时不会进入发布 job。

每个平台除了安装包，还会上传应用内更新需要的文件：

| 文件 | 来源 | 用途 |
| --- | --- | --- |
| `latest-mac.yml` | arm64 与 x64 两次构建各写一份，`update-manifests` job 用 `scripts/merge-mac-update-manifests.mjs` 合并成一份 | macOS 自写更新器读取 zip 与 sha512 |
| `latest.yml` | Windows NSIS 构建 | electron-updater（Windows 安装版） |
| `latest-linux.yml` | Linux AppImage 构建 | electron-updater（AppImage） |
| `*.blockmap` | 各平台构建 | electron-updater 的差分下载 |

构建命令始终带 `--publish never`：`electron-builder.yml` 里的 `publish`（GitHub）只用来
生成这些文件，上传和创建 Release 都由 workflow 的 `publish` job 完成，只有这个 job
拥有 `contents: write` 权限。

`publish` job 还会复制一份不带版本号的常用安装包：`Skill-Control-mac-arm64.dmg`、
`Skill-Control-mac-x64.dmg`、`Skill-Control-win-x64-setup.exe`、
`Skill-Control-linux-x86_64.AppImage`。README 可以用固定链接指向最新的正式版本，例如
`https://github.com/zifeixu85/skill-control/releases/latest/download/Skill-Control-mac-arm64.dmg`
（`latest` 不包含预发布）。签名的 secrets 只传给 macOS 的构建步骤；“Verify macOS code
signature” 会检查应用和 zip 里的副本。

### 预发布与转为正式版本

`docs/releases/vX.Y.Z.md` 带 `prerelease: true` 时，Release 以预发布形式创建。应用内
更新只读取 GitHub 的 `releases/latest`，不会把预发布推送给已安装的用户；验证无误后，
不需要重新构建，直接转为正式版本：

```bash
gh release edit vX.Y.Z --prerelease=false --latest
```

之后可以把 notes 文件里的 front matter 改为 `prerelease: false`（或删除），保持仓库与
Release 一致。

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
