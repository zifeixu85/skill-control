import { realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";

/**
 * Belt and braces for every library / CLI write. The developer's real home (from the
 * account database, not $HOME) is protected whenever this service runs with another home
 * (a sandbox or test), and every write is refused under it while a test runner is active.
 */

const PASSWD_HOME = (() => {
  try {
    return path.resolve(userInfo().homedir);
  } catch {
    return null;
  }
})();

export class HomeGuardError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 403;
  }
}

const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

async function realOrNearest(target) {
  const rest = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

export const testContextActive = () => Boolean(process.env.NODE_TEST_CONTEXT || process.env.SKILL_CONTROL_TEST === "1");

/**
 * Throws unless writing `target` is allowed for a service configured with
 * `homeDirectory`. `protectedHome` is injectable for tests of the guard itself.
 */
export async function assertSafeWrite(target, homeDirectory, { protectedHome = PASSWD_HOME } = {}) {
  if (!protectedHome) return;
  const [realTarget, realProtected, realConfigured] = await Promise.all([
    realOrNearest(target),
    realOrNearest(protectedHome),
    realOrNearest(homeDirectory),
  ]);
  if (!within(realProtected, realTarget) && !within(protectedHome, path.resolve(target))) return;
  const sandboxed = realConfigured !== realProtected;
  if (sandboxed || testContextActive()) {
    throw new HomeGuardError("为保护本机真实目录，测试或沙箱环境中拒绝写入真实主目录。");
  }
}
