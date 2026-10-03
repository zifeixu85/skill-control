/**
 * Body-derived display metadata for SKILL.md files.
 *
 * Only structural Markdown outside fenced code blocks is considered, so shell comments
 * such as `# BAD — ...` inside ``` blocks can never become a skill's display name.
 * Every regex here runs on clamped input with bounded quantifiers: SKILL.md files come
 * from untrusted packages and are parsed on the scan worker and during `.skill` import.
 */

const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;
const HEADING_PREFIX = /^ {0,3}(#{1,6})(?=[ \t]|$)/u;
const STRUCTURAL_LINE =
  /^[ \t]{0,16}(?:[-*+][ \t]|\d{1,9}[.)][ \t]|\||>|<!--|<\/?[a-z]|[-*_]{3,}[ \t]*$|!\[)/iu;
export const DISPLAY_HEADING_LIMIT = 40;
export const DESCRIPTION_PARAGRAPH_LIMIT = 200;
const RAW_HEADING_LIMIT = 400;
const RAW_PARAGRAPH_LIMIT = 1_000;
const CLEAN_INPUT_LIMIT = 1_000;
const LINE_LIMIT = 4_000;

export function containsChinese(value = "") {
  return /[㐀-鿿]/u.test(value);
}

function chineseCount(value = "") {
  return (value.match(/[㐀-鿿]/gu) || []).length;
}

export function cleanInlineMarkdown(value = "") {
  return String(value)
    .slice(0, CLEAN_INPUT_LIMIT)
    .replace(/!\[[^\]\n]{0,200}\]\([^)\n]{0,300}\)/gu, "")
    .replace(/\[([^\]\n]{1,200})\]\([^)\n]{0,300}\)/gu, "$1")
    .replace(/`([^`\n]{0,300})`/gu, "$1")
    .replace(/(\*\*|__)([^\n]{1,300}?)\1/gu, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_\n]{0,300}?)[*_](?=[^\w*]|$)/gu, "$1$2")
    .replace(/<[^<>\n]{1,100}>/gu, "")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Yields Markdown lines that are outside fenced code blocks, with blank lines preserved. */
function* proseLines(body) {
  let fence = null;
  for (const rawLine of String(body).replace(/\r\n/gu, "\n").split("\n")) {
    const line = rawLine.length > LINE_LIMIT ? rawLine.slice(0, LINE_LIMIT) : rawLine;
    const fenceMatch = line.match(FENCE);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      continue;
    }
    yield line;
  }
}

/** Heading level and text, or null. A closing `#` run is stripped only after whitespace. */
export function parseHeading(line) {
  const match = line.match(HEADING_PREFIX);
  if (!match) return null;
  let content = line.slice(match[0].length).trim();
  const closing = content.match(/(?:^|[ \t])#+$/u);
  if (closing) content = content.slice(0, closing.index).trimEnd();
  return { level: match[1].length, text: content };
}

/**
 * The first H1, only when it appears before any deeper heading and is short enough
 * to work as a name. Returns "" otherwise.
 */
export function firstHeadingTitle(body = "", limit = DISPLAY_HEADING_LIMIT) {
  for (const line of proseLines(body)) {
    const heading = parseHeading(line);
    if (!heading) continue;
    if (heading.level !== 1 || heading.text.length > RAW_HEADING_LIMIT) return "";
    const title = cleanInlineMarkdown(heading.text);
    return title && title.length <= limit ? title : "";
  }
  return "";
}

/** The first plain paragraph (no headings, lists, tables, quotes, HTML or code), clamped. */
export function firstParagraph(body = "") {
  const current = [];
  let length = 0;
  for (const line of proseLines(body)) {
    if (!line.trim()) {
      if (current.length) break;
      continue;
    }
    if (parseHeading(line) || STRUCTURAL_LINE.test(line)) {
      if (current.length) break;
      continue;
    }
    current.push(line.trim());
    length += line.length;
    if (length > RAW_PARAGRAPH_LIMIT) return "";
  }
  return cleanInlineMarkdown(current.join(" "));
}

/** A Chinese introduction is only offered when the first paragraph itself is Chinese. */
export function chineseIntroduction(body = "", limit = DESCRIPTION_PARAGRAPH_LIMIT) {
  const paragraph = firstParagraph(body);
  return paragraph && paragraph.length <= limit && chineseCount(paragraph) >= 4
    ? paragraph
    : "";
}
