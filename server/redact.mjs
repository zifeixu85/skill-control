/**
 * Free-text redaction for anything shown verbatim (SKILL.md, agent prompts, SOUL.md,
 * descriptions, permission rules). It is a safety net, not a parser: structured
 * configuration goes through the default-deny masker in config-mask.mjs instead.
 *
 * Every pattern is linear: literal anchors, bounded quantifiers and no nested repeats,
 * so a hostile multi-megabyte input stays fast.
 */

export const MASK = "••••••";

const mixesLettersAndDigits = (value) => /[A-Za-z]/u.test(value) && /\d/u.test(value);
const secretShaped = (value) => mixesLettersAndDigits(value) || value.length >= 20;

const SECRET_NAME_CORE =
  "password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth(?!ors?\\b)|cookie|session";

const REDACTIONS = [
  // PEM private keys, including a truncated block without an END line.
  [
    /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]{0,8192}?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/gu,
    MASK,
  ],
  // Credentials in any scheme://user:pass@host (postgres, mongodb+srv, git+https, ssh …).
  [/\b([a-z][a-z0-9+.-]{1,31}:\/\/)[^\s/?#@"'<>]{1,256}@/giu, `$1${MASK}@`],
  // curl-style -u user:pass / --user=user:pass
  [/((?:^|[\s(])(?:-u|--user)(?:[ \t]{1,4}|=)["']?)([^\s:"']{1,128}):([^\s"')]{1,256})/gu, `$1$2:${MASK}`],
  // -H "Name: value" / --header 'Name: value'
  [
    /((?:^|[\s(])(?:-H|--header)(?:[ \t]{1,4}|=)["']?[A-Za-z][A-Za-z0-9-]{0,63}:[ \t]{0,4})([^"'\n)]{1,512})/gu,
    `$1${MASK}`,
  ],
  // Secret-named assignments: API_KEY=…, "password": "…", X-Api-Key: …, Authorization: Bearer …
  [
    new RegExp(
      `\\b([A-Za-z0-9_.-]{0,63}(?:${SECRET_NAME_CORE})[A-Za-z0-9_.-]{0,16})(["']?[ \\t]{0,4}[:=][ \\t]{0,4}["']?)((?:bearer|basic|token)[ \\t]{1,4})?([^\\s"',;&)]{3,256})`,
      "giu",
    ),
    (match, name, separator, scheme = "") => `${name}${separator}${scheme}${MASK}`,
  ],
  // Natural language: "the key is X", "secret X", "token: X" when X looks like a credential.
  [
    /\b((?:api[ _-]?)?(?:key|token|secret|password|passwd|passphrase|credentials?)s?)([ \t]{1,4}(?:is|are|was|=|:)?[ \t]{0,4})([A-Za-z0-9_\-+/=.]{6,256})/giu,
    (match, word, gap, value) => (secretShaped(value) ? `${word}${gap}${MASK}` : match),
  ],
  [
    /(密钥|秘钥|令牌|密码|口令|凭证|凭据)([ \t]{0,4}(?:是|为|:|：)?[ \t]{0,4})([A-Za-z0-9_\-+/=.]{6,256})/gu,
    (match, word, gap, value) => (secretShaped(value) ? `${word}${gap}${MASK}` : match),
  ],
  // Authorization schemes only when followed by a token-shaped value.
  [/\b(Bearer|Basic)([ \t]{1,4})[A-Za-z0-9._~+/=-]{16,4096}/giu, `$1$2${MASK}`],
  // Well-known credential formats.
  [/\bsk(?:-|_live_|_test_)[A-Za-z0-9_-]{8,512}/gu, MASK],
  [/\brk_(?:live|test)_[A-Za-z0-9]{8,512}/gu, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{8,255}/gu, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{8,255}/gu, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,255}/gu, MASK],
  [/\bxapp-[A-Za-z0-9-]{8,255}/gu, MASK],
  [/\bglpat-[A-Za-z0-9_-]{16,255}/gu, MASK],
  [/\beyJ[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{5,4096}\.[A-Za-z0-9_-]{5,4096}/gu, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/gu, MASK],
  [/\bAIza[0-9A-Za-z_-]{35}/gu, MASK],
];

/** Redacts credential-shaped content inside free text. */
export function scrubTokens(value) {
  let result = String(value);
  for (const [pattern, replacement] of REDACTIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
