/**
 * 画布调色板。
 *
 * Canvas 读不到 CSS 变量,所以这里把 `globals.css` 里的令牌复写一份。
 * 这是刻意的重复 —— 唯一的替代方案是在运行时 getComputedStyle 逐帧取值,
 * 那个开销远大于维护这张表。
 *
 * 规则:这里的键必须与 globals.css 的令牌同名。改一处就要改另一处,
 * 由 scripts/check-tokens.ts 校验(见 package.json 的 check 脚本)。
 */

import type { Theme } from "@/hooks/use-theme";

export interface CanvasPalette {
  bg: string;
  ink: string;
  ink2: string;
  ink3: string;
  ink4: string;
  accent: string;
  warm: string;
  alert: string;
  /** 星尘的基色(通常是 ink 的极低透明度版本)。 */
  dust: string;
  /** 世界底色上那一层几乎看不见的星云底光。 */
  nebula: string;
  /** 主题相关的混合模式:夜间靠发光,白天靠墨点叠加。 */
  blend: GlobalCompositeOperation;
}

export const PALETTES: Record<Theme, CanvasPalette> = {
  dark: {
    bg: "#07080A",
    ink: "#F2F4F7",
    ink2: "#AEB6C2",
    ink3: "#6C7480",
    ink4: "#464C56",
    accent: "#A8C7FA",
    warm: "#E0B872",
    alert: "#E09A9A",
    dust: "rgba(242,244,247,0.5)",
    nebula: "rgba(168,199,250,0.05)",
    blend: "lighter",
  },
  light: {
    bg: "#F4F3EF",
    ink: "#14181F",
    ink2: "#3E4652",
    ink3: "#6B7480",
    ink4: "#9AA2AD",
    accent: "#2F63C4",
    warm: "#A8761F",
    alert: "#B4433C",
    dust: "rgba(20,24,31,0.55)",
    nebula: "rgba(47,99,196,0.05)",
    blend: "source-over",
  },
};

/**
 * 领域与社区色调。
 *
 * 收敛到同一色系里的五种极淡冷调,而不是彩虹:
 * 靠**位置与标签**区分群体,靠**颜色**区分语义层级。
 * 颜色一旦被用来区分"这是第几个社区",图例就再也解释不清了。
 */
export const DOMAIN_TONES = [
  { dark: "rgba(168,199,250,0.16)", light: "rgba(47,99,196,0.13)" },
  { dark: "rgba(150,180,225,0.15)", light: "rgba(66,104,168,0.12)" },
  { dark: "rgba(190,205,235,0.15)", light: "rgba(92,112,150,0.12)" },
  { dark: "rgba(140,170,215,0.14)", light: "rgba(52,86,140,0.12)" },
  { dark: "rgba(205,215,240,0.14)", light: "rgba(110,124,158,0.11)" },
] as const;

export function domainTone(tone: number, theme: Theme): string {
  const entry = DOMAIN_TONES[tone % DOMAIN_TONES.length] ?? DOMAIN_TONES[0];
  return entry[theme];
}
