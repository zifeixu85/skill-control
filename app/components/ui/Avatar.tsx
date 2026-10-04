"use client";

import { useImageBlob } from "../../hooks/useImageBlob";
import { agentMeta, inkOn } from "../../lib/agents";
import { assetUrl } from "../../lib/api";
import type { Capability, Plugin } from "../../lib/types";
import { useData } from "../providers/DataProvider";

type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

/** A letter tile underneath; the real image covers it once the blob has loaded. */
function ImageWithFallback({
  src,
  fallback,
  className,
  style,
  label,
}: {
  src: string | null;
  fallback: string;
  className: string;
  style?: React.CSSProperties;
  label?: string;
}) {
  const image = useImageBlob(src);
  const ready = image.status === "ready";
  return (
    <span
      className={`${className} ${ready ? "has-image" : ""}`}
      style={ready ? undefined : style}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <span className="av-letter">{fallback}</span>
      {ready ? (
        // Blob URL from the loopback service; next/image cannot optimize it.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image.url} alt="" draggable={false} />
      ) : null}
    </span>
  );
}

export function AgentAvatar({ id, size, label }: { id: string; size?: AvatarSize; label?: boolean }) {
  const { agentsById } = useData();
  const agent = agentsById.get(id);
  const meta = agentMeta(id, agent);
  // Older services do not report iconAvailable; then try the icon route anyway.
  const hasIcon = agent?.iconAvailable !== false;
  return (
    <ImageWithFallback
      src={hasIcon ? assetUrl.agentIcon(id) : null}
      fallback={meta.letter}
      className={`av ${size || ""}`}
      style={{ background: meta.color, color: inkOn(meta.color) }}
      label={label ? meta.name : undefined}
    />
  );
}

export function PluginLogo({ plugin, size }: { plugin: Plugin; size?: "lg" }) {
  const color = plugin.brandColor || "#6e6f75";
  const logo = plugin.logo || plugin.composerIcon;
  return (
    <ImageWithFallback
      src={logo ? assetUrl.plugin(logo) : null}
      fallback={(plugin.displayName || plugin.name || "?").trim()[0]?.toUpperCase() || "?"}
      className={`plogo ${size || ""}`}
      style={{ background: color, color: inkOn(color) }}
    />
  );
}

export function ExpertAvatar({ capability, size }: { capability: Capability; size?: "sm" | "lg" }) {
  const fallbackColor = capability.productColor || "#2d67d2";
  const { agentsById } = useData();
  const productIcon = agentsById.get(capability.productId)?.iconAvailable !== false;
  const src = capability.avatar
    ? assetUrl.expertAvatar(capability.avatar)
    : ["hermes", "qclaw", "openclaw"].includes(capability.productId) && productIcon
      ? assetUrl.agentIcon(capability.productId)
      : null;
  return (
    <ImageWithFallback
      src={src}
      fallback={capability.emoji || (capability.displayName || capability.name || "?").trim()[0] || "?"}
      className={`plogo round ${size || ""}`}
      style={{ background: fallbackColor, color: inkOn(fallbackColor) }}
    />
  );
}

export function LetterLogo({ text, tone = "info", round }: { text: string; tone?: "info" | "mute"; round?: boolean }) {
  return (
    <span className={`plogo ${round ? "round" : ""} letter-${tone}`} aria-hidden="true">
      <span className="av-letter">{(text || "?").trim()[0]?.toUpperCase() || "?"}</span>
    </span>
  );
}
