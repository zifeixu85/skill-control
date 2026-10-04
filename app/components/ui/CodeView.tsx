"use client";

import { useMemo } from "react";
import { containsMask, LANGUAGE_LABELS, normalizeLanguage, tokenize, type Token } from "../../lib/highlight";
import { KeyIcon } from "../icons";

const TOKEN_CLASS: Record<Token["kind"], string> = {
  key: "t-k",
  string: "t-s",
  comment: "t-c",
  heading: "t-h",
  mask: "t-m",
  plain: "",
};

const MAX_LINES = 4000;

/** Read-only highlighted text. Masked values render as an "已隐藏" badge, never as HTML. */
export function CodeView({
  text,
  language,
  path,
  truncated,
  wrap,
  label,
}: {
  text: string;
  language?: string | null;
  path?: string;
  truncated?: boolean;
  wrap?: boolean;
  label?: string;
}) {
  const lang = normalizeLanguage(language, path);
  const lines = useMemo(() => tokenize(text, lang), [text, lang]);
  const shown = lines.slice(0, MAX_LINES);
  return (
    <>
      <pre className={`code ${wrap ? "wrap" : ""}`} aria-label={label || `${LANGUAGE_LABELS[lang]} 内容`} tabIndex={0}>
        <code>
          {shown.map((line, lineIndex) => (
            <span className="ln" key={lineIndex}>
              {line.map((token, tokenIndex) =>
                token.kind === "mask" ? (
                  <span className="t-m" key={tokenIndex} title="值已隐藏">
                    已隐藏
                  </span>
                ) : token.kind === "plain" ? (
                  token.text
                ) : (
                  <span className={TOKEN_CLASS[token.kind]} key={tokenIndex}>
                    {token.text}
                  </span>
                ),
              )}
              {"\n"}
            </span>
          ))}
        </code>
      </pre>
      {truncated || lines.length > MAX_LINES ? (
        <p className="footnote">内容较长，只显示了前面一部分。</p>
      ) : null}
    </>
  );
}

export function MaskNote({ text, children }: { text?: string | null; children?: React.ReactNode }) {
  if (text !== undefined && !containsMask(text)) return null;
  return (
    <p className="safe-note">
      <KeyIcon />
      <span>{children || "密钥、令牌和请求头的值在读取时就被隐藏，界面不会显示，也不会保存。"}</span>
    </p>
  );
}

export function languageLabel(language: string | null | undefined, path?: string) {
  return LANGUAGE_LABELS[normalizeLanguage(language, path)];
}
