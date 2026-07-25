import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "技能管理器 — 本地智能工具技能管理",
  description:
    "统一扫描、比较和同步 Codex、Claude Code、WorkBuddy 等智能工具的本地技能。",
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
