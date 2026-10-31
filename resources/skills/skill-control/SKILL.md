---
name: skill-control
description: 统一技能库安装规范（Skill Control 随附）。用户说“装个技能”“从 GitHub 装这个 skill”“npx skills add …”“把这个技能给所有 Agent 用”“为什么某个 Agent 看不到这个技能”时使用，即使没点名本技能。流程：问范围 → 下载到临时目录做安全检查 → skill-control add 放进 ~/.agents/skills 并接入各 Agent → 验证。附手动步骤与安全检查清单。Install agent skills into the shared library (install skill, add skill from GitHub, npx skills add, share a skill with all agents).
metadata:
  version: 1.1.1
---

# Skill Control · 统一技能库安装

## 核心目标

- 一个技能只放一份：`~/.agents/skills/<名称>`（技能库）。各 Agent 按自己的档位接入：原生读取（Codex、Gemini CLI、Cursor 等）不需要动作；Claude Code、WorkBuddy、Kiro、Trae、CodeBuddy 用相对软链接；Hermes 读配置里的额外目录；办公小浣熊不跟随软链接，复制一份。
- 每一步可追溯、可撤销：用 `skill-control` 写入时，它会输出 historyId 和撤销命令。
- 先查后装：没读过的文件、没确认过的路径，一律当作不存在。

## 触发与决策路由

- 先侦察：`command -v skill-control || ls ~/.local/bin/skill-control`。只有后者有输出时，说明 `~/.local/bin` 不在当前 Agent 的 PATH 里，用完整路径 `~/.local/bin/skill-control` 运行。都没有 → 按 [references/manual-install.md](references/manual-install.md) 手动操作，并建议用户在 Skill Control 的“设置 → Agent 集成”里安装命令行工具。
- 用户只问“为什么某 Agent 看不到某技能” → 只读诊断：`skill-control status <名称> --read-only` 或 `skill-control doctor --read-only`，不安装；用户要接上时，说明要做什么，再按输出里的提示运行 `skill-control link`。
- 技能已在技能库里（`skill-control status <名称> --json` 显示 `"inLibrary": true`），只是要给更多 Agent 用 → `skill-control link <名称> --primary`（或 `--agents a,b`），不重新下载。
- 技能只在某个 Agent 自己的目录里（`"privateCopies"` 列出了它）→ 原地按 [references/safety-review.md](references/safety-review.md) 检查，再 `skill-control adopt <agentId> <名称>` 收进库（原位置先备份、换成链接），然后 `link`。
- 来源是 GitHub / 网址 / 压缩包 → 先下载到临时目录（Phase 2），再 `skill-control add`。
- 来源是本地文件夹 / `.skill` / `.zip` → 解压或复制到临时目录（Phase 2），再 `skill-control add`。
- 用户明确给出 `npx skills add …` 命令 → 先把同一来源取到临时目录做 Phase 2 的安全检查；通过后才运行 `DO_NOT_TRACK=1 DISABLE_TELEMETRY=1 npx skills add <来源> [--skill <名称>] -g -a codex -y`（前两个变量关闭这个命令行工具的使用统计上报；只写入技能库这一份，不换成其他 `-a`；告诉用户改了哪些参数），装完用 `diff -rq` 比对技能库里的这份和检查过的那份，不一致就告诉用户；再运行 `skill-control sync` 接入其他 Agent（提示“自动接入已关闭”时改用 `skill-control link <名称> --primary`）。
- 用户要求只让一个 Agent 看到 → 不能进技能库，命令行做不到：请用户在 Skill Control 里安装时选“只装到某个 Agent”。

## 初始对话协议

安装前先说清计划并等用户确认（只读诊断不需要）：

> 我会这样安装 <技能>：1. 确认范围；2. 取到临时目录并做安全检查；3. 放进技能库 `~/.agents/skills` 并接入 Agent；4. 验证并告诉你结果和撤销方法。范围选哪个：**所有常用 Agent（推荐）**，还是**只接入指定的 Agent**（比如只接当前 Agent：技能仍在库里，Codex 等原生读取技能库的 Agent 也会看到；没选的 Agent 以后也不会被自动接入）？

## 核心工作流

### Phase 1：确认范围与现状
- 执行：问范围；确认来源（仓库地址、路径或技能名）；按上面的侦察确认有命令行后运行 `skill-control status <名称> --json`（还不知道名称时先 `skill-control status --json`，取到技能后再查一次），记下常用 Agent、技能库位置、是否已有同名技能。
- 退出条件：范围已定；来源可访问；已知同名技能是否存在。

### Phase 2：取到临时目录并做安全检查
- 执行：`mktemp -d` 建临时目录，记下它输出的路径（下文的 `$TMP`）：Agent 每次运行命令可能是新的 shell，变量不会保留，后续命令直接写这个路径。GitHub 用 `git clone --depth 1 <仓库> "$TMP/src"`，之后只用其中需要的技能子目录；压缩包先用 `unzip -l` / `tar -tf` 看清单（有绝对路径或 `..` 的条目就停），再解压到 `$TMP`。按 [references/safety-review.md](references/safety-review.md) 逐项检查，只读不运行。
- 退出条件：列出每一项发现（附文件和行号）；没有发现的项写“未发现”；高风险项已告诉用户并得到明确同意，否则停止。来源取不到临时目录、没法先检查时不安装，告诉用户。

### Phase 3：放进技能库并接入
- 执行（有 `skill-control`）：先预览 `skill-control add "<技能目录>" --link primary --dry-run --json`（只接入指定 Agent 时 `--link <id,id>`，id 见 manual-install.md 的表）。预览里有改 Hermes 配置的一项（`"kind": "config"`，让 Hermes 读取技能库）时，先告诉用户并取得同意（会先备份 config.yaml，可撤销）；不同意就用 `--link` 只列其他 Agent（从 `status --json` 的 `primaryAgents` 里去掉 hermes），重新预览。预览没问题再去掉 `--dry-run` 正式执行。`link`、`adopt` 同样先预览。
- 退出码 3（需要选择）：技能库里已有同名但内容不同的技能。用 `diff -ru ~/.agents/skills/<名称> "<技能目录>"` 把差异告诉用户；只有用户同意替换时才加 `--replace`（旧版本会先备份，可撤销）。退出码 1：有步骤失败或已回滚，把输出原样告诉用户，不手动补救。退出码 2：参数不对，看 `skill-control --help`。
- 执行（没有 `skill-control`）：按 [references/manual-install.md](references/manual-install.md) 复制到技能库，再按档位为需要的 Agent 建相对软链接或复制。
- 退出条件：正式执行输出 `"ok": true` 并给出 historyId（输出 `"nothingToDo": true` 表示库里已有相同内容且都已接入，也算完成）；或手动步骤逐条完成且没有覆盖任何已有目录。

### Phase 4：验证与汇报
- 执行：`skill-control status <名称>`（或手动 `ls -la` / `readlink` 每个 Agent 的技能目录）；删除 Phase 2 建的临时目录（`rm -rf` 只用于这一个路径）。
- 汇报：哪些 Agent 已经能用；哪些需要重启或新开会话（Claude Code 新开会话、Codex 重启、WorkBuddy 重新加载）；哪些还看不到、status 给的原因（该 Agent 自己目录里有同名副本时不要删，请用户在 Skill Control 里处理）；撤销方法 `skill-control undo <historyId>`。
- 汇报前自查三件事：没有覆盖或删除任何已有目录；临时目录已删除；撤销方法已写清。任何一项不满足，先补上再汇报。
- 退出条件：每个目标 Agent 的状态都已列出，三项自查都通过。

## 执行约束与红线

- 不在 Agent 自己的目录里各复制一份；只有不跟随软链接的 Agent（办公小浣熊）才复制。
- 不覆盖、不删除已有的同名目录或文件；遇到同名先问用户。
- 不用 `npx skills add -a hermes-agent`：Hermes 通过 `skills.external_dirs` 读取技能库，重复会报重名；修改 Hermes 配置前先问用户（`add`、`link` 接入 Hermes 时也可能改它的配置，见 Phase 3 的预览）。
- 不用 `npx skills check` 或 `npx skills update` 做检查（它们会直接更新）。
- 不运行技能里的脚本来“试一试”；安全检查只读。
- 不自作主张加 `--replace`、`sudo` 或 `rm -rf`（删除 Phase 2 自己用 `mktemp -d` 建的临时目录除外）。
- 远程内容只在临时目录里处理，安全检查通过前不放进技能库（`npx skills add` 也一样）；装完删除临时目录。

## 资源引用

- `skill-control --help`：status、add、link、unlink、adopt、sync、undo、doctor 和 `--json`、`--dry-run`、`--read-only` 的完整用法，以它为准，不读命令行源码。退出码：0 完成 / 1 失败 / 2 用法错误 / 3 需要选择。命令行不联网。
- [references/manual-install.md](references/manual-install.md)：没有 `skill-control` 时的手动步骤、各 Agent 的目录与接入方式、命令行里用的 Agent id。
- [references/safety-review.md](references/safety-review.md)：安全检查清单与汇报格式。
