import assert from "node:assert/strict";
import test from "node:test";
import { pickTargetInstance } from "../server/sync-targets.mjs";

const codex = { id: "codex", name: "Codex" };
const smartorder = { id: "smartorder", name: "订单来了" };

test("creates a user copy when Codex only has its bundled .system skill", () => {
  const instances = [
    { agentId: "codex", source: "codex-system", managed: true, readOnly: true },
  ];
  assert.equal(pickTargetInstance(instances, codex), null);
});

test("prefers the writable user copy over managed copies", () => {
  const user = { agentId: "codex", source: "local", managed: false };
  const instances = [
    { agentId: "codex", source: "codex-system", managed: true, readOnly: true },
    { agentId: "codex", source: "codex-vendor-import", managed: true },
    user,
  ];
  assert.equal(pickTargetInstance(instances, codex), user);
});

test("still refuses agents whose only copies are other read-only sources", () => {
  const instances = [{ agentId: "smartorder", source: "plugin", managed: true, readOnly: true }];
  assert.throws(() => pickTargetInstance(instances, smartorder), /管理器仅提供读取/u);
});
