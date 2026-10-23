"use client";

import { useMemo } from "react";
import { useNow } from "../../hooks/useNow";
import { usePersistent } from "../../hooks/usePersistent";
import { isUnsupported, useResource } from "../../hooks/useResource";
import { api, errorMessage } from "../../lib/api";
import { COPIED_FOR_AI, COPY_FAILED, copyText } from "../../lib/clipboard";
import { formatRelative } from "../../lib/format";
import {
  CHANGE_LABELS,
  GUIDE_TEXT,
  groupSecrets,
  guidePrompt,
  secretPrompt,
  STORAGE_HINTS,
  STORAGE_LABELS,
  STORAGE_TONES,
  USED_BY_LABELS,
  type SecretChange,
  type SecretItem,
  type SecretStorage,
} from "../../lib/secrets";
import { persistentStore } from "../../lib/storage";
import { CopiesIcon, RefreshIcon } from "../icons";
import { useData } from "../providers/DataProvider";
import { useToast } from "../providers/ToastProvider";
import { AgentAvatar } from "../ui/Avatar";
import { EmptyState, Loading, SectionHeading, Segmented } from "../ui/basics";
import { RowMenu } from "../ui/RowMenu";

export const SECRETS_KEY = "secrets";

type Scope = "all" | "plaintext";
const scopeStore = persistentStore<Scope>("secrets-scope", "all", (value) => value === "all" || value === "plaintext");

function StorageTag({ storage }: { storage: SecretStorage }) {
  const tone = STORAGE_TONES[storage];
  return (
    <span className={`tag ${tone === "ok" ? "" : tone}`} title={STORAGE_HINTS[storage]}>
      {STORAGE_LABELS[storage]}
    </span>
  );
}

function SecretRow({ item, change }: { item: SecretItem; change: SecretChange | null }) {
  const { agentName } = useData();
  const toast = useToast();
  const now = useNow();
  const copy = async () => {
    const copied = await copyText(secretPrompt(item));
    toast.show(copied ? COPIED_FOR_AI : COPY_FAILED, copied ? {} : { tone: "error" });
  };
  // A value seen for the first time isn't a "change"; only a later difference is.
  const when = change
    ? change.at && now
      ? `${formatRelative(change.at, now)}${CHANGE_LABELS[change.kind]}`
      : null
    : item.changedAt && item.firstSeenAt && item.changedAt !== item.firstSeenAt && now
      ? `${formatRelative(item.changedAt, now)}值变了`
      : item.modifiedAt && now
        ? `文件 ${formatRelative(item.modifiedAt, now)}修改`
        : null;
  return (
    <li className={`secret-row ${item.storage === "plaintext" ? "plain" : ""}`}>
      <div className="secret-main">
        <div className="secret-line1">
          <b className="mono clamp-1" title={item.keyName}>
            {item.keyName}
          </b>
          <StorageTag storage={item.storage} />
          {change ? <span className={`tag ${change.kind === "removed" ? "mute" : "warn"}`}>{CHANGE_LABELS[change.kind]}</span> : null}
        </div>
        <code className="secret-loc clamp-1" title={item.location}>
          {item.location || "位置未知"}
        </code>
        <div className="secret-meta">
          {item.agents.length ? (
            <span className="avatar-row" aria-label={`读取它的 Agent：${item.agents.map(agentName).join("、")}`}>
              {item.agents.map((agentId) => (
                <span key={agentId} title={agentName(agentId)}>
                  <AgentAvatar id={agentId} size="xs" />
                </span>
              ))}
            </span>
          ) : null}
          {item.usedBy.length ? (
            <span className="clamp-1">
              用于 {item.usedBy.map((use) => `${USED_BY_LABELS[use.kind]} ${use.name}`).join("、")}
            </span>
          ) : null}
          {when ? <span className="nowrap">{when}</span> : null}
        </div>
        {item.note ? <div className="secret-note">{item.note}</div> : null}
      </div>
      <div className="secret-acts">
        <RowMenu label={`${item.keyName} 的更多操作`} items={[{ label: "复制这一项的提示词", title: "复制一段给 AI 的说明；只复制，不改任何东西", onSelect: () => void copy() }]} />
      </div>
    </li>
  );
}

/** The page's one reminder: why plaintext matters, and one prompt for all of it. */
function Guide({ text, prompt, plaintext }: { text: string; prompt: string; plaintext: number }) {
  const toast = useToast();
  const copy = async () => {
    const copied = await copyText(prompt);
    toast.show(copied ? COPIED_FOR_AI : COPY_FAILED, copied ? {} : { tone: "error" });
  };
  return (
    <div className="secret-guide" role="note">
      <div>
        <b>{plaintext ? `${plaintext} 个密钥以明文保存` : "密钥的保存方式"}</b>
        <span>{text}</span>
      </div>
      {prompt ? (
        <button type="button" className="btn sm" title="复制一段给 AI 的说明；只复制，不改任何东西" onClick={() => void copy()}>
          <CopiesIcon />
          复制给 AI 的提示词
        </button>
      ) : null}
    </div>
  );
}

/**
 * 连接器与 MCP → 密钥: which services' keys live where, who uses them and whether they
 * changed. Mainly informs; one reminder at the top, quiet per-row copy. Never values.
 */
export function SecretsView() {
  const report = useResource(SECRETS_KEY, () => api.secrets());
  const [scope, setScope] = usePersistent(scopeStore);
  const now = useNow();
  const data = report.data;
  const changes = useMemo(() => new Map((data?.changes || []).map((change) => [change.id, change])), [data]);
  if (isUnsupported(report.error)) {
    return <EmptyState title="本地服务还没有提供密钥清单">更新 Skill Control 后，这里会列出各服务的密钥存在哪里、谁在用、有没有变化。</EmptyState>;
  }
  if (report.status === "error" && !data) {
    return (
      <EmptyState tone="error" title="读取密钥清单失败">
        {errorMessage(report.error)}
      </EmptyState>
    );
  }
  if (!data) return <Loading label="正在查找密钥的位置…" rows={6} />;
  if (!data.items.length) {
    return <EmptyState title="没有找到密钥">各 Agent 的配置、技能目录里的 .env 文件和常见命令行工具的凭据文件里都没有找到。</EmptyState>;
  }
  const items = scope === "plaintext" ? data.items.filter((item) => item.storage === "plaintext") : data.items;
  const groups = groupSecrets(items);
  const storages = Object.entries(data.summary.byStorage).filter(([, count]) => count > 0);
  const guideText = data.guide?.text || GUIDE_TEXT;
  const prompt = data.guide?.prompt || (data.summary.plaintext ? guidePrompt(data.items) : "");
  return (
    <>
      {data.summary.plaintext || data.guide ? <Guide text={guideText} prompt={prompt} plaintext={data.summary.plaintext} /> : null}
      <div className="secret-overview">
        <span>
          共 <b>{data.summary.total}</b> 个
        </span>
        {storages.map(([storage, count]) => (
          <span key={storage}>
            <StorageTag storage={(storage in STORAGE_LABELS ? storage : "unknown") as SecretStorage} /> {count}
          </span>
        ))}
        {data.changes.length ? <span className="tag warn">最近有 {data.changes.length} 处变化</span> : null}
      </div>
      <div className="list-tools">
        <Segmented
          label="显示范围"
          value={scope}
          onChange={setScope}
          items={[
            { id: "all", label: "全部", count: data.items.length },
            { id: "plaintext", label: "只看明文", count: data.summary.plaintext },
          ]}
        />
        {data.generatedAt && now ? <span className="muted small">{formatRelative(data.generatedAt, now)}检查</span> : null}
        <button type="button" className="btn sm ghost" disabled={report.refreshing} onClick={() => void report.reload()}>
          <RefreshIcon className={report.refreshing ? "spin" : ""} />
          {report.refreshing ? "正在检查…" : "重新检查"}
        </button>
      </div>
      {!groups.length ? <EmptyState title="没有明文密钥">所有密钥都通过环境变量、钥匙串或凭据文件保存。</EmptyState> : null}
      {groups.map((group) => (
        <section key={group.service} aria-label={group.service}>
          <SectionHeading title={group.service} note={`${group.items.length} 个${group.plaintext ? ` · ${group.plaintext} 个明文` : ""}`} />
          <ul className="secret-list">
            {group.items.map((item) => (
              <SecretRow key={item.id} item={item} change={changes.get(item.id) || null} />
            ))}
          </ul>
        </section>
      ))}
      <p className="footnote">
        来源：各 Agent 的配置文件、技能目录里的 .env 文件（只列键名）和常见命令行工具的凭据文件。不读取系统钥匙串的内容。“有变化”只比较一个用本机随机盐算出的短指纹，判断值变没变。
      </p>
    </>
  );
}
