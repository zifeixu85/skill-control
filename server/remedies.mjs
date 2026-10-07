import { compactHomeInText, scrubTokens } from "./fs-safe.mjs";

/**
 * Remedies: a copyable prompt for the user's own AI agent (Codex or Claude Code), in
 * Chinese, plus terminal commands only where they are safe and exact (read-only checks,
 * an official updater, `mv -n` into the Trash; never rm). Prompts name the problem, the
 * affected Agent and the ~/ paths, the goal, and the safe way there: back up first, never
 * print or move secrets, ask before deleting, verify afterwards. Every text passes the
 * secret scrubber and home compaction.
 *
 * Remedy = { commands?: [{ label?, command }], prompt }
 */

export const REMEDY_PROMPT_LIMIT = 1_500;
export const REMEDY_ALL_LIMIT = 8_000;
const GROUP_ITEM_LIMIT = 12;

const SAFETY = [
  "修改任何文件前，先把它备份到 ~/.agent-skill-manager/backups/ 下带时间戳的文件夹。",
  "不要打印、复制或移动任何密钥、token、密码；遇到配置里的密钥只说明它在哪个字段。",
  "删除任何东西前先问我；需要清理时优先移到废纸篓（~/.Trash）。",
];

export const CATEGORY_LABELS = {
  "broken-link": "失效的软链接",
  "missing-skill-md": "缺少 SKILL.md",
  frontmatter: "文件头不完整",
  "name-mismatch": "名称和文件夹不一致",
  oversize: "SKILL.md 过大",
  "differing-copies": "同一个 Agent 里副本不一致",
  "hidden-by-product": "被产品隐藏",
  shadowed: "被同名技能覆盖",
  disabled: "已停用",
  archived: "已归档",
  "missing-bin": "缺少依赖的命令",
  "missing-env": "缺少环境变量",
  "nvm-only": "命令只在 nvm 里",
  "mcp-command-missing": "MCP 命令找不到",
  "mcp-literal-secret": "MCP 配置里有明文密钥",
  "plugin-state": "插件状态",
  "shared-root": "共用的技能文件夹",
  "update-available": "有新版本",
  "locally-modified": "本地改过的技能",
  "lock-drift": "锁记录和本地不一致",
  "codex-tmp-leftovers": "Codex 临时文件残留",
  "library-drift": "和技能库重复的独立副本",
  "library-external-link": "技能库里指向库外的链接",
  "cli-version-skew": "命令行工具版本不一致",
  "cli-workspace-unconfigured": "命令行工具的工作区没配置",
  "cli-not-on-agent-path": "Agent 找不到命令行工具",
};

const COMMAND_NAME = /^[\w.@+-]{1,64}$/u;
const WORKSPACE = /^[\w-]{1,40}$/u;

/** Text safe to put in a prompt: no secrets, no full home paths, bounded. */
export function cleanRemedyText(value, homes = [], limit = REMEDY_PROMPT_LIMIT) {
  const cleaned = scrubTokens(compactHomeInText(String(value ?? ""), homes))
    .replace(/\p{Cf}/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ");
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

/** A path for a shell command: only ~/… or absolute paths without quotes or control characters. */
const shellPath = (value) => {
  if (typeof value !== "string" || !/^(?:~\/|\/)[^"`$\\\n\r\u0000]{1,400}$/u.test(value)) return null;
  if (/^[\w./~@+-]+$/u.test(value)) return value;
  return value.startsWith("~/") ? `~/"${value.slice(2)}"` : `"${value}"`;
};

/** The prompt: problem, where, goal, steps, safety, verification. */
export function buildPrompt({ problem, where = [], detail = "", goal, steps = [], verify = "" }, homes = []) {
  const lines = [`请帮我处理这个问题：${problem}`];
  const places = where.filter(Boolean);
  if (places.length) lines.push(`涉及：${places.join("；")}`);
  if (detail) lines.push(`情况：${detail}`);
  lines.push(`目标：${goal}`, "请按下面的步骤做：");
  const all = [...steps, ...SAFETY, verify ? `完成后验证：${verify}，并把结果告诉我。` : "完成后检查一遍结果，并告诉我改了什么。"];
  all.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  return cleanRemedyText(lines.join("\n"), homes, REMEDY_PROMPT_LIMIT);
}

const remedy = (prompt, commands = []) => ({ ...(commands.length ? { commands } : {}), prompt });

/** Remedy for one health finding. `agentNames` maps agent ids to display names. */
export function remedyForFinding(finding, { agentNames = {}, homes = [] } = {}) {
  const agent = finding.agentId ? agentNames[finding.agentId] || finding.agentId : null;
  const where = [agent && finding.path ? `${agent}（${finding.path}）` : agent || finding.path || ""];
  const quoted = shellPath(finding.path);
  const hint = finding.hint || {};
  const command = COMMAND_NAME.test(String(hint.command || "")) ? hint.command : null;
  const base = { problem: finding.title, where, detail: finding.detail };
  const prompt = (details) => buildPrompt({ ...base, ...details }, homes);
  const skillFile = quoted ? (finding.path.endsWith("SKILL.md") ? quoted : `${quoted}/SKILL.md`) : null;
  switch (finding.category) {
    case "broken-link":
      return remedy(
        prompt({
          goal: "失效的链接被移走，或改为指向正确的技能目录。",
          steps: ["先用 ls -l 看链接指向哪里，确认目标确实不存在。", "如果技能已经搬到别处，重新链接到新位置；否则征得我同意后把这个链接移到废纸篓。"],
          verify: "再用 ls -l 确认链接不在了或能打开",
        }),
        quoted ? [{ label: "查看链接", command: `ls -l ${quoted}` }, { label: "移到废纸篓", command: `mv -n ${quoted} ~/.Trash/` }] : [],
      );
    case "missing-skill-md":
      return remedy(
        prompt({
          goal: "这个文件夹要么补上带 name / description 文件头的 SKILL.md，成为可用的技能；要么移出技能目录。",
          steps: ["先列出文件夹内容，判断它是不是一个技能。", "是技能就补写 SKILL.md（文件头包含 name 和 description，name 与文件夹名一致）；不是就问我是否移出技能目录。"],
          verify: "确认 SKILL.md 存在且文件头完整",
        }),
        quoted ? [{ label: "查看文件夹", command: `ls -la ${quoted}` }] : [],
      );
    case "frontmatter":
    case "name-mismatch":
    case "oversize":
      return remedy(
        prompt({
          goal: finding.category === "oversize" ? "SKILL.md 精简到 256 KB 以内（大段资料移到 references/ 下的文件并在正文里引用）。" : "SKILL.md 的文件头有 name 和 description，且 name 与文件夹名一致。",
          steps: ["先查看 SKILL.md 开头的文件头。", "只改文件头或把大段内容拆到同一技能文件夹里的其他文件，不改动技能的实际用法。"],
          verify: "再看一遍文件头，并确认文件大小",
        }),
        skillFile ? [{ label: "查看文件头", command: `head -20 ${skillFile}` }] : [],
      );
    case "differing-copies":
      return remedy(prompt({ goal: "同一个 Agent 里只保留一份内容一致的技能。", steps: ["列出这个技能在该 Agent 里的所有副本，用 diff -r 比较差异。", "确认哪一份是要保留的版本后，用 Skill Control 的同步把其他副本更新成同一份；不确定时先问我。"], verify: "再次比较，确认没有差异" }));
    case "missing-bin":
      return remedy(
        prompt({
          goal: `命令 ${command || "所需命令"} 可以在 Agent 的 PATH 里找到。`,
          steps: [`先确认这个命令确实没有安装${command ? `（command -v ${command}）` : ""}。`, "按这个工具的官方安装方式安装（优先 Homebrew 或官方安装脚本），装完不要改动其他工具。"],
          verify: command ? `运行 command -v ${command} 能看到路径` : "确认命令可以找到",
        }),
        command ? [{ label: "检查命令", command: `command -v ${command}` }] : [],
      );
    case "nvm-only":
      return remedy(
        prompt({
          goal: `从程序坞启动的 Agent 也能找到 ${command || "这个命令"}（不依赖 nvm 的 shell 初始化）。`,
          steps: [`先确认它只在 nvm 目录里${command ? `（which -a ${command}）` : ""}。`, "推荐在 ~/.local/bin 放一个指向 nvm 里那份程序的启动脚本或软链接，或用 Homebrew 安装一份；不要改系统目录。"],
          verify: command ? `在新终端里运行 /usr/bin/env -i PATH=/usr/bin:/bin:$HOME/.local/bin command -v ${command} 能找到` : "确认在不加载 nvm 的环境里也能找到",
        }),
        command ? [{ label: "查看所有位置", command: `which -a ${command}` }] : [],
      );
    case "missing-env":
      return remedy(
        prompt({
          goal: `${hint.env || "所需的环境变量"} 在 Agent 运行时可用。`,
          steps: ["问我这个变量该放在哪里（Agent 的配置文件、shell 配置或系统钥匙串），值由我自己填写。", "不要在对话里要求我粘贴这个值，也不要把它写进任何会被提交的文件。"],
          verify: hint.env ? `用 test -n "$${hint.env}" && echo 已设置 确认（只看是否设置，不打印值）` : "确认变量已设置，但不打印值",
        }),
      );
    case "mcp-command-missing":
      return remedy(
        prompt({
          goal: `MCP 服务「${hint.mcp || "这个服务"}」配置的命令可以找到并启动。`,
          steps: [`先确认命令是否存在${command ? `（command -v ${command}）` : ""}。`, "安装缺少的命令，或把配置里的命令改成实际安装位置；改配置前先备份。"],
          verify: "重启对应的 Agent，确认这个 MCP 服务能连上",
        }),
        command ? [{ label: "检查命令", command: `command -v ${command}` }] : [],
      );
    case "mcp-literal-secret":
      return remedy(
        prompt({
          goal: `MCP 服务「${hint.mcp || "这个服务"}」的配置里不再有明文密钥，改为引用环境变量或系统钥匙串。`,
          steps: ["先备份这个配置文件。", "只把明文值替换成环境变量引用（如 ${MY_TOKEN}）；新的值由我自己设置到环境变量或钥匙串里。", "不要在回复里显示原来的值。"],
          verify: "重启 Agent 后确认这个 MCP 服务仍能使用",
        }),
      );
    case "plugin-state":
      return remedy(prompt({ goal: "插件在 Agent 里的启用状态和实际安装一致。", steps: ["在对应 Agent 的插件管理里查看这个插件。", "重新安装或在配置里停用它，按我的选择来。"], verify: "重启 Agent 后确认插件状态" }));
    case "codex-tmp-leftovers":
      return remedy(
        prompt({
          goal: "清理 Codex 安装插件时留下的临时仓库，释放空间。",
          steps: ["先确认 Codex 没有在运行。", "列出 ~/.codex/.tmp 下的 git-* 目录和大小，征得我同意后移到废纸篓。"],
          verify: "再列一次 ~/.codex/.tmp，确认已清理",
        }),
        [{ label: "查看残留", command: "ls -la ~/.codex/.tmp" }],
      );
    case "update-available":
    case "locally-modified":
    case "lock-drift":
      return remedy(prompt({ goal: "技能更新到上游最新版本，本地修改不丢失。", steps: ["在 Skill Control 的“更新”页面查看这一项的计划。", "有本地修改时，先把修改备份或另存一份，再更新。"], verify: "更新后在 Skill Control 里确认状态为最新" }));
    case "library-drift":
    case "library-external-link":
      return remedy(prompt({ goal: "技能统一由技能库（~/.agents/skills）管理，各 Agent 通过链接或原生读取使用。", steps: ["在 Skill Control 的“技能库”页面生成整理计划并查看。", "确认计划里的每一步后再执行；指向库外的链接先收编进库。"], verify: "重新体检，确认这一项不再出现" }));
    case "cli-version-skew":
      return remedy(
        prompt({
          goal: `本机只保留一个版本的 ${command || "这个命令行工具"}，各 Agent 用的是同一份。`,
          steps: [`先列出所有位置和版本${command ? `（which -a ${command}）` : ""}。`, "确认要保留哪一份（通常是官方渠道的最新版），其他的问我后再处理。"],
          verify: command ? `再运行 which -a ${command}，确认只剩一份或都指向同一份` : "确认只剩一个版本",
        }),
        command ? [{ label: "列出所有位置", command: `which -a ${command}` }] : [],
      );
    case "cli-not-on-agent-path":
      return remedy(
        prompt({
          goal: `${agent || "这个 Agent"} 运行时能找到 ${command || "这个命令"}。`,
          steps: ["先确认命令在终端里的位置。", "用 Skill Control “命令行工具”卡片里的“启动脚本”修复，或把它所在目录加入该 Agent 读取的 PATH。"],
          verify: command ? `重启 ${agent || "Agent"} 后让它运行 command -v ${command}` : "重启 Agent 后确认能找到命令",
        }),
        command ? [{ label: "查看位置", command: `which -a ${command}` }] : [],
      );
    case "cli-workspace-unconfigured": {
      const workspace = WORKSPACE.test(String(hint.workspace || "")) ? hint.workspace : null;
      return remedy(
        prompt({
          goal: `${agent || "这个 Agent"} 使用的 ${command || "命令行工具"} 工作区已绑定。`,
          steps: [workspace && command ? `运行 ${command} config bind --source ${workspace}，按提示在浏览器里完成授权。` : "按工具的说明绑定这个工作区。", "授权信息由工具自己保存，不要读取或打印它。"],
          verify: workspace && command ? `让 ${agent || "Agent"} 运行一次只读命令，确认不再提示未配置` : "确认不再提示未配置",
        }),
        workspace && command === "lark-cli" ? [{ label: "绑定工作区", command: `lark-cli config bind --source ${workspace}` }] : [],
      );
    }
    default:
      return remedy(
        prompt({
          goal: finding.severity === "info" ? "了解情况即可，通常不需要处理；如果想改变，告诉我你的打算。" : "问题被解决，重新体检时不再出现。",
          steps: ["先查看涉及的文件或设置，说明原因和可选做法，等我确认后再改。"],
        }),
      );
  }
}

/** One prompt for many findings (需要处理 + 建议处理), grouped by category; bounded. */
export function remedyForFindings(findings, { agentNames = {}, homes = [] } = {}) {
  const actionable = findings.filter((finding) => finding.severity === "error" || finding.severity === "warn");
  if (!actionable.length) return { prompt: "体检没有需要处理或建议处理的问题，暂时不用做什么。" };
  const groups = new Map();
  for (const finding of actionable) groups.set(finding.category, [...(groups.get(finding.category) || []), finding]);
  const lines = [`请帮我处理 Skill Control 体检里需要处理和建议处理的 ${actionable.length} 个问题，按类别分组如下：`];
  for (const [category, items] of groups) {
    lines.push("", `【${CATEGORY_LABELS[category] || category}】${items.length} 项`);
    for (const item of items.slice(0, GROUP_ITEM_LIMIT)) {
      const agent = item.agentId ? agentNames[item.agentId] || item.agentId : "";
      lines.push(`- ${item.title}${agent || item.path ? `（${[agent, item.path].filter(Boolean).join("，")}）` : ""}`);
    }
    if (items.length > GROUP_ITEM_LIMIT) lines.push(`- 另有 ${items.length - GROUP_ITEM_LIMIT} 项同类问题`);
  }
  lines.push(
    "",
    "处理方式：",
    "1. 一类一类处理，每类开始前先说明你打算怎么做，等我确认。",
    ...SAFETY.map((step, index) => `${index + 2}. ${step}`),
    `${SAFETY.length + 2}. 每类处理完后验证结果；全部完成后请我在 Skill Control 里重新体检。`,
  );
  const commands = [];
  const seen = new Set();
  for (const finding of actionable) {
    for (const command of remedyForFinding(finding, { agentNames, homes }).commands || []) {
      // Only read-only checks go into the combined list; moves stay per issue.
      if (commands.length >= 20 || command.command.startsWith("mv ") || seen.has(command.command)) continue;
      seen.add(command.command);
      commands.push(command);
    }
  }
  return { ...(commands.length ? { commands } : {}), prompt: cleanRemedyText(lines.join("\n"), homes, REMEDY_ALL_LIMIT) };
}

// ---------------------------------------------------------------------------
// Skill updates

const ACTIONABLE_UPDATE = new Set(["update-available", "conflict"]);

/** Remedy for one skill / plugin update unit (from /api/updates). */
export function remedyForUpdate(unit, { homes = [] } = {}) {
  const where = (unit.instances || []).slice(0, 5).map((instance) => [instance.agentName || instance.agentId, instance.path].filter(Boolean).join(" "));
  if (!ACTIONABLE_UPDATE.has(unit.status)) {
    return { prompt: cleanRemedyText(`${unit.title}：${unit.status === "up-to-date" ? "已是最新版本" : "目前没有可执行的更新"}，不需要处理。`, homes) };
  }
  const version = unit.current && unit.latest ? `（${String(unit.current).slice(0, 40)} → ${String(unit.latest).slice(0, 40)}）` : "";
  const action = unit.action || {};
  const commands = action.command && action.kind !== "self" ? [{ label: action.label || "更新", command: String(action.command).slice(0, 1_000) }] : [];
  const steps =
    action.kind === "self"
      ? ["在 Skill Control 的“更新”页面对这一项生成更新计划，看清要改哪些文件后再确认。"]
      : commands.length
        ? [`运行更新命令：${commands[0].command}`]
        : [action.label ? `${action.label}` : "按这个技能来源的官方方式更新。"];
  if (unit.status === "conflict" || unit.localModified) steps.unshift("这份技能有本地修改：先把当前目录备份或另存一份，更新后再决定要不要合回修改。");
  return remedy(
    buildPrompt(
      {
        problem: `${unit.title} 有可用更新${version}`,
        where,
        detail: unit.sourceLabel ? `来源：${unit.sourceLabel}` : "",
        goal: "这个技能或插件更新到上游最新版本，本地修改不丢失。",
        steps,
        verify: "在 Skill Control 里重新检查更新，确认状态为最新",
      },
      homes,
    ),
    commands,
  );
}

/** One remedy for every applicable update, grouped by how it is applied. */
export function remedyForUpdates(units, { homes = [] } = {}) {
  const actionable = (units || []).filter((unit) => ACTIONABLE_UPDATE.has(unit.status));
  if (!actionable.length) return { prompt: "没有需要更新的技能或插件。" };
  const self = actionable.filter((unit) => unit.action?.kind === "self");
  const commandUnits = actionable.filter((unit) => unit.action?.command && unit.action.kind !== "self");
  const other = actionable.filter((unit) => !self.includes(unit) && !commandUnits.includes(unit));
  const list = (items) => items.slice(0, 30).map((unit) => `- ${unit.title}${unit.status === "conflict" ? "（有本地修改）" : ""}`);
  const lines = [`请帮我更新 ${actionable.length} 个技能或插件：`];
  if (self.length) lines.push("", `【在 Skill Control 里更新】${self.length} 项`, ...list(self));
  if (commandUnits.length) lines.push("", `【用各自的命令更新】${commandUnits.length} 项`, ...list(commandUnits));
  if (other.length) lines.push("", `【按说明手动更新】${other.length} 项`, ...other.slice(0, 30).map((unit) => `- ${unit.title}：${unit.action?.label || "按官方方式更新"}`));
  lines.push(
    "",
    "处理方式：",
    "1. 有本地修改的先备份当前目录，再更新。",
    "2. 命令逐条运行，每条完成后看输出是否成功，失败就停下来告诉我。",
    ...SAFETY.slice(1).map((step, index) => `${index + 3}. ${step}`),
    `${SAFETY.length + 2}. 全部完成后请我在 Skill Control 里重新检查更新。`,
  );
  const commands = [];
  for (const unit of commandUnits) {
    if (commands.some((item) => item.command === unit.action.command)) continue;
    commands.push({ label: unit.title, command: String(unit.action.command).slice(0, 1_000) });
    if (commands.length >= 30) break;
  }
  return { ...(commands.length ? { commands } : {}), prompt: cleanRemedyText(lines.join("\n"), homes, REMEDY_ALL_LIMIT) };
}

// ---------------------------------------------------------------------------
// Agent product versions

/** Remedy for an outdated (or unverifiable) Agent product; null when there is nothing to do. */
export function remedyForVersion(row, { homes = [] } = {}) {
  const installed = row.installed || {};
  const latest = row.latest || null;
  const internal = row.internal || {};
  const versions = latest ? `${installed.version} → ${latest.version}` : installed.version;
  const where = [`${row.name}（${installed.path || "位置未知"}）`];
  if (row.status === "update-available") {
    if (installed.source === "npm" && row.feed?.kind === "npm") {
      const npm = (internal.npm && shellPath(internal.npm)) || "npm";
      const pkg = row.feed.package;
      return remedy(
        buildPrompt(
          {
            problem: `${row.name} 有新版本（${versions}）`,
            where,
            goal: `${row.name} 升级到 ${latest.version}，原有配置和登录状态不变。`,
            steps: [`先记录当前版本以便回退：${npm} ls -g ${pkg} --depth=0。`, `用安装它的同一个 npm 升级：${npm} install -g ${pkg}@latest。`, "升级时不要改动它的配置目录。"],
            verify: `${npm} ls -g ${pkg} --depth=0 显示 ${latest.version}`,
          },
          homes,
        ),
        [
          { label: "升级", command: `${npm} install -g ${pkg}@latest` },
          { label: "检查版本", command: `${npm} ls -g ${pkg} --depth=0` },
        ],
      );
    }
    if (internal.native) {
      return remedy(
        buildPrompt({ problem: `${row.name} 有新版本（${versions}）`, where, goal: `${row.name} 升级到 ${latest.version}。`, steps: ["用 Claude Code 自带的更新命令：claude update。"], verify: `claude --version 显示 ${latest.version}` }, homes),
        [
          { label: "升级", command: "claude update" },
          { label: "检查版本", command: "claude --version" },
        ],
      );
    }
    if (row.id === "hermes-cli") {
      return remedy(
        buildPrompt(
          {
            problem: `${row.name} 有新版本（${versions}）`,
            where,
            goal: `Hermes Agent 升级到 ${latest.version}，配置、记忆和技能保留。`,
            steps: ["先确认 ~/.hermes/hermes-agent 没有未提交的本地修改（git -C ~/.hermes/hermes-agent status --short）。", "用 Hermes 自带的更新命令：hermes update。"],
            verify: "在 Skill Control 里重新检查版本，确认已是最新",
          },
          homes,
        ),
        [
          { label: "查看本地修改", command: "git -C ~/.hermes/hermes-agent status --short" },
          { label: "升级", command: "hermes update" },
        ],
      );
    }
    if (internal.bundledWith) {
      return remedy(buildPrompt({ problem: `${row.name} 有新版本（${versions}）`, where, goal: `${internal.bundledWith} 自带的这一份随 ${internal.bundledWith} 一起更新。`, steps: [`不要单独替换这份文件；更新 ${internal.bundledWith}（Hermes：hermes update）后它会一起更新。`], verify: "更新后在 Skill Control 里重新检查版本" }, homes));
    }
    return remedy(
      buildPrompt(
        {
          problem: `${row.name} 有新版本（${versions}）`,
          where,
          goal: `${row.name} 升级到 ${latest.version}。`,
          steps: ["打开应用，在菜单里选“检查更新”并按提示安装；不要从非官方渠道下载安装包。", ...(latest.notesUrl ? [`更新说明：${latest.notesUrl}`] : [])],
          verify: "重新打开应用后在“关于”里确认版本",
        },
        homes,
      ),
    );
  }
  if (row.status === "unknown" && installed.source === "app") {
    return remedy(buildPrompt({ problem: `无法自动查询 ${row.name} 的最新版本`, where, detail: row.reason || "", goal: "确认应用是最新版本。", steps: ["打开应用，在菜单里选“检查更新”。"], verify: "在“关于”里确认版本" }, homes));
  }
  return null;
}
