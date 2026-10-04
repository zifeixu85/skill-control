"use client";

/** Last-resort fallback when the app shell itself fails to render. */
export default function AppError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main className="gate" role="alert" style={{ minHeight: "100vh" }}>
      <div className="empty error">
        <b>Skill Control 遇到了意外错误</b>
        <p>{error?.message || "界面没能正常显示。"}你的技能和配置没有被改动。</p>
        <div className="empty-action">
          <button type="button" className="btn" onClick={() => reset()}>
            重新加载
          </button>
        </div>
      </div>
    </main>
  );
}
