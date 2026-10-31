import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildMenuTemplate, HELP_LINKS } from "../desktop/app-menu.mjs";
import { proxyConfigFromEnv, proxyServerUri } from "../desktop/network-proxy.mjs";
import { createInsightRoutes } from "../server/insight-routes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function menu(platform, overrides = {}) {
  const calls = { settings: 0, opened: [] };
  const template = buildMenuTemplate({
    platform,
    appName: "Skill Control",
    developmentMode: false,
    openSettings: () => (calls.settings += 1),
    openExternal: (url) => calls.opened.push(url),
    ...overrides,
  });
  const items = template.flatMap((group) => (group.submenu || []).map((item) => ({ ...item, group: group.label })));
  return { template, items, calls };
}

test("menu: zoom, close window, 设置… (⌘,) and 帮助 on macOS", () => {
  const { template, items, calls } = menu("darwin");
  const roles = items.map((item) => item.role).filter(Boolean);
  for (const role of ["resetZoom", "zoomIn", "zoomOut", "close", "togglefullscreen", "quit"]) assert.ok(roles.includes(role), role);
  assert.ok(items.some((item) => item.role === "zoomIn" && item.accelerator === "CommandOrControl+=" && item.visible === false), "⌘= zooms in too");
  const close = items.find((item) => item.role === "close");
  assert.equal(close.group, "窗口", "⌘W closes the window on macOS as well");
  const settings = items.find((item) => item.label === "设置…");
  assert.equal(settings.accelerator, "CommandOrControl+,");
  assert.equal(settings.group, "Skill Control");
  settings.click();
  assert.equal(calls.settings, 1);
  const help = template.find((group) => group.label === "帮助");
  assert.equal(help.role, "help");
  help.submenu.forEach((item) => item.click());
  assert.deepEqual(calls.opened, [HELP_LINKS.guide, HELP_LINKS.issues]);
  assert.deepEqual(help.submenu.map((item) => item.label), ["使用说明", "反馈问题"]);
  assert.equal(roles.includes("toggleDevTools"), false, "no developer tools in packaged builds");
  assert.ok(menu("darwin", { developmentMode: true }).items.some((item) => item.role === "toggleDevTools"));
});

test("menu: Windows and Linux put 设置… under 文件 and keep the same shortcuts", () => {
  const { template, items } = menu("win32");
  assert.equal(template[0].label, "文件");
  assert.equal(items.find((item) => item.label === "设置…").group, "文件");
  assert.ok(items.some((item) => item.role === "close"));
  assert.ok(items.some((item) => item.role === "zoomOut"));
  assert.equal(template.some((group) => group.label === "Skill Control"), false);
});

test("proxy environment variables become a Chromium proxy config; otherwise the system proxy applies", () => {
  assert.equal(proxyConfigFromEnv({}), null);
  assert.deepEqual(proxyConfigFromEnv({ HTTPS_PROXY: "http://127.0.0.1:7890" }), {
    mode: "fixed_servers",
    proxyRules: "https=http://127.0.0.1:7890",
    proxyBypassRules: "localhost,127.0.0.1,[::1]",
    hasCredentials: false,
  });
  const both = proxyConfigFromEnv({ https_proxy: "http://proxy.lan:8080", HTTPS_PROXY: "http://ignored:1", http_proxy: "proxy.lan:3128", NO_PROXY: ".corp.example, 10.0.0.0/8" });
  assert.equal(both.proxyRules, "https=http://proxy.lan:8080;http=http://proxy.lan:3128", "lower case wins, as in curl");
  assert.equal(both.proxyBypassRules, "localhost,127.0.0.1,[::1],.corp.example,10.0.0.0/8");
  assert.equal(proxyConfigFromEnv({ ALL_PROXY: "socks5://127.0.0.1:1080" }).proxyRules, "https=socks5://127.0.0.1:1080;http=socks5://127.0.0.1:1080");
  assert.equal(proxyConfigFromEnv({ HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "*" }), null, "NO_PROXY=* turns the proxy off");
  const secret = proxyConfigFromEnv({ HTTPS_PROXY: "http://user:pass@127.0.0.1:7890" });
  assert.equal(secret.proxyRules, "https=http://127.0.0.1:7890");
  assert.equal(secret.hasCredentials, true);
  assert.equal(proxyServerUri("ftp://x:1"), null);
  assert.equal(proxyServerUri("not a url"), null);
  assert.equal(proxyServerUri("https://proxy.example"), "https://proxy.example:443");
});

test("the startup page is static: no scripts, no network, and says the services are starting", async () => {
  const html = await readFile(path.join(ROOT, "desktop", "startup.html"), "utf8");
  assert.match(html, /正在启动本地服务…/u);
  assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/u);
  assert.doesNotMatch(html, /<script|src=|href=|url\(/iu);
  assert.match(html, /prefers-color-scheme: dark/u);
  assert.match(html, /prefers-reduced-motion/u);
});

test("the desktop fetch reaches the server's version checks (one injection point)", { skip: process.platform === "win32" }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "sc-fetch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const node = path.join(home, ".nvm", "versions", "node", "v24.0.0");
  const codex = path.join(node, "lib", "node_modules", "@openai", "codex");
  await mkdir(path.join(codex, "bin"), { recursive: true });
  await writeFile(path.join(codex, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.150.0" }));
  await writeFile(path.join(codex, "bin", "codex.js"), "#!/usr/bin/env node\n");
  await mkdir(path.join(node, "bin"), { recursive: true });
  await writeFile(path.join(node, "bin", "npm"), "#!/bin/sh\n");
  await symlink(path.join(codex, "bin", "codex.js"), path.join(node, "bin", "codex"));
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return new Response(JSON.stringify({ name: "@openai/codex", version: "0.160.0" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const context = (extra) => ({
    homeDirectory: home,
    homes: [home],
    stateDirectory: path.join(home, ".agent-skill-manager"),
    backupDirectory: path.join(home, ".agent-skill-manager", "backups"),
    historyFile: path.join(home, ".agent-skill-manager", "history.jsonl"),
    applicationDirectories: [path.join(home, "Applications")],
    commandDirectories: [{ directory: path.join(node, "bin") }],
    getScan: async () => ({ skills: [], agents: [] }),
    getIntegrations: async () => ({ payload: { plugins: [] } }),
    getConfig: async () => ({}),
    getAgents: async () => [],
    ...extra,
  });
  await createInsightRoutes(context({ fetchImpl, updatesOffline: false })).versions.check();
  assert.ok(requested.some((url) => url.startsWith("https://registry.npmjs.org/")), requested.join(", "));

  requested.length = 0;
  await createInsightRoutes(context({ fetchImpl, updatesOffline: true })).versions.check();
  assert.deepEqual(requested, [], "offline mode still wins over the injected fetch");
});
