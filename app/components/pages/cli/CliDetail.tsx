"use client";

import { agentChecks, BINARY_KIND_LABELS, CHECK_COLUMNS, type CliTool } from "../../../lib/cli-tools";
import { useData } from "../../providers/DataProvider";
import { AgentAvatar } from "../../ui/Avatar";
import { ItemText } from "../../ui/Item";
import { CliFixCard } from "./CliFixCard";

export function Why() {
  return (
    <details className="why">
      <summary>为什么“装一次就能用”有时不灵？</summary>
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
    </details>
  );
}

/** One row per Agent, one aligned column per check; the full sentence is in each cell's tooltip. */
function AgentChecksTable({ tool }: { tool: CliTool }) {
  const { agentName } = useData();
  const rows = tool.agents.map((row) => ({ row, checks: agentChecks(row, tool.latest) }));
  const columns = CHECK_COLUMNS.filter((column) => rows.some((item) => item.checks.some((check) => check.key === column.key)));
  const name = (row: CliTool["agents"][number]) => (agentName(row.agentId) === row.agentId && row.agentName ? row.agentName : agentName(row.agentId));
  return (
    <div className="matrix checks-table">
      <table>
        <caption className="sr-only">{tool.name} 在各 Agent 里的情况</caption>
        <thead>
          <tr>
            <th scope="col">Agent</th>
            {columns.map((column) => (
              <th scope="col" key={column.key}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ row, checks }) => {
            const command = checks.find((check) => check.key === "command");
            return (
              <tr key={row.agentId}>
                <th scope="row" className="cell-main">
                  <span className="cell-lead">
                    <AgentAvatar id={row.agentId} size="sm" />
                    <ItemText
                      title={name(row)}
                      meta={row.resolves ? row.resolves.path : `PATH 来自 ${row.pathSource || "未知来源"}`}
                      titleText={name(row)}
                      mono={Boolean(row.resolves)}
                    />
                  </span>
                </th>
                {columns.map((column) => {
                  const check = column.key === "command" ? command : checks.find((item) => item.key === column.key);
                  return (
                    <td key={column.key}>
                      {check ? (
                        <span className={`cstate ${check.state}`} title={`${check.label}：${check.detail}`}>
                          <i aria-hidden="true" />
                          {check.short}
                        </span>
                      ) : (
                        <span className="none">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The per-Agent table, the copies on this Mac and the fixes (the old lark-cli card). */
export function CliDeepDetail({ tool }: { tool: CliTool }) {
  const skewed = tool.binaries.filter((binary) => tool.latest && binary.version && binary.version !== tool.latest);
  return (
    <div className="cli-deep">
      {tool.latest || tool.versionSkew || skewed.length ? (
        <div className="inside">
          {tool.latest ? <span className="tag mute">最新 {tool.latest}</span> : null}
          {tool.versionSkew || skewed.length ? (
            <span className="tag warn">
              版本不一致{skewed.length ? `：${skewed.map((binary) => `${BINARY_KIND_LABELS[binary.kind] || binary.kind} ${binary.version}`).join("、")}` : ""}
            </span>
          ) : null}
        </div>
      ) : null}
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
          <AgentChecksTable tool={tool} />
        </section>
      ) : null}
      {tool.fixes.length ? (
        <section>
          <h4 className="mini-h">可以这样修</h4>
          <p className="muted small">“预览修复”会先列出要改的文件，确认后才执行；“复制命令”只复制，不会运行。</p>
          <div className="fix-grid">
            {tool.fixes.map((fix) => (
              <CliFixCard key={fix.id} toolId={tool.id} fix={fix} agentIds={tool.agents.map((row) => row.agentId)} />
            ))}
          </div>
        </section>
      ) : null}
      {tool.agents.length ? <Why /> : null}
    </div>
  );
}

