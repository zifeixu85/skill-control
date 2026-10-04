import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Network access for update checks. Every request is counted against a budget, limited in
 * time and size, and only goes to known hosts; `git ls-remote` runs with an argument array
 * (no shell), no credential helper and no prompts. A GitHub token, when the user enabled
 * it, is attached to api.github.com requests only and never stored or logged.
 */

export const UPDATE_HOSTS = [
  "api.github.com",
  "github.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "open.feishu.cn",
  "clawhub.ai",
  "api.skillhub.cn",
  "download.codebuddy.cn",
];

export const updatesOffline = (env = process.env) => env.SKILL_MANAGER_UPDATES_OFFLINE === "1";

/**
 * The git used for `ls-remote`. Normally /usr/bin/git. When commands are pinned
 * (SKILL_MANAGER_COMMAND_DIRS, used by tests and sandboxes) only SKILL_MANAGER_GIT_PATH inside
 * those folders is accepted; otherwise there is no git and ls-remote reports unavailable.
 */
export function resolveGitPath(env = process.env) {
  const pinned = String(env.SKILL_MANAGER_COMMAND_DIRS || "")
    .split(path.delimiter)
    .filter((entry) => entry && path.isAbsolute(entry));
  if (!pinned.length) return "/usr/bin/git";
  const configured = env.SKILL_MANAGER_GIT_PATH;
  const inside = (directory, file) => {
    const relative = path.relative(directory, file);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  return configured && path.isAbsolute(configured) && pinned.some((directory) => inside(directory, path.resolve(configured))) ? path.resolve(configured) : null;
}

export class TransportError extends Error {
  constructor(kind, message, details = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, details);
  }
}

const run = promisify(execFile);
const GIT_URL = /^https:\/\/[\w.-]{1,253}(?::\d{1,5})?\/[\w.~/-]{1,300}$/u;
const GIT_REF = /^(?:HEAD|refs\/(?:heads|tags)\/[\w./-]{1,200})$/u;

async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) return Buffer.from(await response.arrayBuffer()).subarray(0, maxBytes);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TransportError("too-large", "响应超过大小上限。");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * `fetchImpl(url, init)` and `lsRemoteImpl(url, ref)` are injectable; tests never touch
 * the network.
 */
export function createTransport({
  fetchImpl = globalThis.fetch,
  lsRemoteImpl = null,
  gitPath = resolveGitPath(),
  // Offline: no request and no subprocess is attempted, injected or not.
  offline = updatesOffline(),
  timeoutMs = 12_000,
  maxBytes = 8 * 1024 * 1024,
  maxRequests = 60,
  githubToken = null,
  rateLimit = {},
  now = () => Date.now(),
} = {}) {
  let requests = 0;
  const hosts = new Set();
  const github = { remaining: rateLimit.remaining ?? null, resetAt: rateLimit.resetAt ?? null };

  const refuseOffline = () => {
    if (offline) throw new TransportError("offline", "离线模式，未联网。");
  };

  const spend = (host) => {
    if (requests >= maxRequests) throw new TransportError("budget", "本次检查的请求数已用完，其余来源下次再查。");
    requests += 1;
    hosts.add(host);
  };

  async function request(url, { method = "GET", headers = {}, accept = "application/json" } = {}) {
    refuseOffline();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new TransportError("invalid", "地址无效。");
    }
    if (parsed.protocol !== "https:" || !UPDATE_HOSTS.includes(parsed.hostname)) {
      throw new TransportError("invalid", "不在允许访问的主机列表中。");
    }
    const isGitHubApi = parsed.hostname === "api.github.com";
    if (isGitHubApi && github.remaining === 0 && github.resetAt && now() < github.resetAt) {
      throw new TransportError("rate-limited", "GitHub 接口额度已用完。", { resetAt: github.resetAt });
    }
    spend(parsed.hostname);
    const requestHeaders = { accept, "user-agent": "skill-control-update-check", ...headers };
    if (isGitHubApi && githubToken) requestHeaders.authorization = `Bearer ${githubToken}`;
    let response;
    try {
      response = await fetchImpl(parsed.toString(), { method, headers: requestHeaders, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new TransportError(error?.name === "TimeoutError" ? "timeout" : "offline", error?.name === "TimeoutError" ? "请求超时。" : "网络不可用。");
    }
    if (isGitHubApi) {
      const remaining = Number(response.headers.get("x-ratelimit-remaining"));
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      if (Number.isFinite(remaining)) github.remaining = remaining;
      if (Number.isFinite(reset) && reset > 0) github.resetAt = reset * 1000;
      if ([403, 429].includes(response.status) && (github.remaining === 0 || response.headers.get("retry-after"))) {
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) github.resetAt = now() + retryAfter * 1000;
        github.remaining = 0;
        throw new TransportError("rate-limited", "GitHub 接口额度已用完。", { resetAt: github.resetAt });
      }
    }
    return response;
  }

  return {
    async getJson(url, options = {}) {
      const response = await request(url, options);
      if (response.status === 404) throw new TransportError("not-found", "远端不存在这个条目。", { status: 404 });
      const body = await readCapped(response, maxBytes);
      let json = null;
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        json = null;
      }
      if (!response.ok && !json) throw new TransportError("http", `远端返回 ${response.status}。`, { status: response.status });
      return { status: response.status, json, etag: response.headers.get("etag") };
    },
    async getBuffer(url, options = {}) {
      const response = await request(url, { ...options, accept: "*/*" });
      if (!response.ok) throw new TransportError("http", `远端返回 ${response.status}。`, { status: response.status });
      return readCapped(response, maxBytes);
    },
    async head(url, { headers = {} } = {}) {
      const response = await request(url, { method: "HEAD", headers, accept: "*/*" });
      return { status: response.status, etag: response.headers.get("etag") };
    },
    async lsRemote(url, ref = "HEAD") {
      refuseOffline();
      if (!GIT_URL.test(url) || !GIT_REF.test(ref)) throw new TransportError("invalid", "仓库地址无效。");
      if (!lsRemoteImpl && !gitPath) throw new TransportError("unavailable", "当前环境没有可用的 git。");
      spend(new URL(url).hostname);
      if (lsRemoteImpl) return lsRemoteImpl(url, ref);
      try {
        const { stdout } = await run(gitPath, ["-c", "credential.helper=", "ls-remote", url, ref], {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
        });
        const sha = stdout.split("\n").map((line) => line.split("\t")).find((parts) => parts[1] === ref || (ref === "HEAD" && parts[1] === "HEAD"))?.[0];
        if (!/^[a-f0-9]{40}$/u.test(String(sha || ""))) throw new TransportError("not-found", "远端没有这个分支。");
        return sha;
      } catch (error) {
        if (error instanceof TransportError) throw error;
        throw new TransportError(error?.killed ? "timeout" : "offline", error?.killed ? "git ls-remote 超时。" : "无法连接仓库。");
      }
    },
    stats: () => ({ requests, hosts: [...hosts].sort(), github: { ...github } }),
  };
}
