"use client";

import { useState } from "react";
import { invalidateResources, isUnsupported, primeResource, useResource } from "../../../hooks/useResource";
import { useUndoToast } from "../../../hooks/useUndoToast";
import { api, errorMessage } from "../../../lib/api";
import { copyText, COPY_FAILED } from "../../../lib/clipboard";
import { CLI_EXAMPLES, COMPANION, companionPlanText, companionReach } from "../../../lib/integration";
import { primaryLibraryAgents } from "../../../lib/library";
import { CopiesIcon } from "../../icons";
import { useData } from "../../providers/DataProvider";
import { useToast } from "../../providers/ToastProvider";
import { AgentAvatar } from "../../ui/Avatar";

type Pending = "cli-install" | "cli-uninstall" | "skill" | null;

const LAUNCHER_KEY = "cli-launcher";
const COMPANION_KEY = "companion-skill";
const EXAMPLE_TEXT = CLI_EXAMPLES.map((example) => example.command).join("\n");

/** Two-step writes: the button says what will happen, 确认 runs it. */
function ConfirmRow({ text, action, busy, onConfirm, onCancel }: { text: string; action: string; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="int-confirm" role="group" aria-label={action}>
      <span>{text}</span>
      <span className="acts-right">
        <button type="button" className="btn sm ghost" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="button" className="btn sm primary" onClick={onConfirm} disabled={busy}>
          {busy ? "正在处理…" : action}
        </button>
      </span>
    </div>
  );
}

function CliTool({ pending, setPending }: { pending: Pending; setPending: (next: Pending) => void }) {
  const launcher = useResource(LAUNCHER_KEY, () => api.cliLauncher());
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const cli = launcher.data;
  const refresh = cli?.installed && !cli.upToDate;

  const run = async (action: "install" | "uninstall") => {
    setBusy(true);
    try {
      primeResource(LAUNCHER_KEY, await api.applyCliLauncher(action));
      toast.show(action === "install" ? (refresh ? "已更新命令行工具 skill-control" : "已安装命令行工具 skill-control") : "已卸载命令行工具 skill-control");
      setPending(null);
    } catch (error) {
      toast.show(errorMessage(error, action === "install" ? "没有安装成功。" : "没有卸载成功。"), { tone: "error" });
      void invalidateResources(LAUNCHER_KEY);
    } finally {
      setBusy(false);
    }
  };
  const copyExamples = async () => {
    const copied = await copyText(EXAMPLE_TEXT);
    toast.show(copied ? "已复制示例命令" : COPY_FAILED, copied ? {} : { tone: "error" });
  };

  return (
    <div className="int-card">
      <div className="int-head">
        <div>
          <h3>命令行工具 skill-control</h3>
          <p>装好后，你和 Agent 都能在终端里用它把技能放进技能库、接入常用 Agent、查看谁能用。它和这个应用共用备份、历史和撤销，不联网。</p>
        </div>
        {cli && cli.supported && !pending ? (
          cli.installed && !refresh ? (
            <button type="button" className="btn sm ghost" onClick={() => setPending("cli-uninstall")}>
              卸载
            </button>
          ) : (
            <button type="button" className="btn sm primary" disabled={cli.foreign} onClick={() => setPending("cli-install")}>
              {refresh ? "更新" : "安装命令行工具"}
            </button>
          )
        ) : null}
      </div>
      {isUnsupported(launcher.error) ? (
        <p className="muted small">当前的本地服务还不支持，更新 Skill Control 后可以安装。</p>
      ) : launcher.status === "error" && !cli ? (
        <p className="form-error">{errorMessage(launcher.error, "读取状态失败。")}</p>
      ) : !cli ? (
        <p className="muted small">正在读取…</p>
      ) : !cli.supported ? (
        <p className="inline-note">{cli.reason || "这个系统上暂时不能安装命令行工具（目前支持 macOS 和 Linux）。"}</p>
      ) : (
        <div className="int-status">
          <span className={`tag ${cli.installed ? "" : "mute"}`}>{cli.installed ? (refresh ? "需要更新" : "已安装") : "未安装"}</span>
          <code title={cli.path}>{cli.path}</code>
          {cli.installed && cli.runsWith ? <span className="muted small">启动 {cli.runsWith}</span> : null}
        </div>
      )}
      {cli?.foreign ? (
        <p className="inline-note warn">
          <code>{cli.path}</code> 已经是另一个文件，不是 Skill Control 写的，所以不会覆盖它。先自己处理这个文件，再回来安装。
        </p>
      ) : null}
      {cli?.installed && cli.onPath === false ? (
        <p className="inline-note warn">{cli.pathHint || "~/.local/bin 还不在 PATH 里：在 ~/.zshrc 里加一行 export PATH=\"$HOME/.local/bin:$PATH\"，新开的终端就能直接用。"}</p>
      ) : null}
      {pending === "cli-install" && cli ? (
        <ConfirmRow
          text={`写入 ${cli.path}：一个启动这个应用里命令行的小脚本。应用移动或更新后它也能找到新位置，随时可以卸载。`}
          action={refresh ? "确认更新" : "确认安装"}
          busy={busy}
          onConfirm={() => void run("install")}
          onCancel={() => setPending(null)}
        />
      ) : null}
      {pending === "cli-uninstall" && cli ? (
        <ConfirmRow
          text={`删除 ${cli.path}（只删 Skill Control 写的这个脚本，技能和历史都不动）。`}
          action="确认卸载"
          busy={busy}
          onConfirm={() => void run("uninstall")}
          onCancel={() => setPending(null)}
        />
      ) : null}
      <div className="int-examples">
        <div className="int-examples-head">
          <span>示例</span>
          <button type="button" className="btn sm ghost" onClick={() => void copyExamples()}>
            <CopiesIcon />
            复制
          </button>
        </div>
        {CLI_EXAMPLES.map((example) => (
          <div key={example.command} className="int-example">
            <code>{example.command}</code>
            <span>{example.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CompanionSkill({ pending, setPending }: { pending: Pending; setPending: (next: Pending) => void }) {
  const companion = useResource(COMPANION_KEY, () => api.companionSkill());
  const library = useResource("library", () => api.library());
  const { primary: appPrimary, agentName } = useData();
  const toast = useToast();
  const undoToast = useUndoToast();
  const [busy, setBusy] = useState(false);
  const status = companion.data;
  const primary = library.data ? primaryLibraryAgents(library.data, appPrimary) : appPrimary;
  const reach = companionReach(library.data, status, primary);
  const missing = reach.filter((row) => !row.visible);
  const stale = Boolean(status?.inLibrary && !status.upToDate);
  const unsupported = isUnsupported(companion.error);

  const install = async () => {
    setBusy(true);
    try {
      const { result, status: next } = await api.applyCompanionSkill();
      primeResource(COMPANION_KEY, next);
      undoToast(stale && !missing.length ? `已把 ${COMPANION} 技能更新到这个版本` : `已把 ${COMPANION} 技能放进技能库并接入常用 Agent`, result.historyId);
      setPending(null);
    } catch (error) {
      toast.show(errorMessage(error, "没有安装成功。"), { tone: "error" });
    } finally {
      setBusy(false);
      void invalidateResources(COMPANION_KEY, "library", "scan");
    }
  };

  return (
    <div className="int-card">
      <div className="int-head">
        <div>
          <h3>skill-control 技能</h3>
          <p>
            装到常用 Agent 后，你在 Agent 里说“装个技能”“从 GitHub 装这个 skill”“把这个技能给所有 Agent 用”，它会先问范围、做一次安全检查，再放进技能库并接入，和这里装的方式一样。
          </p>
        </div>
        {!unsupported && status?.available !== false && (missing.length || stale) && !pending ? (
          <button type="button" className="btn sm primary" onClick={() => setPending("skill")}>
            {missing.length ? "装到常用 Agent" : "更新到这个版本"}
          </button>
        ) : null}
      </div>
      {unsupported ? (
        <p className="muted small">当前的本地服务还不支持，更新 Skill Control 后可以安装。</p>
      ) : status?.available === false ? (
        <p className="muted small">这个版本没有随附 skill-control 技能。</p>
      ) : (
        <div className="int-reach" aria-label="skill-control 技能在常用 Agent 里能否使用">
          <span className={`tag ${status?.inLibrary ? (stale ? "warn" : "") : "mute"}`}>
            {status?.inLibrary ? (stale ? "库里是旧版本" : "在技能库里") : "还没有装"}
            {status?.version ? ` · v${status.version}` : ""}
          </span>
          {reach.map((row) => (
            <span key={row.agentId} className={`int-agent ${row.visible ? "on" : ""}`}>
              <AgentAvatar id={row.agentId} size="xs" />
              {agentName(row.agentId)}
              <em>{row.visible ? "能用" : "还看不到"}</em>
            </span>
          ))}
        </div>
      )}
      {pending === "skill" ? (
        <ConfirmRow
          text={`${companionPlanText(library.data, primary, agentName)}${stale ? "库里的旧版本先备份。" : ""}装好后可以撤销。`}
          action="确认安装"
          busy={busy}
          onConfirm={() => void install()}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}

/** 设置 → Agent 集成: installs made inside an Agent go through the library too. */
export function IntegrationSection() {
  const [pending, setPending] = useState<Pending>(null);
  return (
    <section className="set-block" aria-labelledby="set-integration">
      <h2 id="set-integration">Agent 集成</h2>
      <p>让你在 Agent 里装技能时，也走技能库：只存一份，再按各 Agent 的方式接入。</p>
      <div className="int-grid">
        <CliTool pending={pending} setPending={setPending} />
        <CompanionSkill pending={pending} setPending={setPending} />
      </div>
    </section>
  );
}
