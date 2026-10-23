"use client";

import { useState } from "react";
import { DiscoveryRows, useDiscovery, useIgnoreAll } from "../pages/home/NewAgentsNotice";
import { Drawer } from "./Drawer";

/** Every new Agent and Agent-like folder, with the same actions as the card. */
export function DiscoveryDrawer({ onClose }: { onClose: () => void }) {
  const { fresh, candidates, total, busy, run } = useDiscovery();
  const ignoreAll = useIgnoreAll();
  const [confirming, setConfirming] = useState(false);
  return (
    <Drawer
      label="发现的新 Agent"
      title="发现的新 Agent"
      subtitle={total ? `${total} 个 · 新检测到的 Agent 在前，文件夹按技能数排序` : "没有新的了"}
      onClose={onClose}
      wide
      footer={
        total ? (
          confirming ? (
            <div className="discovery-foot">
              <span className="discovery-confirm">把这 {total} 个都标为已知或忽略？以后不再提示它们。</span>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setConfirming(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn sm danger"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                  run(`已忽略 ${total} 个`, () => ignoreAll(fresh, candidates));
                }}
              >
                确认全部忽略
              </button>
            </div>
          ) : (
            <div className="discovery-foot">
              <span className="muted small">设为常用、添加或忽略后，这里会自动更新。</span>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => setConfirming(true)}>
                全部忽略
              </button>
            </div>
          )
        ) : null
      }
    >
      <div className="insp-body discovery-list" aria-busy={busy || undefined}>
        {total ? <DiscoveryRows fresh={fresh} candidates={candidates} busy={busy} run={run} /> : <p className="muted">都处理完了。</p>}
      </div>
    </Drawer>
  );
}
