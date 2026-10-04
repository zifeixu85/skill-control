/**
 * Line tokenizer for read-only config previews. Produces plain tokens that React renders
 * as text spans, so file content never reaches the DOM as HTML.
 */

export type TokenKind = "key" | "string" | "comment" | "heading" | "mask" | "plain";

export interface Token {
  kind: TokenKind;
  text: string;
}

export type CodeLanguage = "json" | "toml" | "yaml" | "md" | "text";

export const MASK = "••••••";

export function normalizeLanguage(language: string | null | undefined, path = ""): CodeLanguage {
  const value = String(language || "").toLowerCase();
  if (["json", "jsonc", "json5"].includes(value) || /\.json5?$/i.test(path)) return "json";
  if (value === "toml" || /\.toml$/i.test(path)) return "toml";
  if (["yaml", "yml"].includes(value) || /\.ya?ml$/i.test(path)) return "yaml";
  if (["md", "markdown"].includes(value) || /\.(md|markdown)$/i.test(path)) return "md";
  return "text";
}

export const LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  json: "JSON",
  toml: "TOML",
  yaml: "YAML",
  md: "Markdown",
  text: "文本",
};

/** Splits masked values ("••••••") out of a run of text. */
function withMasks(text: string, kind: TokenKind): Token[] {
  if (!text) return [];
  const tokens: Token[] = [];
  const parts = text.split(MASK);
  parts.forEach((part, index) => {
    if (part) tokens.push({ kind, text: part });
    if (index < parts.length - 1) tokens.push({ kind: "mask", text: MASK });
  });
  return tokens;
}

/** Quoted strings become string tokens; everything else stays plain. */
function valueTokens(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    tokens.push(...withMasks(text.slice(last, match.index), "plain"));
    tokens.push(...withMasks(match[0], "string"));
    last = match.index + match[0].length;
  }
  tokens.push(...withMasks(text.slice(last), "plain"));
  return tokens;
}

function jsonLine(line: string): Token[] {
  const match = line.match(/^(\s*)("(?:[^"\\]|\\.)*")(\s*:\s*)(.*)$/);
  if (!match) return valueTokens(line);
  return [
    ...withMasks(match[1], "plain"),
    { kind: "key", text: match[2] },
    { kind: "plain", text: match[3] },
    ...valueTokens(match[4]),
  ];
}

function tomlLine(line: string): Token[] {
  if (/^\s*\[.*\]\s*$/.test(line)) return [{ kind: "heading", text: line }];
  if (/^\s*#/.test(line)) return [{ kind: "comment", text: line }];
  const match = line.match(/^(\s*[^=\s][^=]*?)(\s*=\s*)(.*)$/);
  if (!match) return valueTokens(line);
  return [{ kind: "key", text: match[1] }, { kind: "plain", text: match[2] }, ...valueTokens(match[3])];
}

function yamlLine(line: string): Token[] {
  if (/^\s*#/.test(line)) return [{ kind: "comment", text: line }];
  if (/^---\s*$|^\.\.\.\s*$/.test(line)) return [{ kind: "comment", text: line }];
  const match = line.match(/^(\s*(?:-\s+)?)([^\s:#][^:#]*?)(:)(\s.*|$)/);
  if (!match) return valueTokens(line);
  return [
    ...withMasks(match[1], "plain"),
    { kind: "key", text: match[2] },
    { kind: "plain", text: match[3] },
    ...valueTokens(match[4]),
  ];
}

export function tokenize(text: string, language: CodeLanguage): Token[][] {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let inFrontmatter = false;
  return lines.map((line, index) => {
    if (language === "json") return jsonLine(line);
    if (language === "toml") return tomlLine(line);
    if (language === "yaml") return yamlLine(line);
    if (language === "md") {
      if (line.trim() === "---") {
        if (index === 0) inFrontmatter = true;
        else if (inFrontmatter) inFrontmatter = false;
        return [{ kind: "comment", text: line }];
      }
      if (inFrontmatter) return yamlLine(line);
      if (/^#{1,6}\s/.test(line)) return [{ kind: "heading", text: line }];
      return withMasks(line, "plain");
    }
    return withMasks(line, "plain");
  });
}

export function containsMask(text: string | null | undefined): boolean {
  return String(text || "").includes(MASK);
}
