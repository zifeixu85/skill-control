import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { compactHomePath, object } from "./fs-safe.mjs";
import { LibraryError, runOps } from "./library-ops.mjs";

/**
 * One-click fixes for CLI tool cards (docs §3.2). Only two fixes write files — the stable
 * ~/.local/bin wrapper and allow rules — always through a plan, a confirmation, backups
 * and atomic writes. Gateway PATH, workspace binding and keychain changes involve
 * launchd or bot credentials and are instructions only.
 */

export const CLI_PLAN_TTL_MS = 10 * 60_000;
const timestamp = (now) => new Date(now).toISOString().replace(/[:.]/gu, "-");
const readText = (file) => readFile(file, "utf8").catch(() => null);

export const wrapperScript = (target) => `#!/bin/sh\nexec "${target}" "$@"\n`;

function jsonAllow(file, text, mutate, backup) {
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    return { error: "配置文件不是标准 JSON（可能含注释），未自动修改。" };
  }
  const added = mutate(value);
  if (!added) return { noop: true };
  return { op: { op: "write", path: file, content: `${JSON.stringify(value, null, 2)}\n`, backup, diff: `+ ${added}` } };
}

const push = (list, item) => (Array.isArray(list) ? (list.includes(item) ? null : [...list, item]) : [item]);

async function allowRuleOp(agentId, homeDirectory, command, backupRoot) {
  const backup = (name) => path.join(backupRoot, agentId, name);
  switch (agentId) {
    case "claude": {
      const file = path.join(homeDirectory, ".claude", "settings.json");
      return jsonAllow(file, await readText(file), (value) => {
        value.permissions = object(value.permissions);
        const next = push(value.permissions.allow, `Bash(${command} *)`);
        if (!next) return null;
        value.permissions.allow = next;
        return `permissions.allow: "Bash(${command} *)"`;
      }, backup("settings.json"));
    }
    case "codex": {
      const file = path.join(homeDirectory, ".codex", "rules", "default.rules");
      const text = (await readText(file)) || "";
      const line = `prefix_rule(pattern=["${command}"], decision="allow")`;
      return { op: { op: "write", path: file, content: `${text.replace(/\n*$/u, text ? "\n" : "")}${line}\n`, backup: backup("default.rules"), diff: `+ ${line}`, note: `放行后 ${command} 会在沙箱外运行。` } };
    }
    case "gemini": {
      const file = path.join(homeDirectory, ".gemini", "settings.json");
      return jsonAllow(file, await readText(file), (value) => {
        value.tools = object(value.tools);
        const next = push(value.tools.allowed, `run_shell_command(${command})`);
        if (!next) return null;
        value.tools.allowed = next;
        return `tools.allowed: "run_shell_command(${command})"`;
      }, backup("settings.json"));
    }
    case "cursor": {
      const file = path.join(homeDirectory, ".cursor", "cli-config.json");
      const text = await readText(file);
      if (text === null) return { error: "没有 ~/.cursor/cli-config.json，未自动创建。" };
      return jsonAllow(file, text, (value) => {
        value.permissions = object(value.permissions);
        const next = push(value.permissions.allow, `Shell(${command})`);
        if (!next) return null;
        value.permissions.allow = next;
        return `permissions.allow: "Shell(${command})"`;
      }, backup("cli-config.json"));
    }
    case "opencode": {
      const file = path.join(homeDirectory, ".config", "opencode", "opencode.json");
      const text = await readText(file);
      if (text === null) return { error: "没有 opencode.json，未自动创建。" };
      return jsonAllow(file, text, (value) => {
        value.permission = object(value.permission);
        if (value.permission.bash === "allow") return null;
        value.permission.bash = object(value.permission.bash);
        if (value.permission.bash[`${command} *`] === "allow") return null;
        value.permission.bash[`${command} *`] = "allow";
        return `permission.bash["${command} *"]: "allow"`;
      }, backup("opencode.json"));
    }
    case "hermes":
      return { error: "Hermes 的普通命令一般无需放行；如需放行，请在 command_allowlist 中添加。" };
    default:
      return { error: "这个 Agent 没有可自动写入的放行规则。" };
  }
}

/** Available fixes for one detected tool, with instructions for the manual ones. */
export function fixesFor(tool, { homes }) {
  if (tool.id !== "lark-cli") return [];
  const display = (value) => compactHomePath(value, tool.internal.displayHomes || homes);
  const fixes = [];
  const native = tool.internal.nativeBinary;
  fixes.push({
    id: "wrapper",
    label: "在 ~/.local/bin 生成稳定启动脚本",
    kind: "self",
    applicable: Boolean(native),
    reason: native ? `指向原生程序 ${display(native)}，不依赖 node；nvm 版本变化后可重新生成。` : "没有找到 npm 全局安装的原生程序。",
  });
  const missing = tool.agents.filter((agent) => agent.allowRule === "missing");
  fixes.push({ id: "allow-rules", label: "给 Agent 补放行规则", kind: "self", applicable: missing.length > 0, reason: missing.length ? `缺少：${missing.map((agent) => agent.agentId).join("、")}` : "各 Agent 已有放行规则。" });
  const hermes = tool.agents.find((agent) => agent.agentId === "hermes");
  if (hermes?.plist) {
    fixes.push({
      id: "hermes-path",
      label: "Hermes 网关 PATH",
      kind: "guide",
      applicable: true,
      instructions: `编辑 ${hermes.plist} 中 EnvironmentVariables 的 PATH，把 ~/.local/bin 放到最前（例如 <string>~/.local/bin:…</string>，请写成绝对路径），然后重新加载网关；也可以用 hermes 自己的命令重装网关。Skill Control 不会修改 launchd 配置。`,
    });
  }
  const unbound = tool.agents.filter((agent) => agent.workspace !== "local" && !agent.workspaceConfigured);
  if (unbound.length) {
    fixes.push({
      id: "workspace-binding",
      label: "绑定 Hermes / OpenClaw 工作区",
      kind: "guide",
      applicable: true,
      instructions: [...new Set(unbound.map((agent) => agent.workspace))].map((workspace) => `lark-cli config bind --source ${workspace}`).join("\n"),
      reason: "需要该 Agent 的机器人凭据，请在终端自行运行。",
    });
  }
  if (tool.agents.some((agent) => agent.keychainReachable === "needs-downgrade")) {
    fixes.push({ id: "keychain-downgrade", label: "让沙箱内的 Agent 能读到凭据", kind: "guide", applicable: true, instructions: "lark-cli config keychain-downgrade", reason: "没有 master.key.file 时，沙箱里读不到钥匙串。" });
  }
  return fixes;
}

export function createCliManager({ homeDirectory, homes, backupDirectory, historyFile, detect, platform, now = () => Date.now() }) {
  const plans = new Map();
  let displayHomes = homes;
  const display = (value) => compactHomePath(value, displayHomes);

  async function plan({ toolId, fixId, agents = null }) {
    const tool = (await detect()).find((item) => item.id === toolId);
    if (tool) displayHomes = tool.internal.displayHomes || homes;
    if (!tool) throw new LibraryError(404, "没有找到这个 CLI 工具。");
    const fix = fixesFor(tool, { homes }).find((item) => item.id === fixId);
    if (!fix) throw new LibraryError(404, "没有这个修复项。");
    if (fix.kind === "guide") return { planId: null, toolId, fixId, kind: "guide", instructions: fix.instructions, reason: fix.reason || null };
    if (!fix.applicable) throw new LibraryError(409, fix.reason);
    const group = path.join(backupDirectory, `${timestamp(now())}-cli-${toolId}`);
    const ops = [];
    const notes = [];
    const skipped = [];
    if (fixId === "wrapper") {
      const target = path.join(homeDirectory, ".local", "bin", tool.internal.descriptor.command);
      const content = wrapperScript(tool.internal.nativeBinary);
      if ((await readText(target)) === content) return { planId: null, toolId, fixId, kind: "none", message: "启动脚本已是最新。" };
      ops.push({ op: "write", path: target, content, mode: 0o755, backup: path.join(group, "wrapper", tool.internal.descriptor.command), diff: content.trim().split("\n").map((line) => `+ ${line}`).join("\n") });
      const missingPath = tool.agents.filter((agent) => agent.resolves === null).map((agent) => agent.agentId);
      if (missingPath.length) notes.push(`这些 Agent 的 PATH 里还没有 ~/.local/bin：${missingPath.join("、")}。`);
    } else if (fixId === "allow-rules") {
      for (const agent of tool.agents.filter((item) => item.allowRule === "missing" && (!agents || agents.includes(item.agentId)))) {
        const result = await allowRuleOp(agent.agentId, homeDirectory, tool.internal.descriptor.command, group);
        if (result.op) {
          ops.push(result.op);
          if (result.op.note) notes.push(result.op.note);
        } else if (result.error) skipped.push({ agentId: agent.agentId, reason: result.error });
      }
    }
    if (!ops.length) return { planId: null, toolId, fixId, kind: "none", skipped, message: "没有需要写入的改动。" };
    for (const [id, stored] of plans) if (now() - stored.createdAt > CLI_PLAN_TTL_MS) plans.delete(id);
    const planId = randomUUID();
    plans.set(planId, { planId, createdAt: now(), toolId, fixId, ops, group });
    return {
      planId,
      toolId,
      fixId,
      kind: "self",
      steps: ops.map((op) => ({ type: op.op, path: display(op.path), backup: display(op.backup), diff: op.diff })),
      notes,
      skipped,
      expiresAt: new Date(now() + CLI_PLAN_TTL_MS).toISOString(),
    };
  }

  async function apply({ planId, confirm }) {
    if (confirm !== true) throw new LibraryError(400, "需要明确确认后才能执行。");
    const stored = plans.get(String(planId || ""));
    if (!stored || now() - stored.createdAt > CLI_PLAN_TTL_MS) {
      plans.delete(String(planId || ""));
      throw new LibraryError(404, "计划不存在或已过期（10 分钟），请重新生成。");
    }
    plans.delete(stored.planId);
    // All files of one fix change together or not at all.
    await runOps(stored.ops, { homeDirectory, display, backupGroup: stored.group, platform });
    const record = { type: "cli-fix", toolId: stored.toolId, fixId: stored.fixId, files: stored.ops.length, createdAt: new Date(now()).toISOString() };
    await mkdir(path.dirname(historyFile), { recursive: true });
    await appendFile(historyFile, `${JSON.stringify(record)}\n`, "utf8");
    return { planId: stored.planId, toolId: stored.toolId, fixId: stored.fixId, changed: stored.ops.map((op) => ({ path: display(op.path), backup: display(op.backup) })), historyEntry: record };
  }

  return { plan, apply };
}
