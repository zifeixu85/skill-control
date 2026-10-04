"use client";

import { useMemo, useRef, useState } from "react";
import { useResource } from "../../hooks/useResource";
import { errorMessage } from "../../lib/api";
import { revealTop } from "../../lib/dom";
import { buildFileTree, defaultFilePath } from "../../lib/file-tree";
import type { FileContent, FileListing } from "../../lib/types";
import { EmptyState, Loading } from "../ui/basics";
import { FileTree } from "./FileTree";
import { FileViewer } from "./FileViewer";

export interface FileSource {
  /** Stable cache key, e.g. "skill:<instanceId>". */
  key: string;
  list: () => Promise<FileListing>;
  read: (path: string) => Promise<FileContent>;
  asset: (path: string) => string;
  preferred?: string | null;
}

function SelectedFile({ source, path, onOpenFile }: { source: FileSource; path: string; onOpenFile: (path: string) => void }) {
  const file = useResource(`file:${source.key}:${path}`, () => source.read(path));
  if (file.status === "error") {
    return <EmptyState tone="error" title="读取文件失败">{errorMessage(file.error)}</EmptyState>;
  }
  if (!file.data) return <Loading label="正在读取文件…" rows={6} />;
  return <FileViewer file={file.data} assetSrc={source.asset} onOpenFile={onOpenFile} />;
}

/** Whole-directory browser: tree of every file plus a viewer for the selected one. */
export function FileBrowser({ source }: { source: FileSource }) {
  const listing = useResource(`files:${source.key}`, source.list);
  const [chosen, setChosen] = useState<string | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => listing.data?.entries || [], [listing.data]);
  const tree = useMemo(() => buildFileTree(entries), [entries]);
  const fileCount = entries.filter((entry) => entry.type !== "directory").length;
  const selected =
    chosen && entries.some((entry) => entry.path === chosen) ? chosen : defaultFilePath(entries, source.preferred);

  const open = (path: string) => {
    if (!entries.some((entry) => entry.path === path && entry.type !== "directory")) {
      setMissing(path);
      return;
    }
    setMissing(null);
    setChosen(path);
    revealTop(viewRef.current);
  };

  if (listing.status === "error") {
    return <EmptyState tone="error" title="读取文件列表失败">{errorMessage(listing.error)}</EmptyState>;
  }
  if (!listing.data) return <Loading label="正在读取文件列表…" rows={4} />;
  if (!fileCount) return <EmptyState title="没有可以预览的文件">敏感文件（如密钥、认证信息）不会出现在这里。</EmptyState>;

  return (
    <div className="browser-wrap">
      <div className="browser">
        <div className="browser-tree">
          <div className="browser-tree-head">
            <span>{fileCount} 个文件</span>
            {listing.data.truncated ? <span className="tag warn">只列出前 1,500 项</span> : null}
          </div>
          <FileTree nodes={tree} selected={selected} onSelect={open} expandAll={entries.length <= 40} />
        </div>
        <div className="browser-view" ref={viewRef}>
          {missing ? (
            <p className="inline-note warn" role="status">
              <span>
                链接指向的文件不存在：<code>{missing}</code>
              </span>
              <button type="button" className="btn sm ghost" onClick={() => setMissing(null)}>
                知道了
              </button>
            </p>
          ) : null}
          {selected ? <SelectedFile key={selected} source={source} path={selected} onOpenFile={open} /> : null}
        </div>
      </div>
    </div>
  );
}
