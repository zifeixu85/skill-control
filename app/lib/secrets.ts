import { asArray, asNumber, asOptionalString, asRecord, asString, asStringList } from "./parse";
import { normalizeRemedy, type Remedy } from "./remedy";

/**
 * GET /api/secrets: where each service's keys live and who uses them. Values are never sent
 * or shown; the fingerprint only tells whether a value changed.
 */

export type SecretStorage = "plaintext" | "env-ref" | "keychain" | "credential-file" | "oauth" | "unknown";

export interface SecretItem {
  id: string;
  service: string;
  keyName: string;
  location: string;
  storage: SecretStorage;
  agents: string[];
  usedBy: { kind: "mcp" | "skill" | "cli" | "other"; name: string }[];
  fingerprint: string | null;
  firstSeenAt: string | null;
  changedAt: string | null;
  modifiedAt: string | null;
  /** e.g. "主凭据在系统钥匙串里". */
  note: string | null;
  remedy: Remedy | null;
}

export interface SecretChange {
  id: string;
  kind: "added" | "changed" | "removed";
  at: string | null;
}

export interface SecretsReport {
  generatedAt: string | null;
  /** The page's one reminder: text to show, prompt to copy (from the service, or built here). */
  guide: { text: string; prompt: string } | null;
  items: SecretItem[];
  changes: SecretChange[];
  summary: { total: number; plaintext: number; byStorage: Record<string, number> };
}

const STORAGES: SecretStorage[] = ["plaintext", "env-ref", "keychain", "credential-file", "oauth"];

export const STORAGE_LABELS: Record<SecretStorage, string> = {
  plaintext: "明文",
  "env-ref": "环境变量引用",
  keychain: "系统钥匙串",
  "credential-file": "凭据文件",
  oauth: "OAuth 登录",
  unknown: "未知",
};

export const STORAGE_HINTS: Record<SecretStorage, string> = {
  plaintext: "值直接写在配置文件里，任何能读这个文件的程序都能看到",
  "env-ref": "配置里只写了变量名，值来自环境变量",
  keychain: "值保存在 macOS 钥匙串里",
  "credential-file": "值保存在这个工具自己的凭据文件里",
  oauth: "通过账号登录授权，没有长期密钥",
  unknown: "无法判断保存方式",
};

export const STORAGE_TONES: Record<SecretStorage, "danger" | "ok" | "info" | "mute" | "warn"> = {
  plaintext: "danger",
  "env-ref": "ok",
  keychain: "ok",
  "credential-file": "warn",
  oauth: "info",
  unknown: "mute",
};

export const USED_BY_LABELS: Record<SecretItem["usedBy"][number]["kind"], string> = { mcp: "MCP", skill: "技能", cli: "命令行", other: "其他" };

export const CHANGE_LABELS: Record<SecretChange["kind"], string> = { added: "新出现", changed: "值变了", removed: "已移除" };

export function normalizeSecrets(raw: unknown): SecretsReport {
  const record = asRecord(raw);
  const items = asArray(record.items)
    .map((value): SecretItem | null => {
      const item = asRecord(value);
      const id = asString(item.id);
      if (!id) return null;
      const storage = asString(item.storage) as SecretStorage;
      return {
        id,
        service: asString(item.service, "其他"),
        keyName: asString(item.keyName, "(未命名)"),
        location: asString(item.location),
        storage: STORAGES.includes(storage) ? storage : "unknown",
        agents: asStringList(item.agents),
        usedBy: asArray(item.usedBy)
          .map((entry) => {
            const use = asRecord(entry);
            const kind = asString(use.kind);
            return { kind: (["mcp", "skill", "cli"].includes(kind) ? kind : "other") as SecretItem["usedBy"][number]["kind"], name: asString(use.name) };
          })
          .filter((use) => use.name),
        // Only a short hex tag is ever accepted; anything longer is not shown.
        fingerprint: /^[0-9a-f]{4,16}$/iu.test(asString(item.fingerprint)) ? asString(item.fingerprint) : null,
        firstSeenAt: asOptionalString(item.firstSeenAt),
        changedAt: asOptionalString(item.changedAt),
        modifiedAt: asOptionalString(item.modifiedAt),
        note: asOptionalString(item.note),
        remedy: normalizeRemedy(item.remedy),
      };
    })
    .filter((item): item is SecretItem => Boolean(item));
  const summary = asRecord(record.summary);
  const byStorage: Record<string, number> = {};
  for (const [key, value] of Object.entries(asRecord(summary.byStorage))) byStorage[key] = asNumber(value);
  const guide = asRecord(record.guide);
  return {
    generatedAt: asOptionalString(record.generatedAt),
    guide: asString(guide.text) || asString(guide.prompt) ? { text: asString(guide.text), prompt: asString(guide.prompt) } : null,
    items,
    changes: asArray(record.changes)
      .map((value) => {
        const change = asRecord(value);
        const kind = asString(change.kind);
        return { id: asString(change.id), kind: (["added", "changed", "removed"].includes(kind) ? kind : "changed") as SecretChange["kind"], at: asOptionalString(change.at) };
      })
      .filter((change) => change.id),
    summary: {
      total: asNumber(summary.total, items.length),
      plaintext: asNumber(summary.plaintext, items.filter((item) => item.storage === "plaintext").length),
      byStorage,
    },
  };
}

export interface SecretGroup {
  service: string;
  items: SecretItem[];
  plaintext: number;
}

/** By service; services with plaintext keys first, then by name. */
export function groupSecrets(items: SecretItem[]): SecretGroup[] {
  const groups = new Map<string, SecretItem[]>();
  for (const item of items) groups.set(item.service, [...(groups.get(item.service) || []), item]);
  return [...groups.entries()]
    .map(([service, list]) => ({
      service,
      items: [...list].sort((left, right) => Number(right.storage === "plaintext") - Number(left.storage === "plaintext") || left.keyName.localeCompare(right.keyName)),
      plaintext: list.filter((item) => item.storage === "plaintext").length,
    }))
    .sort((left, right) => right.plaintext - left.plaintext || left.service.localeCompare(right.service, "zh-Hans-CN"));
}

/**
 * "复制 AI 指令" text: names, places and the goal only — never a value. Uses the service's
 * own remedy when it sends one.
 */
export function secretPrompt(item: SecretItem): string {
  if (item.remedy?.prompt) return item.remedy.prompt;
  const where = item.location ? `（位置：${item.location}）` : "";
  const users = item.usedBy.length ? `它被 ${item.usedBy.map((use) => `${USED_BY_LABELS[use.kind]}「${use.name}」`).join("、")} 使用。` : "";
  if (item.storage === "plaintext") {
    return `${item.service} 的密钥 ${item.keyName} 以明文写在配置文件里${where}。${users}请帮我把它改成环境变量引用：在配置里只写变量名，把值放进我的 shell 环境或系统钥匙串；先告诉我要改的文件和改法，备份后再改，改完确认使用它的服务还能正常工作。不要在回复里显示密钥的值。`;
  }
  return `请帮我检查 ${item.service} 的密钥 ${item.keyName}${where}的保存方式（目前是${STORAGE_LABELS[item.storage]}）是否安全、是否还有程序在用。${users}只告诉我结论和建议，改动前先问我，不要显示密钥的值。`;
}

export const GUIDE_TEXT = "明文存储不安全：能读这些文件的程序和备份都能看到密钥。可以改成环境变量引用，或交给系统钥匙串保存。";

/**
 * The page's one prompt when the service sends none: every plaintext key by name and place,
 * the goal, and the caution that each service must still connect afterwards. Never a value.
 */
export function guidePrompt(items: SecretItem[]): string {
  const plain = items.filter((item) => item.storage === "plaintext");
  const list = plain.slice(0, 40).map((item, index) => `${index + 1}. ${item.service} · ${item.keyName}（${item.location || "位置未知"}）`);
  return [
    `我的电脑上有 ${plain.length} 个密钥以明文写在配置文件里（Skill Control 只列了名称和位置，没有读取值）：`,
    ...list,
    plain.length > 40 ? `……另有 ${plain.length - 40} 个` : "",
    "",
    "请帮我逐个改成更安全的保存方式（环境变量引用或系统钥匙串）：",
    "- 先告诉我每个文件要怎么改，备份后再改；",
    "- 改完后逐个确认对应的服务还能正常连接（MCP 能启动、命令行工具能登录），不能连接的先恢复原样再告诉我；",
    "- 不要在回复里显示密钥的值。",
  ]
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n");
}
