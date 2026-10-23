"use client";

import { useAppUpdate } from "../../../hooks/useAppUpdate";
import { useNow } from "../../../hooks/useNow";
import { APP_NAME, appVersion, AUTHOR, BUILD_VERSION, LICENSE_NAME, LINKS } from "../../../lib/about";
import { appUpdateStore, REASON_TEXT, STATUS_TEXT, type AppUpdateState } from "../../../lib/app-update";
import { formatDateTime, formatRelative } from "../../../lib/format";
import { RefreshIcon, UpdateIcon } from "../../icons";
import { ExternalLink } from "../../ui/ExternalLink";
import { MarkdownView } from "../../ui/MarkdownView";

function UpdateActions({ state }: { state: AppUpdateState }) {
  const bridge = appUpdateStore.available();
  const busy = state.status === "checking" || state.status === "downloading" || state.status === "installing";
  const downloadPage = state.url || LINKS.releases;
  if (!bridge) {
    return (
      <ExternalLink className="btn" href={LINKS.releases}>
        打开下载页
      </ExternalLink>
    );
  }
  return (
    <div className="about-acts">
      <button type="button" className="btn" disabled={busy || state.status === "offline"} onClick={() => void appUpdateStore.check()}>
        <RefreshIcon className={state.status === "checking" ? "spin" : ""} />
        {state.status === "checking" ? "正在检查…" : "检查更新"}
      </button>
      {state.status === "available" && state.canInstall ? (
        <button type="button" className="btn primary" onClick={() => void appUpdateStore.download()}>
          <UpdateIcon />
          下载并安装 {state.latest}
        </button>
      ) : null}
      {state.status === "ready" && state.canInstall ? (
        <button type="button" className="btn primary" onClick={() => void appUpdateStore.install()}>
          重启并完成更新
        </button>
      ) : null}
      {(state.status === "available" || state.status === "ready") && !state.canInstall ? (
        <ExternalLink className="btn primary" href={downloadPage}>
          打开下载页
        </ExternalLink>
      ) : null}
    </div>
  );
}

/** 设置 → 版本检查: Skill Control's own version and updates. */
export function AppUpdateSetting() {
  const state = useAppUpdate();
  const now = useNow();
  const bridge = appUpdateStore.available();
  const percent = state.progress === null ? null : Math.round(state.progress * 100);
  const reason = state.reason ? REASON_TEXT[state.reason] : null;
  return (
    <section className="set-block" aria-labelledby="set-app-update">
      <h2 id="set-app-update">Skill Control 更新</h2>
      <p>
        {bridge
          ? "从 GitHub Releases 检查新版本：启动时和之后每天一次，离线模式不检查。下载后会先校验，再替换应用并重启。"
          : "网页版和开发版不能在应用里更新，请到 GitHub Releases 下载新版。"}
      </p>
      <div className={`about-update ${state.status}`} role="status" aria-live="polite">
        <div className="about-update-line">
          <b>
            {state.status === "available" || state.status === "ready"
              ? `${STATUS_TEXT[state.status]}：${state.latest || ""}`
              : bridge
                ? STATUS_TEXT[state.status]
                : `当前版本 ${appVersion(state.current)}`}
          </b>
          {state.checkedAt && now ? <span className="muted small">{formatRelative(state.checkedAt, now)}检查</span> : null}
        </div>
        {state.status === "downloading" ? (
          <span className="progress" role="progressbar" aria-label="下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
            <i style={{ transform: `scaleX(${state.progress ?? 0})` }} />
          </span>
        ) : null}
        {state.status === "error" && state.error ? <p className="form-error">{state.error}</p> : null}
        {(state.status === "unsupported" || state.status === "offline") && reason ? <p className="muted small">{reason}</p> : null}
        {state.manual && (!state.canInstall || state.status === "unsupported") ? <p className="muted small">{state.manual}</p> : null}
        {state.notice && (state.status === "available" || state.status === "ready") ? <p className="safe-note warn">{state.notice}</p> : null}
        <UpdateActions state={state} />
        {state.notes && (state.status === "available" || state.status === "ready" || state.status === "downloading") ? (
          <details className="about-notes" open>
            <summary>
              {state.latest} 更新说明{state.publishedAt ? ` · ${formatDateTime(state.publishedAt)}` : ""}
            </summary>
            <MarkdownView content={state.notes} />
          </details>
        ) : null}
      </div>
    </section>
  );
}

/** 设置 → 关于. */
export function AboutSection() {
  const state = useAppUpdate();
  const version = appVersion(state.current);
  return (
    <section className="set-block" aria-labelledby="set-about">
      <h2 id="set-about">关于</h2>
      <div className="about-card">
        <div className="about-head">
          <b>{APP_NAME}</b>
          <span className="tag mute">版本 {version || "未知"}</span>
          {state.current && BUILD_VERSION && state.current !== BUILD_VERSION ? <span className="muted small">界面构建 {BUILD_VERSION}</span> : null}
        </div>
        <p>在一个地方查看和整理 Codex、Claude Code、WorkBuddy 等 Agent 的技能、插件、专家和 MCP 配置。所有扫描都在本机完成。</p>
        <dl className="kv">
          <div className="kv-row">
            <dt className="k">作者</dt>
            <dd>
              {AUTHOR.name} ·{" "}
              <ExternalLink className="md-link" href={AUTHOR.website.url}>
                {AUTHOR.website.label}
              </ExternalLink>
            </dd>
          </div>
          <div className="kv-row">
            <dt className="k">源代码</dt>
            <dd>
              <ExternalLink className="md-link" href={LINKS.repository}>
                github.com/zifeixu85/skill-control
              </ExternalLink>
            </dd>
          </div>
          <div className="kv-row">
            <dt className="k">许可证</dt>
            <dd>
              <ExternalLink className="md-link" href={LINKS.license}>
                {LICENSE_NAME}
              </ExternalLink>
            </dd>
          </div>
          <div className="kv-row">
            <dt className="k">问题反馈</dt>
            <dd>
              <ExternalLink className="md-link" href={LINKS.issues}>
                GitHub Issues
              </ExternalLink>
            </dd>
          </div>
          <div className="kv-row">
            <dt className="k">第三方许可</dt>
            <dd>
              <ExternalLink className="md-link" href={LINKS.thirdParty}>
                THIRD_PARTY_NOTICES
              </ExternalLink>
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
