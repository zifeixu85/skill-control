"use client";

import { isUnsupported, useResource } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import { agentChecks, BINARY_KIND_LABELS, type CliTool } from "../../../lib/cli-tools";
import { useData } from "../../providers/DataProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { EmptyState, Loading } from "../../ui/basics";
import { CliFixCard } from "./CliFixCard";

function Why() {
  return (
    <div className="why">
      <b>为什么“装一次就能用”有时不灵？</b>
      <ul>
        <li>
          <b>找不到命令</b>：从程序坞打开的 Agent 不读你的终端配置（.zshrc、nvm），PATH 和终端里不一样。
        </li>
        <li>
          <b>工作区是分开的</b>：Hermes、OpenClaw 用自己的 lark-cli 配置，在终端里登录过不代表它们也登录了。
        </li>
        <li>
          <b>沙箱</b>：Codex 默认在沙箱里运行，读不到钥匙串里的凭据，也不能随便联网。
        </li>
        <li>
          <b>规则</b>：没有放行规则时，Agent 每次运行命令都要先问你。
        </li>
      </ul>
    </div>
  );
}

function ToolCard({ tool }: { tool: CliTool }) {
  const { agentName } = useData();
  const skewed = tool.binaries.filter((binary) => tool.latest && binary.version && binary.version !== tool.latest);
  return (
    <article className="tool-card">
      <header>
        <h3>{tool.name}</h3>
        {tool.latest ? <span className="tag mute">最新 {tool.latest}</span> : null}
        {tool.versionSkew || skewed.length ? (
          <span className="tag warn">
            版本不一致{skewed.length ? `：${skewed.map((binary) => `${BINARY_KIND_LABELS[binary.kind] || binary.kind} ${binary.version}`).join("、")}` : ""}
          </span>
        ) : null}
      </header>
      {tool.binaries.length ? (
        <section>
          <h4 className="mini-h">本机上的程序</h4>
          <div className="copies">
            {tool.binaries.map((binary) => (
              <div key={binary.path}>
                <code title={binary.target || binary.path}>{binary.path}</code>
                <em>{BINARY_KIND_LABELS[binary.kind] || binary.kind}{binary.via === "nvm" ? " · nvm" : ""}</em>
                <em>{binary.version || "版本未知"}</em>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <p className="muted small">没有在常见位置找到这个程序。</p>
      )}
      {tool.agents.length ? (
        <section>
          <h4 className="mini-h">各 Agent 用起来怎么样</h4>
          <div className="tool-agents">
            {tool.agents.map((row) => (
              <div className="tool-agent" key={row.agentId}>
                <div>
                  <AgentAvatar id={row.agentId} size="sm" />
                  {agentName(row.agentId)}
                </div>
                <div className="checks">
                  {agentChecks(row, tool.latest).map((check) => (
                    <span key={check.label} className={`check ${check.state}`} title={check.detail}>
                      <b>{check.label}</b>
                      {check.detail}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {tool.fixes.length ? (
        <section>
          <h4 className="mini-h">可以这样修</h4>
          <div className="fix-grid">
            {tool.fixes.map((fix) => (
              <CliFixCard key={fix.id} toolId={tool.id} fix={fix} />
            ))}
          </div>
        </section>
      ) : null}
    </article>
  );
}

export function CliTools() {
  const tools = useResource("cli-tools", () => api.cliTools());
  if (isUnsupported(tools.error)) {
    return <EmptyState title="本地服务还没有提供命令行工具检查">更新 Skill Control 后可以看到 lark-cli 等工具在各 Agent 里能不能用。</EmptyState>;
  }
  if (tools.status === "error" && !tools.data) return <EmptyState tone="error" title="检查失败">{errorMessage(tools.error)}</EmptyState>;
  if (!tools.data) return <Loading label="正在检查命令行工具…" rows={5} />;
  return (
    <>
      <Why />
      {tools.data.map((tool) => (
        <ToolCard key={tool.id} tool={tool} />
      ))}
      <p className="footnote">只读取版本号和配置文件是否存在，不运行这些命令，也不读取任何密钥。</p>
    </>
  );
}
