import { asArray, asOptionalString, asRecord, asString, asStringList } from "./parse";

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
}

export interface CliTool {
  id: string;
  name: string;
  binaries: CliBinary[];
  latest: string | null;
  versionSkew: boolean;
  agents: CliAgentRow[];
  fixes: CliFix[];
}

export type CliPlan =
  | {
      kind: "self";
      planId: string;
      steps: { type: string; path: string; backup: string | null; diff: string | null }[];
      notes: string[];
      skipped: { agentId: string | null; reason: string }[];
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
    return {
      id: asString(tool.id),
      name: asString(tool.name, asString(tool.id)),
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
      agents: asArray(tool.agents).map((item) => {
        const agent = asRecord(item);
        const resolves = asRecord(agent.resolves);
        const skill = asRecord(agent.skill);
        return {
          agentId: asString(agent.agentId),
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
      }),
      fixes: asArray(tool.fixes).map((item) => {
        const fix = asRecord(item);
        return {
          id: asString(fix.id),
          label: asString(fix.label),
          kind: (asString(fix.kind) === "self" ? "self" : "guide") as CliFix["kind"],
          applicable: fix.applicable === true,
          reason: asOptionalString(fix.reason),
          instructions: asOptionalString(fix.instructions),
        };
      }),
    };
  }).filter((tool) => tool.id);
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
            ? { agentId: null, reason: item }
            : { agentId: asOptionalString(asRecord(item).agentId), reason: asString(asRecord(item).reason) },
        )
        .filter((item) => item.reason),
    };
  }
  return {
    kind: asString(record.kind) === "guide" ? "guide" : "none",
    planId: null,
    instructions: asOptionalString(record.instructions),
    message: asOptionalString(record.message),
  };
}

export type CheckState = "ok" | "warn" | "bad" | "na";

/** One status per column of an Agent row, with the plain-language reason when not ok. */
export function agentChecks(row: CliAgentRow, latest: string | null) {
  const checks: { label: string; state: CheckState; detail: string }[] = [];
  checks.push(
    row.resolves
      ? {
          label: "找得到命令",
          state: latest && row.resolves.version && row.resolves.version !== latest ? "warn" : "ok",
          detail: `${row.resolves.path}${row.resolves.version ? `（${row.resolves.version}）` : ""} · 来自 ${row.pathSource}`,
        }
      : { label: "找不到命令", state: "bad", detail: `它的 PATH（${row.pathSource || "未知来源"}）里没有这个命令` },
  );
  if (row.workspace) {
    checks.push({
      label: "工作区",
      state: row.workspaceConfigured ? "ok" : "bad",
      detail: `${WORKSPACE_LABELS[row.workspace] || row.workspace}${row.workspaceConfigured ? "已配置" : "还没有配置"}`,
    });
  }
  if (row.keychainReachable && row.keychainReachable !== "unknown") {
    checks.push({
      label: "钥匙串",
      state: row.keychainReachable === "yes" ? "ok" : "bad",
      detail: row.keychainReachable === "yes" ? "能读到凭据" : "沙箱里读不到钥匙串，需要降级保存方式",
    });
  }
  if (row.skill) {
    checks.push({
      label: "技能",
      state: row.skill.visible ? "ok" : row.skill.inLibrary ? "warn" : "bad",
      detail: row.skill.visible ? `${row.skill.name} 可见` : row.skill.inLibrary ? `${row.skill.name} 在库里，但这个 Agent 看不到` : `${row.skill.name} 不在技能库里`,
    });
  }
  if (row.allowRule && row.allowRule !== "n/a") {
    checks.push({ label: "放行规则", state: row.allowRule === "present" ? "ok" : "warn", detail: row.allowRule === "present" ? "已允许直接运行" : "每次运行都会请你确认" });
  }
  if (row.sandboxNetwork && row.sandboxNetwork !== "n/a") {
    checks.push({ label: "沙箱网络", state: row.sandboxNetwork === "ok" ? "ok" : "bad", detail: row.sandboxNetwork === "ok" ? "可以联网" : "沙箱默认不让联网" });
  }
  return checks;
}
