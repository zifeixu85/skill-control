"use client";

import { useRef, useState } from "react";
import { useNow } from "../../../hooks/useNow";
import { isUnsupported, useResource } from "../../../hooks/useResource";
import { AGENT_FILE_KIND_LABELS, type AgentFileEntry, type AgentFiles as AgentFilesData } from "../../../lib/agent-extras";
import { api, errorMessage } from "../../../lib/api";
import { revealTop } from "../../../lib/dom";
import { formatBytes, formatRelative } from "../../../lib/format";
import { isMarkdownPath } from "../../../lib/file-tree";
import { MarkdownFile } from "../../files/FileViewer";
import { CopyPathButton } from "../../files/ConfigDetailView";
import { FileIcon } from "../../icons";
import { useNav } from "../../providers/NavProvider";
import { CodeView, languageLabel, MaskNote } from "../../ui/CodeView";
import { EmptyState, Loading } from "../../ui/basics";

function AgentFileView({ file }: { file: AgentFileEntry }) {
  const content = useResource(`agent-file:${file.id}`, () => api.agentFile(file.id));
  if (content.status === "error") return <EmptyState tone="error" title="读取文件失败">{errorMessage(content.error)}</EmptyState>;
  if (!content.data) return <Loading label="正在读取文件…" rows={6} />;
  const { text, language, truncated, redactions } = content.data;
  return (
    <div className="viewer">
      <div className="code-meta">
        <code>{file.displayPath}</code>
        <span>
          {formatBytes(file.size)} · {languageLabel(language, file.name)} · 只读
        </span>
      </div>
      {redactions ? <p className="safe-note">已隐藏 {redactions} 处疑似密钥或令牌。</p> : null}
      {language === "md" || isMarkdownPath(file.name) ? (
        <MarkdownFile text={text} path={file.name} />
      ) : (
        <>
          <CodeView text={text} language={language} path={file.name} truncated={truncated} />
          <MaskNote text={text} />
        </>
      )}
      {truncated && (language === "md" || isMarkdownPath(file.name)) ? <p className="footnote">文件较大，只显示了前 512 KB。</p> : null}
      <div className="insp-acts">
        <CopyPathButton path={file.displayPath} />
      </div>
    </div>
  );
}

function FileList({ data, selected, onSelect }: { data: AgentFilesData; selected: string | null; onSelect: (id: string) => void }) {
  const now = useNow();
  return (
    <div className="agent-file-list">
      {data.groups.map((group) => (
        <div key={group.id} className="afile-group">
          <h3>
            {group.label} <em>{group.files.length}</em>
          </h3>
          {group.note ? <p className="muted small">{group.note}</p> : null}
          <ul>
            {group.files.map((file) => (
              <li key={file.id}>
                <button
                  type="button"
                  className={`afile ${selected === file.id ? "on" : ""}`}
                  aria-current={selected === file.id ? "true" : undefined}
                  onClick={() => onSelect(file.id)}
                  title={file.displayPath}
                >
                  <FileIcon />
                  <span className="afile-name">{file.name}</span>
                  <small>
                    {AGENT_FILE_KIND_LABELS[file.kind] || "文件"}
                    {now && file.modifiedAt ? ` · ${formatRelative(file.modifiedAt, now)}` : ""}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function AgentFiles({ agentId, agentName }: { agentId: string; agentName: string }) {
  const { openDrawer } = useNav();
  const [scope, setScope] = useState<{ profile: string | null; agent: string | null }>({ profile: null, agent: null });
  const key = `agent-files:${agentId}:${scope.profile || ""}:${scope.agent || ""}`;
  const files = useResource(key, () => api.agentFiles(agentId, { profile: scope.profile, agentId: scope.agent }));
  const [selected, setSelected] = useState<string | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const open = (id: string) => {
    setSelected(id);
    revealTop(viewRef.current);
  };

  if (isUnsupported(files.error)) {
    return <EmptyState title="本地服务还没有提供这项数据">更新 Skill Control 后可以查看 {agentName} 的指令、人格和记忆文件。</EmptyState>;
  }
  if (files.status === "error" && !files.data) return <EmptyState tone="error" title="读取文件失败">{errorMessage(files.error)}</EmptyState>;
  if (!files.data) return <Loading label="正在列出文件…" rows={5} />;
  const data = files.data;
  const all = data.groups.flatMap((group) => group.files);
  const current = all.find((file) => file.id === selected) || all[0] || null;

  return (
    <div className="agent-files">
      {data.profiles.length > 1 || data.agents.length > 1 ? (
        <label className="field inline">
          <span>{data.profiles.length > 1 ? "Profile" : "Agent"}</span>
          <select
            value={(data.profiles.length > 1 ? data.profile : data.agent) || ""}
            onChange={(event) => {
              setSelected(null);
              setScope(data.profiles.length > 1 ? { profile: event.target.value, agent: null } : { profile: null, agent: event.target.value });
            }}
          >
            {(data.profiles.length > 1 ? data.profiles : data.agents).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {data.capabilities.length ? (
        <p className="muted small">
          也可以查看：
          {data.capabilities.map((item) => (
            <button key={item.capabilityId} type="button" className="link-btn" onClick={() => openDrawer({ kind: "expert", id: item.capabilityId })}>
              {item.name}
            </button>
          ))}
        </p>
      ) : null}
      {!all.length ? (
        <EmptyState title="没有找到人格或记忆文件">{agentName} 的指令、人格、记忆文件会显示在这里；敏感文件不会列出。</EmptyState>
      ) : (
        <div className="browser-wrap">
          <div className="browser">
            <div className="browser-tree">
              <FileList data={data} selected={current?.id || null} onSelect={open} />
            </div>
            <div className="browser-view" ref={viewRef}>
              {current ? <AgentFileView key={current.id} file={current} /> : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
