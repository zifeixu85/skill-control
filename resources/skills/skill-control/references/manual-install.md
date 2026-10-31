# 手动安装：技能库与各 Agent 的接入方式

> 什么时候读：本机没有 `skill-control` 命令时（`command -v skill-control` 和 `ls ~/.local/bin/skill-control` 都没有输出），或要给用户解释某个 Agent 为什么看不到技能时。
> 命令里的 `$NAME` 是技能文件夹名。Agent 每次运行命令可能是新的 shell，变量不会保留：每条命令里直接写出名称，或在同一条命令里先写 `NAME=<名称>;`。`$NAME` 为空时不要执行——`cp -R`、`ln -s` 会作用到整个目录。

## 1. 放进技能库

```sh
NAME=<技能文件夹名>
if [ -e ~/.agents/skills/"$NAME" ] || [ -L ~/.agents/skills/"$NAME" ]; then
  echo "已存在同名技能，先问用户"
else
  mkdir -p ~/.agents/skills && cp -R "<临时目录里的技能文件夹>" ~/.agents/skills/"$NAME"
fi
```

- 技能文件夹里必须有 `SKILL.md`，开头的 frontmatter 要有 `name` 和 `description`。
- 已存在同名技能时停止，先把差异告诉用户。
- 用户给的是 `npx skills add …`：同样先取到临时目录做安全检查，通过后运行 `DO_NOT_TRACK=1 DISABLE_TELEMETRY=1 npx skills add <来源> [--skill <名称>] -g -a codex -y`（前两个变量关闭这个命令行工具的使用统计上报；只写入技能库这一份），再按第 2 节接入其他 Agent。

## 2. 按档位接入各 Agent

| Agent | 命令行 id | 档位 | 怎么接入 |
|---|---|---|---|
| Codex | `codex` | 原生读取 | 不需要动作 |
| Gemini CLI | `gemini` | 原生读取 | 不需要动作 |
| Cursor | `cursor` | 原生读取 | 不需要动作 |
| OpenCode | `opencode` | 原生读取 | 不需要动作 |
| GitHub Copilot | `copilot` | 原生读取 | 不需要动作 |
| Windsurf | `windsurf` | 原生读取 | 不需要动作 |
| OpenClaw / QClaw | `openclaw` / `qclaw` | 原生读取 | 不需要动作；技能库里的条目必须是真实目录，不能是指向库外的链接 |
| Claude Code | `claude` | 软链接 | `mkdir -p ~/.claude/skills && ln -s ../../.agents/skills/"$NAME" ~/.claude/skills/"$NAME"` |
| WorkBuddy | `workbuddy` | 软链接 | `mkdir -p ~/.workbuddy/skills && ln -s ../../.agents/skills/"$NAME" ~/.workbuddy/skills/"$NAME"` |
| Kiro | `kiro` | 软链接 | `mkdir -p ~/.kiro/skills && ln -s ../../.agents/skills/"$NAME" ~/.kiro/skills/"$NAME"` |
| Trae | `trae` | 软链接 | `mkdir -p ~/.trae/skills && ln -s ../../.agents/skills/"$NAME" ~/.trae/skills/"$NAME"` |
| CodeBuddy | `codebuddy` | 软链接 | `mkdir -p ~/.codebuddy/skills && ln -s ../../.agents/skills/"$NAME" ~/.codebuddy/skills/"$NAME"` |
| Hermes | `hermes` | 额外目录 | 一次性配置（先问用户）：备份 `~/.hermes/config.yaml`（设了 `HERMES_HOME` 时在它下面），看清 `skills.external_dirs` 已有哪些目录，把 `~/.agents/skills` 加进去、保留原有的：`hermes config set skills.external_dirs '[<原有目录…>, "~/.agents/skills"]'`；不要再往 `~/.hermes/skills` 链接或复制 |
| 办公小浣熊 | `office-raccoon` | 复制 | 它不跟随软链接：`cp -R ~/.agents/skills/"$NAME" ~/.box-agent/skills/"$NAME"`；技能库更新后需要重新复制 |

规则：
- 手动时没有“常用 Agent”设置：只给用户要的、本机已经装了的 Agent 接入（如 `~/.kiro` 存在），不为没装的 Agent 新建目录。
- 只在目标位置不存在时建链接或复制；目标已存在（目录、文件或其他链接）就停下，先问用户。先用 `ls -ld <目标>` 确认：`ln -s`、`cp -R` 遇到已有目录会把链接或副本放进那个目录里面。
- 链接用相对路径（上表的 `../../.agents/skills/<名称>`），只链接目录，不要单独链接 `SKILL.md`。
- Windows：没有软链接权限时可以用目录联接（`mklink /J`），再不行就复制。

## 3. 验证

```sh
ls -la ~/.claude/skills/"$NAME"        # 应显示 -> ../../.agents/skills/<名称>
test -f ~/.claude/skills/"$NAME"/SKILL.md && echo ok
```

## 4. 建议

手动步骤没有备份和历史记录。建议用户在 Skill Control 的“设置 → Agent 集成”里安装命令行工具 `skill-control`，以后的安装都能撤销。
