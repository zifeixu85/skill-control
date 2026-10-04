"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";

type BlobState = { status: "loading" } | { status: "ready"; url: string } | { status: "error"; message: string };

function BlobImageInner({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [state, setState] = useState<BlobState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    api.fetchBlob(src).then(
      (blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (cancelled) URL.revokeObjectURL(objectUrl);
        else setState({ status: "ready", url: objectUrl });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "error", message: errorMessage(error, "图片读取失败。") });
      },
    );
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);

  if (state.status === "loading") return <span className="img-placeholder">正在加载图片…</span>;
  if (state.status === "error") return <span className="img-placeholder">无法显示图片：{state.message}</span>;
  // A short-lived blob URL from the local service; next/image cannot optimize it.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={className} src={state.url} alt={alt} />;
}

/**
 * Loads a local-service image as a short-lived blob URL (decoded by Chromium, released
 * when the file changes), the same way the desktop app previews skill assets.
 */
export function BlobImage(props: { src: string; alt: string; className?: string }) {
  return <BlobImageInner key={props.src} {...props} />;
}
