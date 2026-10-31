/**
 * Proxy environment variables → an Electron session proxy config. Without them the default
 * session follows the system proxy settings, which is what most users want; terminal
 * launches and Linux desktops often only set HTTPS_PROXY / HTTP_PROXY / ALL_PROXY.
 */

const PROXY_SCHEMES = new Set(["http:", "https:", "socks:", "socks4:", "socks5:"]);
const DEFAULT_PORTS = { "http:": "80", "https:": "443", "socks:": "1080", "socks4:": "1080", "socks5:": "1080" };

const readEnv = (env, name) => {
  const value = env[name.toLowerCase()] || env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

/** "http://user:secret@127.0.0.1:7890/" → "http://127.0.0.1:7890" (credentials are dropped). */
export function proxyServerUri(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `http://${value}`);
  } catch {
    return null;
  }
  if (!PROXY_SCHEMES.has(url.protocol) || !url.hostname) return null;
  const port = url.port || DEFAULT_PORTS[url.protocol];
  return `${url.protocol}//${url.hostname}:${port}`;
}

/** NO_PROXY entries as Chromium bypass rules; null when "*" turns the proxy off. */
function bypassRules(value) {
  const entries = String(value || "")
    .split(/[,\s]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.includes("*")) return null;
  // Loopback stays direct (Chromium also bypasses it implicitly): the window talks to 127.0.0.1.
  return [...new Set(["localhost", "127.0.0.1", "[::1]", ...entries])].join(",");
}

/**
 * { mode: "fixed_servers", proxyRules, proxyBypassRules } from HTTPS_PROXY / HTTP_PROXY /
 * ALL_PROXY / NO_PROXY (either case; lower case wins, as in curl); null to keep the system
 * settings. `hasCredentials` reports proxy URLs whose user name and password were dropped.
 */
export function proxyConfigFromEnv(env = {}) {
  const httpsRaw = readEnv(env, "HTTPS_PROXY");
  const httpRaw = readEnv(env, "HTTP_PROXY");
  const allRaw = readEnv(env, "ALL_PROXY");
  const https = proxyServerUri(httpsRaw);
  const http = proxyServerUri(httpRaw);
  const all = proxyServerUri(allRaw);
  if (!https && !http && !all) return null;
  const bypass = bypassRules(readEnv(env, "NO_PROXY"));
  if (bypass === null) return null;
  const rules = [];
  if (https || all) rules.push(`https=${https || all}`);
  if (http || all) rules.push(`http=${http || all}`);
  const hasCredentials = [httpsRaw, httpRaw, allRaw].some((raw) => {
    try {
      const url = new URL(raw);
      return Boolean(url.username || url.password);
    } catch {
      return false;
    }
  });
  return { mode: "fixed_servers", proxyRules: rules.join(";"), proxyBypassRules: bypass, hasCredentials };
}
