// Development only: runs the manager service and the web UI on side ports so they never
// collide with an installed Skill Control (which owns 43110 / 3000).
//
//   npm run dev:ui                      → manager 43119, UI http://127.0.0.1:3001
//   SKILL_MANAGER_PORT=43120 SKILL_CONTROL_UI_PORT=3002 npm run dev:ui
//
// The UI reaches the manager through NEXT_PUBLIC_SKILL_MANAGER_API_BASE, which the
// app only honors in development builds. Both sides use 127.0.0.1 so image and config
// routes stay same-site.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const managerPort = Number(process.env.SKILL_MANAGER_PORT || 43119);
const uiPort = Number(process.env.SKILL_CONTROL_UI_PORT || 3001);
const uiOrigin = `http://127.0.0.1:${uiPort}`;
const children = [];
let stopping = false;

function launch(command, args, env) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: "inherit" });
  children.push(child);
  child.on("exit", (code) => {
    if (!stopping && code) stop(code);
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (!child.killed) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250);
}

launch(process.execPath, ["server/local-server.mjs"], {
  SKILL_MANAGER_PORT: String(managerPort),
  SKILL_MANAGER_ORIGINS: uiOrigin,
});
launch(process.execPath, [path.join("node_modules", "vinext", "dist", "cli.js"), "dev", "-p", String(uiPort), "-H", "127.0.0.1"], {
  NEXT_PUBLIC_SKILL_MANAGER_API_BASE: `http://127.0.0.1:${managerPort}`,
});

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
