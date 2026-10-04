import {
  asArray,
  asBoolOrNull,
  asNumber,
  asOptionalString,
  asRecord,
  asString,
  asStringList,
} from "./parse";

export interface AgentFileEntry {
  id: string;
  name: string;
  kind: string;
  size: number;
  modifiedAt: string | null;
  displayPath: string;
  note: string | null;
}

export interface AgentFileGroup {
  id: string;
  label: string;
  note: string | null;
  files: AgentFileEntry[];
}

export interface AgentFiles {
  groups: AgentFileGroup[];
  /** Hermes profiles (when the agent has them) and the one listed. */
  profiles: string[];
  profile: string | null;
  /** OpenClaw / QClaw agent ids and the one listed. */
  agents: string[];
  agent: string | null;
  /** Experts / profiles / agents whose files /api/capability-files can browse. */
  capabilities: { capabilityId: string; name: string; kind: string; origin: string }[];
}

export interface AgentFileText {
  name: string;
  language: string;
  text: string;
  truncated: boolean;
  redactions: number;
}

export interface AgentToolItem {
  name: string;
  description: string;
  kind: string;
  enabled: boolean | null;
  tools: string[];
}

export interface AgentToolGroup {
  id: string;
  label: string;
  source: string;
  items: AgentToolItem[];
}

export interface AgentTools {
  groups: AgentToolGroup[];
  notes: string[];
}

export const AGENT_FILE_KIND_LABELS: Record<string, string> = {
  persona: "人格",
  identity: "身份",
  user: "用户画像",
  lessons: "经验",
  tools: "工具说明",
  memory: "记忆",
  heartbeat: "心跳",
  bootstrap: "启动",
  instructions: "指令",
  rules: "规则",
  other: "文件",
};

export function normalizeAgentFiles(raw: unknown): AgentFiles {
  const record = asRecord(raw);
  const groups = asArray(record.groups)
    .map((value, index): AgentFileGroup => {
      const group = asRecord(value);
      return {
        id: asString(group.id, `group-${index}`),
        label: asString(group.label, "文件"),
        note: asOptionalString(group.note),
        files: asArray(group.files)
          .map((file) => {
            const entry = asRecord(file);
            return {
              id: asString(entry.id),
              name: asString(entry.name, "未命名文件"),
              kind: asString(entry.kind, "other"),
              size: asNumber(entry.size),
              modifiedAt: asOptionalString(entry.modifiedAt),
              displayPath: asString(entry.displayPath),
              note: asOptionalString(entry.note),
            };
          })
          .filter((entry) => entry.id),
      };
    })
    .filter((group) => group.files.length > 0);
  const agents = asStringList(record.agents);
  // The service spreads the selected OpenClaw agent over the top-level agent id.
  const selectedAgent = asOptionalString(record.agentId);
  return {
    groups,
    profiles: asStringList(record.profiles),
    profile: asOptionalString(record.profile),
    agents,
    agent: selectedAgent && agents.includes(selectedAgent) ? selectedAgent : null,
    capabilities: asArray(record.capabilities)
      .map((value) => {
        const item = asRecord(value);
        return {
          capabilityId: asString(item.capabilityId),
          name: asString(item.name),
          kind: asString(item.kind),
          origin: asString(item.origin),
        };
      })
      .filter((item) => item.capabilityId),
  };
}

export function normalizeAgentFile(raw: unknown): AgentFileText {
  const record = asRecord(raw);
  const text = typeof record.text === "string" ? record.text : JSON.stringify(record.text ?? "", null, 2);
  return {
    name: asString(record.name, "文件"),
    language: asString(record.language, "text"),
    text,
    truncated: record.truncated === true,
    redactions: asNumber(record.redactions),
  };
}

export function normalizeAgentTools(raw: unknown): AgentTools {
  const record = asRecord(raw);
  return {
    groups: asArray(record.groups)
      .map((value, index): AgentToolGroup => {
        const group = asRecord(value);
        return {
          id: asString(group.id, `tools-${index}`),
          label: asString(group.label, "工具"),
          source: asString(group.source),
          items: asArray(group.items).map((itemValue) => {
            const item = asRecord(itemValue);
            return {
              name: asString(item.name, "未命名"),
              description: asString(item.description),
              kind: asString(item.kind),
              enabled: asBoolOrNull(item.enabled),
              tools: asStringList(item.tools),
            };
          }),
        };
      })
      .filter((group) => group.items.length > 0),
    notes: asStringList(record.notes),
  };
}
