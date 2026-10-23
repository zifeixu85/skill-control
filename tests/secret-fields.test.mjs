import assert from "node:assert/strict";
import test from "node:test";
import {
  isEnvReference,
  looksSecret,
  secretFieldNames,
  secretFieldReport,
} from "../server/secret-fields.mjs";

const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl";
const sorted = (config) => secretFieldNames(config).sort();

test("treats only whole-value environment references as non-literal", () => {
  for (const value of ["${API_KEY}", "$API_KEY", "{env:API_KEY}", "${env:API_KEY}", "Bearer ${TOKEN}", "${A}${B}"]) {
    assert.equal(isEnvReference(value), true, value);
  }
  for (const value of ["${A}literal", "prefix-${A}", "$ecretPass", "plain", "Bearer abc", ""]) {
    assert.equal(isEnvReference(value), false, value);
  }
});

test("flags every literal header and env value regardless of the key name", () => {
  assert.deepEqual(
    sorted({
      headers: { "X-Custom": "abc123", Accept: "application/json", Ref: "${TOKEN}" },
      http_headers: { Trace: "trace-1" },
      env: { PLAIN: "plain-value", REF: "$HOME_DIR", NESTED: { INNER: "x" } },
      env_http_headers: { Authorization: "GITHUB_TOKEN" },
      bearer_token_env_var: "GITHUB_TOKEN",
    }),
    ["env.NESTED.INNER", "env.PLAIN", "headers.Accept", "headers.X-Custom", "http_headers.Trace"],
  );
});

test("flags secret-named keys case-insensitively, including nested objects", () => {
  assert.deepEqual(
    sorted({
      access_token: "literal-a",
      client_secret: "literal-b",
      clientSecret: "literal-c",
      Authorization: "literal-d",
      apiKey: "${API_KEY}",
      oauth: { clientSecret: "literal-e", client_id: "public-id" },
      oauth_resource: "https://resource.example.test",
      keywords: "not-a-key",
    }),
    ["Authorization", "access_token", "clientSecret", "client_secret", "oauth.clientSecret"],
  );
});

test("recognizes credential value shapes under innocuous names", () => {
  for (const value of [
    "Bearer abc.def",
    "ghp_0123456789abcdefABCDEF",
    "github_pat_11ABCDEFG0123456789_abcdef",
    "sk-proj-0123456789abcdef",
    "xoxb-123456789012-abcdef",
    JWT,
    "Zq8vT2mN4pL7xR1cK9wB3yH6dF0sJ5gA",
  ]) {
    assert.equal(looksSecret(value), true, value);
    assert.deepEqual(secretFieldNames({ note: value }), ["note"], value);
  }
  for (const value of [
    "/Users/example/.local/bin/server-binary-name",
    "node_modules/.bin/some-long-tool-name",
    "123e4567-e89b-12d3-a456-426614174000",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "streamable-http-transport-mode",
    "${SECRET_FROM_ENV}",
  ]) {
    assert.equal(looksSecret(value), false, value);
  }
});

test("finds credentials in arguments, URLs, userinfo and token-like paths", () => {
  assert.deepEqual(
    sorted({
      command: "npx",
      args: [
        "-y",
        "--api-key=literal",
        "--token",
        "literal-next",
        "--verbose",
        "API_KEY=abc",
        "MODE=fast",
        "-e",
        "ANY_NAME=literal",
        "-H",
        "Authorization: Bearer x",
        "X-Api-Key: abc",
        "localhost:8080",
        "https://user:pass@host.example.test/x",
        "https://host.example.test/x?token=abc",
        "https://host.example.test/x?page=2",
        "--key=${API_KEY}",
        "ghp_0123456789abcdefABCDEF",
      ],
    }),
    [
      "args[10]",
      "args[11]",
      "args[13]",
      "args[14]",
      "args[17]",
      "args[1]",
      "args[3]",
      "args[5]",
      "args[8]",
    ],
  );
  assert.deepEqual(
    sorted({
      url: "https://user@hooks.example.test/services/T00000000/B00000000/Zq8vT2mN4pL7xR1cK9wB3yH6?sig=Zq8vT2mN4pL7xR1cK9wB3yH6dF0s&page=1",
    }),
    ["url.path", "url.query.sig", "url.userinfo"],
  );
  assert.deepEqual(secretFieldNames({ url: "https://plain.example.test/mcp/v1" }), []);
});

test("bounds work on pathological configuration values", () => {
  const started = performance.now();
  secretFieldNames({
    args: [`--${"key".repeat(100_000)}!`, `${"a".repeat(200_000)}=x`, `${"A-".repeat(100_000)}: v`],
    env: Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`K${index}`, "v"])),
    headers: { deep: { deeper: { deepest: { tooDeep: { value: "x" } } } } },
    note: `eyJ${"a".repeat(300_000)}`,
    url: `https://example.test/?${"a=b&".repeat(50_000)}`,
  });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `took ${elapsed.toFixed(1)} ms`);
});

test("separates likely credentials from other literal header and env values", () => {
  const report = secretFieldReport({
    env: { API_TOKEN: "literal", NODE_PATH: "/opt/node", RAW: "ghp_0123456789abcdefABCDEF" },
    headers: { "secret-key": "literal", Accept: "application/json" },
    url: "https://u:p@host.example.test/",
  });
  assert.deepEqual(report.all.sort(), [
    "env.API_TOKEN",
    "env.NODE_PATH",
    "env.RAW",
    "headers.Accept",
    "headers.secret-key",
    "url.userinfo",
  ]);
  assert.deepEqual(report.likely.sort(), ["env.API_TOKEN", "env.RAW", "headers.secret-key", "url.userinfo"]);
});
