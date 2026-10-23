"use client";

import { useMemo } from "react";
import { useNow } from "../../hooks/useNow";
import { usePersistent } from "../../hooks/usePersistent";
import { isUnsupported, useResource } from "../../hooks/useResource";
import { useScrollMemory } from "../../hooks/useScrollMemory";
import { api, errorMessage } from "../../lib/api";
import { COPIED_FOR_AI, COPY_FAILED, copyText } from "../../lib/clipboard";
import { formatRelative } from "../../lib/format";
import {
  CHANGE_LABELS,
  groupSecrets,
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
import { RefreshIcon, SparkIcon } from "../icons";
import { useData } from "../providers/DataProvider";
import { useToast } from "../providers/ToastProvider";
import { AgentAvatar } from "../ui/Avatar";
import { EmptyState, Loading, SectionHeading, Segmented, TopBar } from "../ui/basics";
import { ACTION_NOTES } from "../ui/RemedyPanel";

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
        <button
          type="button"
          className="btn sm"
          title={item.storage === "plaintext" ? "复制一段说明：让 AI 帮你把明文改成环境变量引用" : "复制一段说明：让 AI 帮你检查保存方式"}
          onClick={() => void copy()}
        >
          <SparkIcon />
          复制 AI 指令
        </button>
        <small className="act-note">{ACTION_NOTES.copy}</small>
      </div>
    </li>
  );
}

/** 密钥: which services' keys live where, who uses them and whether they changed. Never values. */
export function SecretsPage() {
  const report = useResource(SECRETS_KEY, () => api.secrets());
  const [scope, setScope] = usePersistent(scopeStore);
  const scrollRef = useScrollMemory<HTMLDivElement>("secrets");
  const now = useNow();
  const data = report.data;
  const changes = useMemo(() => new Map((data?.changes || []).map((change) => [change.id, change])), [data]);
  const items = data ? (scope === "plaintext" ? data.items.filter((item) => item.storage === "plaintext") : data.items) : [];
  const groups = groupSecrets(items);
  const storages = data ? Object.entries(data.summary.byStorage).filter(([, count]) => count > 0) : [];
  return (
    <section className="page" aria-labelledby="page-title">
      <TopBar title={<span id="page-title">密钥</span>} sub="只显示密钥的名称和位置，从不读取或显示它的值">
        <button type="button" className="btn ghost" disabled={report.refreshing || !data} onClick={() => void report.reload()}>
          <RefreshIcon className={report.refreshing ? "spin" : ""} />
          {report.refreshing ? "正在检查…" : "重新检查"}
        </button>
      </TopBar>
      <div className="scroll" ref={scrollRef}>
        {isUnsupported(report.error) ? (
          <EmptyState title="本地服务还没有提供密钥清单">更新 Skill Control 后，这里会列出各服务的密钥存在哪里、谁在用、有没有变化。</EmptyState>
        ) : report.status === "error" && !data ? (
          <EmptyState tone="error" title="读取密钥清单失败">
            {errorMessage(report.error)}
          </EmptyState>
        ) : !data ? (
          <Loading label="正在查找密钥的位置…" rows={6} />
        ) : !data.items.length ? (
          <EmptyState title="没有找到密钥">各 Agent 的配置、技能目录里的 .env 文件和常见命令行工具的凭据文件里都没有找到。</EmptyState>
        ) : (
          <>
            <div className="health-summary">
              <div className="hs">
                <b>{data.summary.total}</b>
                <span>个密钥</span>
              </div>
              <div className={`hs ${data.summary.plaintext ? "danger" : ""}`}>
                <b>{data.summary.plaintext}</b>
                <span>明文写在文件里</span>
              </div>
              <div className={`hs ${data.changes.length ? "warn" : ""}`}>
                <b>{data.changes.length}</b>
                <span>最近有变化</span>
              </div>
            </div>
            {storages.length ? (
              <p className="secret-storages">
                {storages.map(([storage, count]) => (
                  <span key={storage}>
                    <StorageTag storage={(storage in STORAGE_LABELS ? storage : "unknown") as SecretStorage} /> {count}
                  </span>
                ))}
              </p>
            ) : null}
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
        )}
      </div>
    </section>
  );
}
