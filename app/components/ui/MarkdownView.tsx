"use client";

import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isImagePath, resolveRelativePath } from "../../lib/file-tree";
import { BlobImage } from "./BlobImage";
import { ExternalLink } from "./ExternalLink";

interface LinkContext {
  filePath?: string;
  assetSrc?: (path: string) => string;
  onOpenFile?: (path: string) => void;
}

/** Per-document link handling, read by the module-level renderers below. */
const MarkdownLinks = createContext<LinkContext>({});

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { filePath, onOpenFile } = useContext(MarkdownLinks);
  const target = href || "";
  if (/^https:\/\//i.test(target)) {
    return (
      <ExternalLink href={target}>{children}</ExternalLink>
    );
  }
  const relative = filePath ? resolveRelativePath(filePath, target) : null;
  if (relative && onOpenFile) {
    return (
      <button type="button" className="md-link" onClick={() => onOpenFile(relative)}>
        {children}
      </button>
    );
  }
  return <span className="md-link-inert">{children}</span>;
}

function MarkdownImage({ src, alt }: { src?: unknown; alt?: string }) {
  const { filePath, assetSrc } = useContext(MarkdownLinks);
  const source = typeof src === "string" ? src : "";
  const relative = filePath ? resolveRelativePath(filePath, source) : null;
  if (relative && assetSrc && isImagePath(relative)) {
    return <BlobImage src={assetSrc(relative)} alt={alt || ""} className="md-img" />;
  }
  return <span className="img-placeholder">外部图片未加载{alt ? `：${alt}` : ""}</span>;
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div className="md-table">
      <table>{children}</table>
    </div>
  );
}

// Stable renderer identities: re-rendering a document never remounts images or tables.
const COMPONENTS: Components = {
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
  table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
};
const PLUGINS = [remarkGfm];

const MarkdownBody = memo(function MarkdownBody({ content }: { content: string }) {
  return (
    <Markdown remarkPlugins={PLUGINS} skipHtml components={COMPONENTS}>
      {content}
    </Markdown>
  );
});

/**
 * Renders Markdown without ever injecting raw HTML (`skipHtml`). Relative images load
 * through the service's asset endpoint; relative links open the file in the same browser.
 */
export function MarkdownView({ content, filePath, assetSrc, onOpenFile }: { content: string } & LinkContext) {
  const links = useMemo(() => ({ filePath, assetSrc, onOpenFile }), [filePath, assetSrc, onOpenFile]);
  return (
    <div className="markdown">
      <MarkdownLinks.Provider value={links}>
        <MarkdownBody content={content} />
      </MarkdownLinks.Provider>
    </div>
  );
}
