import { spawn } from "node:child_process";

const mode = process.argv[2] === "start" ? "start" : "dev";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [];
let stopping = false;

function launch(command, args) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (!stopping && code !== 0) {
      console.error(
        `${command} ${args.join(" ")} stopped (${signal || code || 0}).`,
      );
      stop(code || 1);
    }
  });
  return child;
}

function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 250);
}

launch(process.execPath, ["server/local-server.mjs"]);
launch(npmCommand, ["run", `${mode}:web`]);

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
