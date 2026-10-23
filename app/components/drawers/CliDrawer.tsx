"use client";

import { useNow } from "../../hooks/useNow";
import { useResource } from "../../hooks/useResource";
import { AI_REASON_LABELS } from "../../lib/cli-tools";
import { formatBytes, formatDateTime, formatRelative } from "../../lib/format";
import { markOpened } from "../../lib/page-memory";
import { useNav } from "../providers/NavProvider";
import { useData } from "../providers/DataProvider";
import { AgentAvatar, LetterLogo } from "../ui/Avatar";
import { KvTable } from "../ui/basics";
import { CliDeepDetail } from "../pages/cli/CliDetail";
import { CLI_KEY, loadCliTools, ownerText } from "../pages/cli/CliTools";
import { Drawer } from "./Drawer";

/** One command-line tool: where it is, who installed it, which skills use it and, for deep tools, per-Agent checks and fixes. */
export function CliDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const tools = useResource(CLI_KEY, loadCliTools);
  const { views, agentName } = useData();
  const { go } = useNav();
  const now = useNow();
  const tool = tools.data?.tools.find((item) => item.id === id);
  if (!tool) return null;
  const owner = ownerText(tool);
  const skillLinks = tool.referencedBySkills.map((name) => ({ name, view: views.find((view) => view.techName.toLowerCase() === name.toLowerCase()) || null }));
  return (
    <Drawer label={`${tool.name} 命令行工具`} icon={<LetterLogo text={tool.name} />} title={<span className="mono">{tool.name}</span>} subtitle={owner || "命令行工具"} onClose={onClose} wide={tool.deep}>
      <div className="insp-body">
        {tool.description ? <p className="desc">{tool.description}</p> : null}
        <section>
          <h3>概况</h3>
          <KvTable
            rows={[
              { label: "位置", value: tool.path ? <code>{tool.path}</code> : "" },
              { label: "指向", value: tool.target ? <code>{tool.target}</code> : "" },
              { label: "其他入口", value: tool.links.length ? tool.links.join("、") : "" },
              { label: "找到的位置", value: tool.sourceLabel || "" },
              { label: "来源", value: owner || "" },
              { label: "大小", value: tool.size ? formatBytes(tool.size) : "" },
              { label: "安装 / 修改", value: tool.mtime ? `${formatDateTime(tool.mtime)}${now ? `（${formatRelative(tool.mtime, now)}）` : ""}` : "" },
              { label: "AI 相关", value: tool.aiRelated ? (tool.aiReasons.length ? `是 · ${tool.aiReasons.map((reason) => AI_REASON_LABELS[reason] || reason).join("、")}` : "是") : "否" },
            ]}
          />
        </section>
        {skillLinks.length || tool.referencedCount ? (
          <section>
            <h3>被 {tool.referencedCount || skillLinks.length} 个技能使用</h3>
            {skillLinks.length ? (
              <ul className="chip-list">
                {skillLinks.map(({ name, view }) =>
                  view ? (
                    <li key={name}>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={() => {
                          markOpened("connectors", tool.id);
                          go("skills", { skillId: view.id });
                        }}
                      >
                        {view.title}
                      </button>
                    </li>
                  ) : (
                    <li key={name}>
                      <code>{name}</code>
                    </li>
                  ),
                )}
              </ul>
            ) : null}
          </section>
        ) : null}
        {tool.deep ? (
          <CliDeepDetail tool={tool} />
        ) : tool.availability.length ? (
          <section>
            <h3>各 Agent 能不能用</h3>
            <ul className="avail-list">
              {tool.availability.map((entry) => (
                <li key={entry.agentId}>
                  <AgentAvatar id={entry.agentId} size="xs" />
                  <span className="clamp-1">{agentName(entry.agentId)}</span>
                  <span className={`cstate ${entry.available === true ? "ok" : entry.available === false ? "bad" : "na"}`}>
                    <i aria-hidden="true" />
                    {entry.available === true ? "找得到" : entry.available === false ? "找不到" : "不确定"}
                  </span>
                  <span className="muted small">{entry.allowed === true ? "已放行" : entry.allowed === false ? "没有放行规则，每次运行都要先问你" : ""}</span>
                </li>
              ))}
            </ul>
            <p className="muted small">从程序坞打开的 Agent 不读你的终端配置，PATH 可能和终端里不一样。</p>
          </section>
        ) : null}
      </div>
    </Drawer>
  );
}
