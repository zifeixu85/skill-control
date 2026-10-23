/** Explanations of derived usage figures, served with the price table (GET /api/usage/pricing → rules). */

export const CACHE_RATE_RULE = {
  text:
    "缓存率 = 缓存读取 ÷（未缓存输入 + 缓存读取 + 缓存写入），即输入 token 里有多少直接从提示缓存读取；缓存写入占比 = 缓存写入 ÷ 同一分母。输出 token 不计入。" +
    "按会话统计时，每个会话先算自己的缓存率，再给出中位数、P10、P90 和低于 50% 的会话数。由数据库总数估算的 Codex 会话（拆分是按比例推算的）和不记录缓存 token 的来源不参与。",
  formula: "cacheRead / (input + cacheRead + cacheWrite)",
  url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance",
  links: [
    { label: "Anthropic：Tracking cache performance", url: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance" },
    { label: "OpenAI：Prompt caching", url: "https://developers.openai.com/api/docs/guides/prompt-caching" },
  ],
};
