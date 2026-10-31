"use client";

import { useState } from "react";
import { useRevealLabel } from "../../../hooks/usePlatform";
import { invalidateResources } from "../../../hooks/useResource";
import { api, errorMessage } from "../../../lib/api";
import { copyText, COPY_FAILED } from "../../../lib/clipboard";
import { ENV_OFFLINE_TEXT, envOffline, networkPatch, PRIVACY_URL, updateChecksOn } from "../../../lib/onboarding";
import { FinderIcon } from "../../icons";
import { useData } from "../../providers/DataProvider";
import { useNav } from "../../providers/NavProvider";
import { useToast } from "../../providers/ToastProvider";
import { Switch } from "../../ui/basics";
import { ExternalLink } from "../../ui/ExternalLink";

export const DATA_DIR = "~/.agent-skill-manager";

/** 设置 → 数据与隐私: what is read and kept, 自动检查更新, and where the data lives. */
export function PrivacySection() {
  const { config, updateConfig, savingConfig } = useData();
  const { go } = useNav();
  const toast = useToast();
  const revealLabel = useRevealLabel();
  const [revealing, setRevealing] = useState(false);
  const checks = updateChecksOn(config.data);
  const offline = envOffline(config.data);

  const toggleChecks = async () => {
    const next = !checks;
    try {
      // Changing it here also counts as having seen the 联网 notice.
      await updateConfig(networkPatch(next));
      void invalidateResources("agent-versions", "updates");
      toast.show(next ? "已开启自动检查更新" : "已关闭自动检查更新，不会再自动联网");
    } catch (error) {
      toast.show(errorMessage(error, "保存失败。"), { tone: "error" });
    }
  };

  const reveal = async () => {
    setRevealing(true);
    try {
      const result = await api.revealDataDir();
      // Tests and sandboxes don't open windows: say where it is instead.
      if (result.opened === false) {
        const copied = await copyText(result.path || DATA_DIR);
        toast.show(copied ? `已复制路径 ${result.path || DATA_DIR}` : `数据目录在 ${result.path || DATA_DIR}`);
      }
    } catch (error) {
      // Older services can't open it: copy the path instead, so it's still one step away.
      const copied = await copyText(DATA_DIR);
      toast.show(copied ? `${errorMessage(error, "打不开这个文件夹。")} 已复制路径 ${DATA_DIR}` : COPY_FAILED, copied ? {} : { tone: "error" });
    } finally {
      setRevealing(false);
    }
  };

  return (
    <section className="set-block" aria-labelledby="set-privacy">
      <h2 id="set-privacy">数据与隐私</h2>
      <p>
        所有扫描和统计都在本机完成。会读取会话记录来统计次数和 Token，只保存数字，不保存、不上传对话内容。不显示、不保存密钥的值，只在本机保存一个加盐指纹，用来判断是否变化。
        完整列表见
        <ExternalLink className="md-link" href={PRIVACY_URL}>
          隐私说明
        </ExternalLink>
        。
      </p>
      <div className="set-row">
        <div className="set-row-text">
          <b id="set-update-checks">自动检查更新</b>
          <span>
            {offline
              ? ENV_OFFLINE_TEXT
              : checks
                ? "启动时和之后每天一次，从 GitHub、npm 和各 Agent 的官方更新地址查 Skill Control 与各 Agent 的新版本；只发出版本查询，不上传本机数据。点“立即检查”时也会联网。"
                : "已关闭：不会自动联网检查。你点“立即检查”或检查技能更新时仍会联网。"}
          </span>
        </div>
        <Switch checked={checks && !offline} label="自动检查更新" disabled={savingConfig || offline} onChange={() => void toggleChecks()} />
      </div>
      <div className="set-row">
        <div className="set-row-text">
          <b>数据目录</b>
          <span>
            <code>{DATA_DIR}</code>：设置、历史、替换前的备份（backups）和移除的技能（trash）。删除它会丢掉这些，技能库 ~/.agents/skills 不在里面。
          </span>
        </div>
        <button type="button" className="btn sm" disabled={revealing} onClick={() => void reveal()}>
          <FinderIcon />
          {revealLabel}
        </button>
      </div>
      <p>
        “数据”页的预估费用按各厂商官方 API 价格计算，订阅内的用量不等于实际支出。价格和计算规则见{" "}
        <button type="button" className="link-btn" onClick={() => go("pricing")}>
          模型价格表
        </button>
        。
      </p>
    </section>
  );
}
