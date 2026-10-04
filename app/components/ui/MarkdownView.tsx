"use client";

import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isImagePath, resolveRelativePath } from "../../lib/file-tree";
import { BlobImage } from "./BlobImage";

/**
 * Renders Markdown without ever injecting raw HTML (`skipHtml`). Relative images load
 * through the service's asset endpoint; relative links open the file in the same browser.
 */
export function MarkdownView({
  content,
  filePath,
  assetSrc,
  onOpenFile,
}: {
  content: string;
  filePath?: string;
  assetSrc?: (path: string) => string;
  onOpenFile?: (path: string) => void;
}) {
  const components: Components = {
    a: ({ href, children }) => {
      const target = href || "";
      if (/^https:\/\//i.test(target)) {
        return (
          <a href={target} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
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
    },
    img: ({ src, alt }) => {
      const source = typeof src === "string" ? src : "";
      const relative = filePath ? resolveRelativePath(filePath, source) : null;
      if (relative && assetSrc && isImagePath(relative)) {
        return <BlobImage src={assetSrc(relative)} alt={alt || ""} className="md-img" />;
      }
      return <span className="img-placeholder">外部图片未加载{alt ? `：${alt}` : ""}</span>;
    },
    table: ({ children }) => (
      <div className="md-table">
        <table>{children}</table>
      </div>
    ),
  };
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
        {content}
      </Markdown>
    </div>
  );
}
