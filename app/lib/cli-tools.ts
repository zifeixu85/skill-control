import { historyIdOf } from "./history";
import { asArray, asOptionalNumber, asOptionalString, asRecord, asString, asStringList } from "./parse";

/** /api/cli-tools shapes (docs/ARCHITECTURE.md · 统一技能库与 CLI 工具卡片). */

export interface CliBinary {
  path: string;
  version: string | null;
  kind: string;
  via: string;
  target: string | null;
}

export interface CliAgentRow {
  agentId: string;
  /** Display name from the service, used when the scan doesn't know this Agent. */
  agentName: string | null;
  pathSource: string;
  resolves: { path: string; version: string | null } | null;
  workspace: string | null;
  workspaceConfigured: boolean | null;
  secretSource: string | null;
  keychainReachable: string | null;
  skill: { name: string; inLibrary: boolean; visible: boolean } | null;
  allowRule: string | null;
  sandboxNetwork: string | null;
  plist: string | null;
}

export interface CliFix {
  id: string;
  label: string;
  kind: "self" | "guide";
  applicable: boolean;
  reason: string | null;
  instructions: string | null;
  /** Agents the fix is about; newer services send these instead of ids inside `reason`. */
  agentIds: string[];
}

export interface CliOwner {
  type: "npm" | "uv" | "pipx" | "app" | "native" | "homebrew" | "cargo" | "script" | "other";
  name: string | null;
  version: string | null;
}

/** Per-Agent availability for the inventory list (dots); deep tools also have `agents` rows. */
export interface CliAvailability {
  agentId: string;
  available: boolean | null;
  detail: string | null;
  /** Whether the Agent's allow rules already cover this command (null when not applicable). */
  allowed: boolean | null;
}

export interface CliTool {
  id: string;
  name: string;
  binaries: CliBinary[];
  latest: string | null;
  versionSkew: boolean;
  agents: CliAgentRow[];
  fixes: CliFix[];
  /** Inventory fields (v0.2 §12). */
  path: string | null;
  kind: string | null;
  owner: CliOwner | null;
  description: string | null;
  size: number | null;
  mtime: string | null;
  referencedBySkills: string[];
  referencedCount: number;
  aiRelated: boolean;
  /** Why it counts as AI-related: skill-reference, known-ai-cli, ai-app, npm-keywords, local-bin. */
  aiReasons: string[];
  /** Where it was found (~/.local/bin, nvm, Homebrew, …). */
  sourceLabel: string | null;
  /** Other entry points to the same file. */
  links: string[];
  target: string | null;
  availability: CliAvailability[];
  /** Has the per-Agent table or fixes (the old lark-cli card). */
  deep: boolean;
}

export interface CliInventory {
  tools: CliTool[];
  summary: { total: number; aiRelated: number };
}

const OWNER_TYPES: CliOwner["type"][] = ["npm", "uv", "pipx", "app", "native", "homebrew", "cargo", "script"];

export const OWNER_LABELS: Record<CliOwner["type"], string> = {
  npm: "npm 全局包",
  uv: "uv 工具",
  pipx: "pipx 工具",
  app: "应用自带",
  native: "原生程序",
  homebrew: "Homebrew",
  cargo: "cargo 安装",
  script: "脚本",
  other: "其他",
};

export const AI_REASON_LABELS: Record<string, string> = {
  "skill-reference": "有技能提到它",
  "known-ai-cli": "常见的 AI 命令行工具",
  "ai-app": "指向 AI 应用",
  "npm-keywords": "npm 包标注了 AI / Agent / MCP",
  "local-bin": "装在 ~/.local/bin",
};

function availabilityOf(raw: unknown, rows: CliAgentRow[]): CliAvailability[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        const entry = asRecord(item);
        const state = asString(entry.state || entry.status).toLowerCase();
        const available =
          typeof entry.available === "boolean"
            ? entry.available
            : "resolves" in entry
              ? Boolean(entry.resolves)
              : state
                ? ["ok", "available", "yes", "found"].includes(state)
                  ? true
                  : ["missing", "no", "not-found", "unavailable"].includes(state)
                    ? false
                    : null
                : null;
        return {
          agentId: asString(entry.agentId),
          available,
          detail: asOptionalString(entry.detail) || asOptionalString(entry.pathSource),
          allowed: typeof entry.allowed === "boolean" ? entry.allowed : null,
        };
      })
      .filter((entry) => entry.agentId);
  }
  const map = asRecord(raw);
  if (Object.keys(map).length) {
    return Object.entries(map).map(([agentId, value]) => {
      const entry = asRecord(value);
      const flag = typeof value === "boolean" ? value : typeof entry.available === "boolean" ? entry.available : null;
      const state = typeof value === "string" ? value.toLowerCase() : "";
      return { agentId, available: flag ?? (state ? ["ok", "available", "yes"].includes(state) : null), detail: asOptionalString(entry.detail), allowed: null };
    });
  }
  return rows.map((row) => ({
    agentId: row.agentId,
    available: Boolean(row.resolves),
    detail: row.resolves ? row.resolves.path : null,
    allowed: row.allowRule === "present" || row.allowRule === "ok" ? true : row.allowRule === "missing" ? false : null,
  }));
}

export type CliPlan =
  | {
      kind: "self";
      planId: string;
      steps: { type: string; path: string; backup: string | null; diff: string | null }[];
      notes: string[];
      skipped: { agentId: string | null; agentName: string | null; reason: string }[];
      expiresAt: string | null;
    }
  | { kind: "guide" | "none"; planId: null; instructions: string | null; message: string | null };

export const BINARY_KIND_LABELS: Record<string, string> = {
  "npm-global": "npm 全局安装",
  bundled: "随产品自带",
  manual: "手动安装",
  wrapper: "启动脚本",
};

export const WORKSPACE_LABELS: Record<string, string> = {
  local: "本机工作区",
  hermes: "Hermes 工作区",
  openclaw: "OpenClaw 工作区",
};

const boolOrNull = (value: unknown) => (typeof value === "boolean" ? value : null);

export function normalizeCliTools(raw: unknown): CliTool[] {
  return asArray(asRecord(raw).tools).map((value) => {
    const tool = asRecord(value);
    const rows = normalizeAgentRows(tool.agents);
    const fixes = normalizeFixes(tool.fixes);
    const owner = asRecord(tool.owner);
    const ownerType = asString(owner.type) as CliOwner["type"];
    const referenced = tool.referencedBySkills;
    const referencedBySkills = Array.isArray(referenced) ? asStringList(referenced) : [];
    return {
      id: asString(tool.id) || asString(tool.name) || asString(tool.path),
      name: asString(tool.name, asString(tool.id)),
      path: asOptionalString(tool.path),
      kind: asOptionalString(tool.kind),
      owner: Object.keys(owner).length
        ? { type: OWNER_TYPES.includes(ownerType) ? ownerType : "other", name: asOptionalString(owner.name), version: asOptionalString(owner.version) }
        : null,
      description: asOptionalString(tool.description),
      size: asOptionalNumber(tool.size),
      mtime: asOptionalString(tool.mtime),
      referencedBySkills,
      referencedCount: typeof referenced === "number" ? referenced : referencedBySkills.length,
      aiRelated: tool.aiRelated === true || (tool.aiRelated === undefined && (rows.length > 0 || fixes.length > 0)),
      aiReasons: asStringList(tool.aiReasons),
      sourceLabel: asOptionalString(tool.sourceLabel) || asOptionalString(tool.source),
      links: asStringList(tool.links),
      target: asOptionalString(tool.target),
      availability: availabilityOf(rows.length ? null : tool.agents, rows),
      deep: rows.length > 0 || fixes.length > 0,
      binaries: asArray(tool.binaries).map((item) => {
        const binary = asRecord(item);
        return {
          path: asString(binary.path),
          version: asOptionalString(binary.version),
          kind: asString(binary.kind),
          via: asString(binary.via),
          target: asOptionalString(binary.target),
        };
      }),
      latest: asOptionalString(tool.latest),
      versionSkew: tool.versionSkew === true,
      agents: rows,
      fixes,
    };
  }).filter((tool) => tool.id);
}

/** The full response: the tools plus the service's summary (or one counted here). */
export function normalizeCliInventory(raw: unknown): CliInventory {
  const tools = normalizeCliTools(raw);
  const summary = asRecord(asRecord(raw).summary);
  return {
    tools,
    summary: {
      total: asOptionalNumber(summary.total) ?? tools.length,
      aiRelated: asOptionalNumber(summary.aiRelated) ?? tools.filter((tool) => tool.aiRelated).length,
    },
  };
}

/** Deep rows only: entries that describe how the Agent resolves the command. */
function normalizeAgentRows(raw: unknown): CliAgentRow[] {
  return asArray(raw)
    .filter((item) => {
      const agent = asRecord(item);
      return "pathSource" in agent || "resolves" in agent || "workspace" in agent || "allowRule" in agent;
    })
    .map((item) => {
        const agent = asRecord(item);
        const resolves = asRecord(agent.resolves);
        const skill = asRecord(agent.skill);
        return {
          agentId: asString(agent.agentId),
          agentName: asOptionalString(agent.agentName),
          pathSource: asString(agent.pathSource),
          resolves: Object.keys(resolves).length ? { path: asString(resolves.path), version: asOptionalString(resolves.version) } : null,
          workspace: asOptionalString(agent.workspace),
          workspaceConfigured: boolOrNull(agent.workspaceConfigured),
          secretSource: asOptionalString(agent.secretSource),
          keychainReachable: asOptionalString(agent.keychainReachable),
          skill: Object.keys(skill).length
            ? { name: asString(skill.name), inLibrary: skill.inLibrary === true, visible: skill.visible === true }
            : null,
          allowRule: asOptionalString(agent.allowRule),
          sandboxNetwork: asOptionalString(agent.sandboxNetwork),
          plist: asOptionalString(agent.plist),
        };
      });
}

function normalizeFixes(raw: unknown): CliFix[] {
  return asArray(raw).map((item) => {
    const fix = asRecord(item);
    return {
      id: asString(fix.id),
      label: asString(fix.label),
      kind: (asString(fix.kind) === "self" ? "self" : "guide") as CliFix["kind"],
      applicable: fix.applicable === true,
      reason: asOptionalString(fix.reason),
      instructions: asOptionalString(fix.instructions),
      agentIds: asStringList(fix.agentIds),
    };
  });
}

export function normalizeCliPlan(raw: unknown): CliPlan {
  const record = asRecord(raw);
  const planId = asOptionalString(record.planId);
  if (planId) {
    return {
      kind: "self",
      planId,
      steps: asArray(record.steps).map((item) => {
        const step = asRecord(item);
        return { type: asString(step.type), path: asString(step.path), backup: asOptionalString(step.backup), diff: asOptionalString(step.diff) };
      }),
      notes: asStringList(record.notes),
      skipped: asArray(record.skipped)
        .map((item) =>
          typeof item === "string"
            ? { agentId: null, agentName: null, reason: item }
            : {
                agentId: asOptionalString(asRecord(item).agentId),
                agentName: asOptionalString(asRecord(item).agentName),
                reason: asString(asRecord(item).reason),
              },
        )
        .filter((item) => item.reason),
      expiresAt: asOptionalString(record.expiresAt),
    };
  }
  return {
    kind: asString(record.kind) === "guide" ? "guide" : "none",
    planId: null,
    instructions: asOptionalString(record.instructions),
    message: asOptionalString(record.message),
  };
}

export interface CliApplyResult {
  changed: { path: string; backup: string | null }[];
  historyId: string | null;
}

export function normalizeCliApply(raw: unknown): CliApplyResult {
  const record = asRecord(raw);
  return {
    changed: asArray(record.changed)
      .map((item) => ({ path: asString(asRecord(item).path), backup: asOptionalString(asRecord(item).backup) }))
      .filter((item) => item.path),
    historyId: historyIdOf(record),
  };
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A fix's reason with Agent ids shown as names. Newer services already write names and
 * send `agentIds` (shown as avatars); older ones put raw ids in the text, so any whole id
 * from `agentIds` or the tool's own Agents is replaced by its name.
 */
export function fixReason(fix: CliFix, knownAgentIds: string[], agentName: (id: string) => string): string {
  const reason = fix.reason || "";
  const ids = [...new Set(fix.agentIds.length ? fix.agentIds : knownAgentIds)].filter(Boolean);
  if (!ids.length) return reason;
  // Whole ids only: not inside words, paths (~/.codex/…) or file names.
  const alternatives = [...ids].sort((left, right) => right.length - left.length).map(escapeRegExp).join("|");
  const pattern = new RegExp(`(?<![\\w./-])(${alternatives})(?![\\w./-])`, "g");
  return reason.replace(pattern, (id) => agentName(id));
}

/** Lines of guide text that are shell commands (copyable), as opposed to prose. */
export function commandLines(text: string): Set<string> {
  const commands = new Set<string>();
  for (const line of text.split("\n").map((item) => item.trim())) {
    if (/^[a-z][\w.-]*(\s+[^\s，。；：、（）]+)+$/i.test(line) && !/[\u4e00-\u9fff]/.test(line)) commands.add(line);
  }
  return commands;
}

export type CheckState = "ok" | "warn" | "bad" | "na";

/** One status per column of an Agent row, with the plain-language reason when not ok. */
export type CheckKey = "command" | "workspace" | "keychain" | "skill" | "allow" | "sandbox";

export interface AgentCheck {
  key: CheckKey;
  label: string;
  /** A few characters for a table cell; `detail` is the full sentence. */
  short: string;
  state: CheckState;
  detail: string;
}

/** Column order and headings when the checks are shown as a table. */
export const CHECK_COLUMNS: { key: CheckKey; label: string }[] = [
  { key: "command", label: "命令" },
  { key: "workspace", label: "工作区" },
  { key: "keychain", label: "钥匙串" },
  { key: "skill", label: "技能" },
  { key: "allow", label: "放行规则" },
  { key: "sandbox", label: "沙箱网络" },
];

export function agentChecks(row: CliAgentRow, latest: string | null): AgentCheck[] {
  const checks: AgentCheck[] = [];
  checks.push(
    row.resolves
      ? {
          key: "command",
          label: "找得到命令",
          short: row.resolves.version || "找得到",
          state: latest && row.resolves.version && row.resolves.version !== latest ? "warn" : "ok",
          detail: `${row.resolves.path}${row.resolves.version ? `（${row.resolves.version}）` : ""} · 来自 ${row.pathSource}`,
        }
      : { key: "command", label: "找不到命令", short: "找不到", state: "bad", detail: `它的 PATH（${row.pathSource || "未知来源"}）里没有这个命令` },
  );
  if (row.workspace) {
    checks.push({
      key: "workspace",
      label: "工作区",
      short: row.workspaceConfigured ? "已配置" : "未配置",
      state: row.workspaceConfigured ? "ok" : "bad",
      detail: `${WORKSPACE_LABELS[row.workspace] || row.workspace}${row.workspaceConfigured ? "已配置" : "还没有配置"}`,
    });
  }
  if (row.keychainReachable && row.keychainReachable !== "unknown") {
    const ok = row.keychainReachable === "yes";
    checks.push({ key: "keychain", label: "钥匙串", short: ok ? "能读到" : "读不到", state: ok ? "ok" : "bad", detail: ok ? "能读到凭据" : "沙箱里读不到钥匙串，需要降级保存方式" });
  }
  if (row.skill) {
    checks.push({
      key: "skill",
      label: "技能",
      short: row.skill.visible ? "可见" : row.skill.inLibrary ? "看不到" : "不在库里",
      state: row.skill.visible ? "ok" : row.skill.inLibrary ? "warn" : "bad",
      detail: row.skill.visible ? `${row.skill.name} 可见` : row.skill.inLibrary ? `${row.skill.name} 在库里，但这个 Agent 看不到` : `${row.skill.name} 不在技能库里`,
    });
  }
  if (row.allowRule && row.allowRule !== "n/a") {
    const ok = row.allowRule === "present";
    checks.push({ key: "allow", label: "放行规则", short: ok ? "已允许" : "每次确认", state: ok ? "ok" : "warn", detail: ok ? "已允许直接运行" : "每次运行都会请你确认" });
  }
  if (row.sandboxNetwork && row.sandboxNetwork !== "n/a") {
    const ok = row.sandboxNetwork === "ok";
    checks.push({ key: "sandbox", label: "沙箱网络", short: ok ? "可联网" : "不能联网", state: ok ? "ok" : "bad", detail: ok ? "可以联网" : "沙箱默认不让联网" });
  }
  return checks;
}
