"use client";

import { useNow } from "../../hooks/useNow";
import { formatRelative } from "../../lib/format";
import { mergePlugins, pluginConnectors } from "../../lib/plugins";
import type { Connector } from "../../lib/types";
import { useData } from "../providers/DataProvider";
import { useNav } from "../providers/NavProvider";
import { LetterLogo, PluginLogo } from "../ui/Avatar";
import { KvTable } from "../ui/basics";
import { Drawer } from "./Drawer";

function authText(connector: Connector): { text: string; tone: "ok" | "warn" | "mute" } {
  const status = connector.auth?.status || connector.authStatus || "";
  if (connector.authorized === true || /^(authorized|connected|ok)$/iu.test(status)) return { text: "已连接", tone: "ok" };
  if (connector.authorized === false || /^(unauthorized|expired|disconnected|needs-auth)$/iu.test(connector.authStatus || "")) return { text: "需要在 Codex 里重新授权", tone: "warn" };
  return { text: "本地缓存里没有授权信息，在 Codex 里查看", tone: "mute" };
}

/** 连接器详情: who provides it, its tools and whether it's authorized. Read-only. */
export function ConnectorDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { integrations } = useData();
  const { openDrawer } = useNav();
  const now = useNow();
  const connector = integrations.data?.connectors.find((item) => item.id === id);
  if (!connector) return null;
  const plugins = mergePlugins(integrations.data?.plugins || []);
  const provider = plugins.find((plugin) => pluginConnectors(plugin, [connector]).length > 0) || null;
  const providerNames = (connector.providers || []).map((item) => item.name).filter(Boolean);
  const auth = authText(connector);
  const tools = connector.tools?.length ? connector.tools : connector.toolNames.map((name) => ({ name, description: null, readOnly: null }));
  return (
    <Drawer
      label={`${connector.name} 连接器`}
      icon={provider ? <PluginLogo plugin={provider} /> : <LetterLogo text={connector.name} />}
      title={connector.name}
      subtitle={`Codex 连接器 · ${connector.toolCount} 个工具`}
      onClose={onClose}
    >
      <div className="insp-body">
        {connector.description ? <p className="desc">{connector.description}</p> : null}
        <section>
          <h3>概况</h3>
          <KvTable
            rows={[
              {
                label: "提供方",
                value: provider ? (
                  <button type="button" className="link-btn" onClick={() => openDrawer({ kind: "plugin", id: provider.key })}>
                    插件 {provider.displayName || provider.name}
                  </button>
                ) : providerNames.length || connector.providedByPlugins.length ? (
                  (providerNames.length ? providerNames : connector.providedByPlugins).join("、")
                ) : (
                  "Codex 内置"
                ),
              },
              {
                label: "授权状态",
                value: (
                  <span title={connector.auth?.basis || undefined}>
                    <span className={`tag ${auth.tone === "ok" ? "" : auth.tone}`}>{auth.text}</span>
                    {connector.auth?.basis ? <span className="muted small"> {connector.auth.basis}</span> : null}
                  </span>
                ),
              },
              { label: "命名空间", value: connector.namespace || "" },
              { label: "缓存时间", value: connector.cachedAt && now ? formatRelative(connector.cachedAt, now) : "" },
            ]}
          />
        </section>
        <section>
          <h3>工具（{tools.length || connector.toolCount}）</h3>
          {tools.length ? (
            <ul className={tools.some((tool) => tool.description) ? "tool-list" : "tool-names"}>
              {tools.map((tool) => (
                <li key={tool.name}>
                  <code>{tool.name}</code>
                  {tool.readOnly ? <span className="tag mute">只读</span> : null}
                  {tool.description ? <span className="tool-desc">{tool.description}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">本地缓存只记录了工具数量。</p>
          )}
        </section>
        <p className="footnote">连接、授权和停用都在 Codex 里完成；这里只读。</p>
      </div>
    </Drawer>
  );
}
