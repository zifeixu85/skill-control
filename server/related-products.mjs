import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { readAppBundle } from "./config-files.mjs";
import { compactHomePath, exists } from "./fs-safe.mjs";

/**
 * Related products that manage or orchestrate agents but are not agents themselves.
 * Only presence, bundle id, version and directory counts are read — never config
 * files (LumiClaw's config.json holds a token).
 */

const PRODUCTS = [
  {
    id: "lumiclaw",
    name: "LumiClaw",
    kind: "orchestrator",
    app: "/Applications/LumiClaw.app",
    bundleId: "com.lumiclaw.app",
    stateDir: ".lumiclaw",
    countDir: "agents",
    notes: (count) => `编排层，会写入 ~/.openclaw；约 ${count} 个 Agent 目录（只统计数量）。`,
  },
  {
    id: "moticlaw",
    name: "MotiClaw",
    kind: "manager",
    app: "/Applications/MotiClaw.app",
    bundleId: "cn.moticlaw.desktop",
    stateDir: ".moticlaw",
    notes: () => "OpenClaw 与 Hermes 的安装与管理工具。",
  },
  {
    id: "clawith",
    name: "Clawith",
    kind: "platform",
    app: null,
    bundleId: null,
    stateDir: ".clawith",
    countDir: path.join("data", "agents"),
    notes: (count) => `平台型产品，${count} 个 Agent 数据目录（只统计数量）。`,
  },
];

async function countDirectories(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

export async function detectRelatedProducts(homeDirectory = homedir()) {
  const realHome = homeDirectory === homedir();
  const found = [];
  for (const product of PRODUCTS) {
    const stateDir = path.join(homeDirectory, product.stateDir);
    const hasState = await exists(stateDir);
    // Presence is decided by the product's own folder; the app bundle only adds a version.
    if (!hasState) continue;
    const bundle = realHome && product.app && process.platform === "darwin" ? await readAppBundle(product.app) : null;
    const hasApp = Boolean(bundle && (!product.bundleId || bundle.bundleId === product.bundleId));
    const count = product.countDir && hasState ? await countDirectories(path.join(stateDir, product.countDir)) : 0;
    found.push({
      id: product.id,
      name: product.name,
      kind: product.kind,
      bundleId: hasApp ? bundle.bundleId : null,
      version: hasApp ? bundle.version : null,
      stateDir: hasState ? compactHomePath(stateDir, [homeDirectory]) : null,
      notes: product.notes(count),
    });
  }
  return found;
}
