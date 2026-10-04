import { createHash } from "node:crypto";
import { lstat, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { tokenizeCommand } from "./config-mask.mjs";
import { frontmatterBlock, readYamlScalar } from "./frontmatter.mjs";
import { compactHomePath, homeVariants, object, readTextPrefix, text } from "./fs-safe.mjs";
import { createCommandLookup, defaultSearchDirectories } from "./path-lookup.mjs";
import { secretFieldReport } from "./secret-fields.mjs";

/**
 * GET /api/health-report: read-only checks over skill roots, skills, MCP servers and
 * plugins. Nothing is executed or repaired; each finding names a suggested fix.
 */

const OPENCLAW_SKILL_LIMIT = 256 * 1024;
const HARD_SKILL_LIMIT = 1024 * 1024;
const PER_GROUP_LIMIT = 30;
const TOTAL_LIMIT = 1_000;
const ROOT_ENTRY_LIMIT = 2_000;

const FIX = {
  none: { kind: "none", label: "无需处理" },
  open: { kind: "open", label: "打开所在位置" },
  reinstall: { kind: "reinstall", label: "重新安装或同步" },
  removeLink: { kind: "remove-link", label: "删除失效链接" },
  enable: { kind: "enable", label: "在 Agent 中启用" },
  configure: { kind: "configure", label: "检查配置" },
};

const findingId = (...parts) => createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 16);

function createCollector(homeDirectory, homes) {
  const findings = [];
  const groups = new Map();
  return {
    add(rawFinding) {
      // Every path leaves as "~/…", whatever form the scan used.
      const finding = rawFinding.path ? { ...rawFinding, path: compactHomePath(expand(rawFinding.path, homeDirectory), homes) } : rawFinding;
      const groupKey = `${finding.category}\0${finding.agentId || ""}`;
      const count = (groups.get(groupKey) || 0) + 1;
      groups.set(groupKey, count);
      if (count > PER_GROUP_LIMIT || findings.length >= TOTAL_LIMIT) return;
      findings.push({
        id: findingId(finding.category, finding.agentId || "", finding.skillName || "", finding.path || "", finding.title),
        ...finding,
        title: text(finding.title, 160),
        detail: text(finding.detail || "", 600),
      });
    },
    finish() {
      // One summary line for each group that was cut short.
      for (const [groupKey, count] of groups) {
        if (count <= PER_GROUP_LIMIT || findings.length >= TOTAL_LIMIT + 50) continue;
        const [category, agentId] = groupKey.split("\0");
        const sample = findings.find((item) => item.category === category && (item.agentId || "") === agentId);
        findings.push({
          id: findingId(category, agentId, "overflow"),
          severity: sample?.severity || "info",
          category,
          title: `另有 ${count - PER_GROUP_LIMIT} 项同类问题未逐条列出`,
          detail: "",
          ...(agentId ? { agentId } : {}),
          fix: FIX.none,
        });
      }
      return findings;
    },
  };
}

const expand = (value, homeDirectory) =>
  value === "~" ? homeDirectory : typeof value === "string" && value.startsWith("~/") ? path.join(homeDirectory, value.slice(2)) : value;

/** Broken links and folders without SKILL.md at the top of every configured root. */
async function checkRoots(scan, context) {
  const seen = new Set();
  for (const agent of scan.agents || []) {
    for (const root of agent.roots || []) {
      const rootPath = expand(root.path, context.homeDirectory);
      if (!rootPath || seen.has(`${agent.id}\0${rootPath}`)) continue;
      seen.add(`${agent.id}\0${rootPath}`);
      let entries;
      try {
        entries = await readdir(rootPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.slice(0, ROOT_ENTRY_LIMIT)) {
        if (entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
        const full = path.join(rootPath, entry.name);
        const display = compactHomePath(full, context.homes);
        if (entry.isSymbolicLink()) {
          try {
            await stat(full);
          } catch {
            context.add({
              severity: "error",
              category: "broken-link",
              title: `失效的技能链接：${entry.name}`,
              detail: "链接指向的目录已不存在，Agent 会忽略它。",
              agentId: agent.id,
              skillName: entry.name,
              path: display,
              fix: FIX.removeLink,
            });
            continue;
          }
        }
        let info;
        try {
          info = await stat(full);
        } catch {
          continue;
        }
        if (!info.isDirectory()) continue;
        if ((await hasFile(full, "SKILL.md")) || (await hasNestedSkill(full))) continue;
        // Empty or bookkeeping folders (only hidden entries or sub-folders) are not skills;
        // a Hermes category folder carries only DESCRIPTION.md.
        if (!(await hasVisibleFile(full)) || (await hasFile(full, "DESCRIPTION.md"))) continue;
        context.add({
          severity: "warn",
          category: "missing-skill-md",
          title: `缺少 SKILL.md：${entry.name}`,
          detail: "技能目录里没有 SKILL.md，Agent 不会加载它。",
          agentId: agent.id,
          skillName: entry.name,
          path: display,
          fix: FIX.open,
        });
      }
    }
  }
}

async function hasVisibleFile(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true })).some((entry) => entry.isFile() && !entry.name.startsWith("."));
  } catch {
    return false;
  }
}

async function hasFile(directory, name) {
  try {
    return (await stat(path.join(directory, name))).isFile();
  } catch {
    return false;
  }
}

/** Category folders (Hermes) and plugin bundles hold skills one level down. */
async function hasNestedSkill(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.slice(0, 200)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      if (entry.name === "skills" || (await hasFile(child, "SKILL.md"))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** SKILL.md frontmatter, size and naming for each scanned skill copy. */
async function checkSkillFiles(scan, context) {
  const checked = new Set();
  for (const skill of scan.skills || []) {
    for (const instance of skill.instances) {
      const directory = expand(instance.path, context.homeDirectory);
      if (!directory || checked.has(`${instance.agentId}\0${directory}`)) continue;
      checked.add(`${instance.agentId}\0${directory}`);
      const file = path.join(directory, "SKILL.md");
      let info;
      try {
        info = await lstat(file);
        if (info.isSymbolicLink()) info = await stat(file);
      } catch {
        continue;
      }
      const base = { agentId: instance.agentId, skillName: instance.name, path: compactHomePath(file, context.homes) };
      if (info.size > HARD_SKILL_LIMIT) {
        context.add({ ...base, severity: "error", category: "oversize", title: `SKILL.md 超过 1 MB：${instance.name}`, detail: "多数 Agent 会截断或拒绝加载过大的技能说明。", fix: FIX.open });
      } else if (info.size > OPENCLAW_SKILL_LIMIT) {
        context.add({ ...base, severity: "warn", category: "oversize", title: `SKILL.md 超过 256 KB：${instance.name}`, detail: "OpenClaw 不加载超过 256 KB 的 SKILL.md。", fix: FIX.open });
      }
      const head = await readTextPrefix(file, 64_000);
      if (head.status !== "ok") continue;
      const block = frontmatterBlock(head.text);
      const folder = path.basename(directory);
      if (!block) {
        context.add({ ...base, severity: "warn", category: "frontmatter", title: `SKILL.md 缺少 frontmatter：${folder}`, detail: "缺少 name 与 description，部分 Agent 无法识别。", fix: FIX.open });
        continue;
      }
      const name = readYamlScalar(block, "name");
      const missing = [!name && "name", !readYamlScalar(block, "description") && "description"].filter(Boolean);
      if (missing.length) {
        context.add({ ...base, severity: "warn", category: "frontmatter", title: `frontmatter 缺少 ${missing.join("、")}：${folder}`, detail: "Agent 依赖这两个字段决定何时使用技能。", fix: FIX.open });
      }
      if (name && name !== folder && name.toLowerCase() !== folder.toLowerCase()) {
        context.add({ ...base, severity: "info", category: "name-mismatch", title: `技能名与目录名不一致：${text(name, 60)} ≠ ${text(folder, 60)}`, detail: "Agent Skills 规范要求两者一致，部分 Agent 会按目录名识别。", fix: FIX.open });
      }
    }
  }
}

/** Product state: differing copies, hidden, shadowed, disabled, archived and requirements. */
async function checkSkillState(scan, context) {
  for (const skill of scan.skills || []) {
    const byAgent = new Map();
    for (const instance of skill.instances) {
      const list = byAgent.get(instance.agentId) || [];
      list.push(instance);
      byAgent.set(instance.agentId, list);
      const base = { agentId: instance.agentId, skillName: instance.name, path: instance.path };
      if (instance.hiddenByProduct) {
        context.add({ ...base, severity: "info", category: "hidden-by-product", title: `${instance.agentName || instance.agentId} 不会加载：${instance.name}`, detail: instance.hiddenByProduct === "symlink-escape" ? "链接指向技能目录之外，产品出于安全考虑会跳过。" : "产品规则隐藏了这份副本。", fix: FIX.none });
      } else if (instance.shadowed) {
        context.add({ ...base, severity: "info", category: "shadowed", title: `被同名技能覆盖：${instance.name}`, detail: `生效的是来自「${instance.shadowedBy || "其他目录"}」的副本。`, fix: FIX.none });
      }
      if (instance.disabled) {
        context.add({ ...base, severity: "info", category: "disabled", title: `已停用：${instance.name}`, detail: "这份技能在 Agent 配置中被停用。", fix: FIX.enable });
      }
      await checkRequirements(instance, base, context);
    }
    for (const [agentId, instances] of byAgent) {
      const active = instances.filter((instance) => !instance.inactive);
      if (new Set(active.map((instance) => instance.hash)).size > 1) {
        context.add({ agentId, skillName: skill.name, severity: "warn", category: "differing-copies", title: `同一 Agent 内有不同版本：${skill.name}`, detail: `${active.length} 份生效副本内容不同。`, fix: FIX.reinstall });
      }
    }
  }
  for (const archived of scan.archivedSkills || []) {
    context.add({ agentId: archived.agentId || "hermes", skillName: archived.name, path: archived.path, severity: "info", category: "archived", title: `已归档：${archived.name}`, detail: "Hermes Curator 归档了这个技能，它不会再被加载。", fix: FIX.none });
  }
}

async function checkRequirements(instance, base, context) {
  const requirements = object(instance.requirements);
  for (const bin of [...(requirements.bins || []), ...(requirements.anyBins || [])].slice(0, 20)) {
    const result = await context.lookup(bin);
    if (!result.checked) continue;
    if (!result.found) {
      context.add({ ...base, severity: "warn", category: "missing-bin", title: `缺少命令 ${text(bin, 40)}：${instance.name}`, detail: "技能声明需要这个命令，但在常见安装位置都没有找到。", fix: { kind: "configure", label: `安装 ${text(bin, 40)}` } });
    } else if (result.nvmOnly) {
      context.add({ ...base, severity: "warn", category: "nvm-only", title: `${text(bin, 40)} 只在 nvm 中可用：${instance.name}`, detail: "从程序坞启动的 Agent 不会加载 nvm，可能找不到这个命令。", fix: FIX.configure });
    }
  }
  for (const name of (requirements.env || []).slice(0, 20)) {
    if (typeof name === "string" && /^[A-Z_][A-Z0-9_]{0,63}$/u.test(name) && !context.env[name]) {
      context.add({ ...base, severity: "warn", category: "missing-env", title: `未设置环境变量 ${name}：${instance.name}`, detail: "技能声明需要这个环境变量；这里只检查名称，不读取值。", fix: FIX.configure });
    }
  }
}

/**
 * The program an MCP server starts. `command` is a program path (args are separate), which
 * may contain spaces; only a bare command line without args is split. Relative paths
 * depend on the agent's working folder and are not checked.
 */
function mcpExecutable(config, homeDirectory) {
  const raw = config.command.trim();
  const expanded = raw.startsWith("~/") ? path.join(homeDirectory, raw.slice(2)) : raw;
  if (path.isAbsolute(expanded)) return expanded;
  if (expanded.includes("/") || expanded.includes("\\")) return null;
  if (!/\s/u.test(expanded)) return expanded;
  return Array.isArray(config.args) ? null : tokenizeCommand(expanded)[0]?.value || null;
}

/** MCP commands that cannot be found and literal secrets kept in configuration. */
async function checkMcp(entries, context) {
  for (const entry of entries) {
    const config = object(entry.config);
    const base = { agentId: entry.agentId, path: entry.source };
    if (typeof config.command === "string" && !config.url && !config.httpUrl) {
      const name = mcpExecutable(config, context.homeDirectory);
      const result = name ? await context.lookup(name) : { checked: false };
      const label = text(path.basename(name || ""), 40);
      if (result.checked && !result.found) {
        context.add({ ...base, severity: "warn", category: "mcp-command-missing", title: `MCP「${entry.name}」的命令 ${label} 不存在`, detail: "Agent 启动这个 MCP 服务时会失败。", fix: FIX.configure });
      } else if (result.nvmOnly) {
        context.add({ ...base, severity: "warn", category: "nvm-only", title: `MCP「${entry.name}」的命令 ${label} 只在 nvm 中可用`, detail: "从程序坞启动的 Agent 不会加载 nvm，可能无法启动这个服务。", fix: FIX.configure });
      }
    }
    const likely = secretFieldReport(config).likely;
    if (likely.length) {
      context.add({ ...base, severity: "warn", category: "mcp-literal-secret", title: `MCP「${entry.name}」配置里有明文密钥`, detail: `字段：${likely.slice(0, 10).join("、")}。建议改用环境变量引用。`, fix: FIX.configure });
    }
  }
}

function checkPlugins(plugins, context) {
  for (const plugin of plugins || []) {
    const base = { agentId: plugin.agentId, path: null };
    if (plugin.installed && plugin.configured === false && plugin.agentId === "codex") {
      context.add({ ...base, severity: "info", category: "plugin-state", title: `插件只在缓存中：${plugin.displayName}`, detail: "Codex 配置里没有这个插件，它不会被加载。", fix: FIX.none });
    } else if (plugin.installed === false) {
      context.add({ ...base, severity: "warn", category: "plugin-state", title: `插件未安装：${plugin.displayName}`, detail: "配置里启用了插件，但本机找不到它的文件。", fix: FIX.reinstall });
    } else if (plugin.enabled === "unknown") {
      context.add({ ...base, severity: "info", category: "plugin-state", title: `插件启用状态未知：${plugin.displayName}`, detail: "配置没有明确启用或停用这个插件。", fix: FIX.none });
    }
  }
}

/** Update results cached by the last manual check (never fetched here). */
function checkUpdates(updates, context) {
  const sourced = new Set(["skills-cli", "lark-cli", "workbuddy-skillhub", "clawhub"]);
  for (const unit of updates || []) {
    const base = { agentId: unit.instances?.[0]?.agentId, skillName: unit.title, path: unit.instances?.[0]?.path };
    if (["update-available", "conflict"].includes(unit.status)) {
      context.add({
        ...base,
        severity: "info",
        category: "update-available",
        title: `有可用更新：${unit.title}`,
        detail: [unit.current && unit.latest ? `${unit.current} → ${unit.latest}` : "", unit.sourceLabel].filter(Boolean).join("，"),
        fix: unit.action?.kind === "self" || unit.action?.kind === "delegate" ? { kind: "reinstall", label: unit.action.label } : FIX.none,
      });
    }
    // Edits to skills without a source are normal; only report copies that have one.
    if ((unit.status === "conflict" || unit.status === "locally-modified") && sourced.has(unit.sourceType)) {
      context.add({
        ...base,
        severity: unit.status === "conflict" ? "warn" : "info",
        category: "locally-modified",
        title: `本地修改过：${unit.title}`,
        detail: unit.status === "conflict" ? "上游也有更新，直接更新会覆盖本地修改。" : "与安装时的版本不同。",
        fix: FIX.open,
      });
    }
    if (unit.lockDrift) {
      context.add({ ...base, severity: "info", category: "lock-drift", title: `锁记录落后：${unit.title}`, detail: "内容已是上游最新，但 .skill-lock.json 里记的是旧哈希。", fix: FIX.none });
    }
  }
}

/** Library hygiene and CLI tool readiness (computed elsewhere, read here). */
function checkLibraryAndCli(library, cliTools, context) {
  for (const issue of library?.issues || []) {
    if (issue.id === "library-drift") {
      context.add({ severity: "info", category: "library-drift", agentId: issue.agentId, title: issue.title, detail: `${issue.detail}${issue.names?.length ? ` 例如：${issue.names.slice(0, 8).join("、")}` : ""}`, fix: { kind: "configure", label: "在技能库中批量改为链接" } });
    } else if (issue.id === "library-external-link") {
      context.add({ severity: "warn", category: "library-external-link", title: issue.title, detail: `${issue.detail} ${issue.names.slice(0, 8).join("、")}`, path: library.root, fix: { kind: "configure", label: "在技能库中收编" } });
    }
  }
  for (const tool of cliTools || []) {
    const versions = [...new Set((tool.binaries || []).map((binary) => binary.version).filter(Boolean))];
    if (versions.length > 1) {
      context.add({ severity: "warn", category: "cli-version-skew", title: `${tool.name} 有 ${versions.length} 个不同版本`, detail: (tool.binaries || []).map((binary) => `${binary.path} ${binary.version || "未知"}`).join("；"), fix: FIX.configure });
    }
    for (const agent of tool.agents || []) {
      if (tool.binaries?.length && agent.resolves === null) {
        context.add({ severity: "warn", category: "cli-not-on-agent-path", agentId: agent.agentId, title: `${agent.agentId} 找不到 ${tool.name}`, detail: `按 ${agent.pathSource} 的 PATH 查找不到这个命令。`, fix: FIX.configure });
      }
      if (agent.workspace && agent.workspace !== "local" && agent.workspaceConfigured === false) {
        context.add({ severity: "warn", category: "cli-workspace-unconfigured", agentId: agent.agentId, title: `${agent.agentId} 使用的 ${tool.name} 工作区未配置`, detail: `该 Agent 运行时会改用 ${agent.workspace} 工作区，需要单独绑定（lark-cli config bind --source ${agent.workspace}）。`, fix: FIX.configure });
      }
    }
  }
}

/** Leftover temporary git clones from Codex (~/.codex/.tmp/git-*), with their size. */
async function checkCodexTemp(context) {
  const root = path.join(context.homeDirectory, ".codex", ".tmp");
  let entries;
  try {
    entries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && entry.name.startsWith("git-"));
  } catch {
    return;
  }
  if (!entries.length) return;
  let bytes = 0;
  let visited = 0;
  let truncated = false;
  const deadline = Date.now() + 3_000;
  const walk = async (directory) => {
    if (truncated) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if ((visited += 1) > 300_000 || Date.now() > deadline) {
        truncated = true;
        return;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) bytes += (await lstat(full).catch(() => ({ size: 0 }))).size;
    }
  };
  for (const entry of entries) await walk(path.join(root, entry.name));
  const size = bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
  context.add({
    severity: "info",
    category: "codex-tmp-leftovers",
    title: `Codex 临时克隆残留 ${entries.length} 个，${truncated ? "至少 " : ""}${size}`,
    detail: "~/.codex/.tmp/git-* 是 Codex 安装插件时留下的临时仓库，确认 Codex 未在运行后可以删除。",
    path: root,
    fix: FIX.open,
  });
}

function checkSharedRoots(scan, context) {
  for (const shared of scan.sharedRoots || []) {
    context.add({
      severity: "info",
      category: "shared-root",
      title: `技能目录被 ${shared.agentIds.length} 个 Agent 共用`,
      detail: `${shared.agentIds.join("、")} 读取同一个目录${shared.managedBy ? `（由 ${shared.managedBy} 管理）` : ""}，在任一 Agent 中修改都会影响其他 Agent。`,
      path: shared.realPath,
      fix: FIX.none,
    });
  }
}

export async function buildHealthReport({
  scan,
  plugins = [],
  mcpEntries = [],
  updates = [],
  library = null,
  cliTools = [],
  homeDirectory = homedir(),
  homes = [homeDirectory],
  searchDirectories = null,
  env = process.env,
} = {}) {
  const allHomes = [...new Set([...homes, ...(await homeVariants(homeDirectory))])];
  const collector = createCollector(homeDirectory, allHomes);
  const directories = searchDirectories || (await defaultSearchDirectories({ homeDirectory }));
  const context = { homeDirectory, homes: allHomes, env, lookup: createCommandLookup(directories), add: collector.add };
  await checkRoots(scan, context);
  await checkSkillFiles(scan, context);
  await checkSkillState(scan, context);
  await checkMcp(mcpEntries, context);
  checkPlugins(plugins, context);
  checkSharedRoots(scan, context);
  checkUpdates(updates, context);
  checkLibraryAndCli(library, cliTools, context);
  await checkCodexTemp(context);
  const findings = collector.finish();
  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((left, right) => order[left.severity] - order[right.severity] || left.category.localeCompare(right.category));
  const counts = { error: 0, warn: 0, info: 0 };
  const categories = {};
  for (const finding of findings) {
    counts[finding.severity] += 1;
    categories[finding.category] = (categories[finding.category] || 0) + 1;
  }
  return { generatedAt: new Date().toISOString(), counts, categories, findings };
}
