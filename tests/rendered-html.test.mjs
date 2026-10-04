import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the Chinese Skill Control application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  // The desktop smoke test also expects "技能管理器" in the title and an .app-shell root.
  assert.match(html, /<title>Skill Control — 本地技能管理器<\/title>/i);
  assert.match(html, /class="app-shell"/);
  assert.match(html, /aria-label="主导航"/);
  for (const label of ["概览", "技能", "插件", "专家与 Agent", "连接器与 MCP", "数据", "体检", "设置"]) {
    assert.ok(html.includes(`<span>${label}</span>`), `navigation shows ${label}`);
  }
  assert.match(html, /正在读取本机的技能和 Agent/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});
