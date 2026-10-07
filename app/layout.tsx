import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./styles/shell.css";
import "./styles/controls.css";
import "./styles/surfaces.css";
import "./styles/anatomy.css";
import "./styles/overlays.css";
import "./styles/home.css";
import "./styles/skills.css";
import "./styles/inspector.css";
import "./styles/catalog.css";
import "./styles/insights.css";
import "./styles/pricing.css";
import "./styles/updates.css";
import "./styles/library.css";
import "./styles/content.css";
import "./styles/assist.css";

export const metadata: Metadata = {
  title: "Skill Control — 本地技能管理器",
  description:
    "在一个地方查看和整理 Codex、Claude Code、WorkBuddy 等 Agent 的技能、插件、专家和 MCP 配置。",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
