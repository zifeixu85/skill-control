"use client";

import type { MouseEvent, ReactNode } from "react";
import { openExternal } from "../../lib/external";

/** An https link that opens outside the app (desktop bridge or a new tab). */
export function ExternalLink({ href, children, className, title }: { href: string; children: ReactNode; className?: string; title?: string }) {
  if (!/^https:\/\//iu.test(href)) return <span className={className}>{children}</span>;
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    openExternal(href);
  };
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={className} title={title} onClick={onClick}>
      {children}
    </a>
  );
}
