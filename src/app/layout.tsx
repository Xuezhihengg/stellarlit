import type { Metadata, Viewport } from "next";
import "./globals.css";

import { RouteTransition } from "@/components/shell/RouteTransition";

export const metadata: Metadata = {
  title: "StellarLit · 论文星图",
  description:
    "输入一篇种子论文,自动长出它的研究星图:关系、脉络,以及其中还没被点亮的位置。",
};

export const viewport: Viewport = {
  themeColor: "#07080A",
  width: "device-width",
  initialScale: 1,
};

/**
 * 首屏前把主题写到 <html data-theme>,避免刷新时闪一下白底。
 * 脚本必须是同步的 —— 放到 useEffect 里就来不及了。
 */
const THEME_BOOTSTRAP = `try{var t=localStorage.getItem("stellarlit:theme");if(t!=="light"&&t!=="dark"){t=window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme="dark";}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        {children}
        <RouteTransition />
      </body>
    </html>
  );
}
