"use client";

import { useMemo, useState } from "react";
import { frontmatterRows, splitFrontmatter } from "../../lib/frontmatter";
import { isMarkdownPath } from "../../lib/file-tree";
import { formatBytes } from "../../lib/format";
import type { FileContent } from "../../lib/types";
import { BlobImage } from "../ui/BlobImage";
import { CodeView, languageLabel, MaskNote } from "../ui/CodeView";
import { EmptyState, Segmented } from "../ui/basics";
import { MarkdownView } from "../ui/MarkdownView";

export type ViewMode = "rendered" | "source";

export function FrontmatterTable({ frontmatter }: { frontmatter: string }) {
  const rows = useMemo(() => frontmatterRows(frontmatter), [frontmatter]);
  if (rows === null) {
    return (
      <div className="fm">
        <h4>文件头（frontmatter）</h4>
        <p className="footnote">文件头不是有效的 YAML，下面按原文显示。</p>
        <CodeView text={frontmatter} language="yaml" wrap />
      </div>
    );
  }
  if (!rows.length) return null;
  return (
    <div className="fm">
      <h4>文件头（frontmatter）</h4>
      <dl className="kv">
        {rows.map((row) => (
          <div className="kv-row" key={row.key}>
            <dt className="k">{row.key}</dt>
            <dd>{row.nested ? <CodeView text={row.value} language="yaml" wrap /> : row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Markdown with a 渲染 / 原文 toggle; frontmatter becomes a key–value table. */
export function MarkdownFile({
  text,
  path,
  assetSrc,
  onOpenFile,
}: {
  text: string;
  path: string;
  assetSrc?: (path: string) => string;
  onOpenFile?: (path: string) => void;
}) {
  const [mode, setMode] = useState<ViewMode>("rendered");
  const { frontmatter, body } = useMemo(() => splitFrontmatter(text), [text]);
  return (
    <div className="md-file">
      <div className="viewer-tools">
        <Segmented
          label="显示方式"
          value={mode}
          onChange={setMode}
          items={[
            { id: "rendered", label: "渲染" },
            { id: "source", label: "原文" },
          ]}
        />
      </div>
      {mode === "source" ? (
        <CodeView text={text} language="md" path={path} wrap />
      ) : (
        <>
          {frontmatter !== null ? <FrontmatterTable frontmatter={frontmatter} /> : null}
          <MarkdownView content={body} filePath={path} assetSrc={assetSrc} onOpenFile={onOpenFile} />
        </>
      )}
      <MaskNote text={text} />
    </div>
  );
}

export function FileViewer({
  file,
  assetSrc,
  onOpenFile,
}: {
  file: FileContent;
  assetSrc: (path: string) => string;
  onOpenFile?: (path: string) => void;
}) {
  const meta = (
    <div className="code-meta">
      <code>{file.path}</code>
      <span>
        {formatBytes(file.size)}
        {file.previewKind === "text" ? ` · ${languageLabel(file.language, file.path)}` : ""} · 只读
      </span>
    </div>
  );
  if (file.previewKind === "image") {
    return (
      <div className="viewer">
        {meta}
        <div className="img-stage">
          <BlobImage src={assetSrc(file.path)} alt={file.name} />
        </div>
      </div>
    );
  }
  if (file.previewKind !== "text" || file.content === null) {
    return (
      <div className="viewer">
        {meta}
        <EmptyState title="这个文件不能预览">{file.reason || "可能是二进制文件，或体积超过了预览上限。"}</EmptyState>
      </div>
    );
  }
  return (
    <div className="viewer">
      {meta}
      {isMarkdownPath(file.path) ? (
        <MarkdownFile key={file.path} text={file.content} path={file.path} assetSrc={assetSrc} onOpenFile={onOpenFile} />
      ) : (
        <>
          <CodeView text={file.content} language={file.language} path={file.path} />
          <MaskNote text={file.content} />
        </>
      )}
    </div>
  );
}
