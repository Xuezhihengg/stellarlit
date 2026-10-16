/**
 * 设计令牌一致性校验。
 *
 * 为什么需要它:`src/lib/design/palette.ts` 里的画布调色板必须与
 * `src/app/globals.css` 的 CSS 变量同值 —— Canvas 读不到 CSS 变量,
 * 这份重复是刻意的;但没有校验就会静默漂移,表现为"换个主题颜色就不对了"。
 *
 * 校验:两边都该出现的令牌,逐个比对 16 进制值。
 *
 * 运行:`pnpm check:tokens`(已被 `pnpm check` 调用)
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 两边都应该存在的令牌。css 里的 `--ink-2` 对应 palette 里的 `ink2`。 */
const SHARED: ReadonlyArray<{ css: string; palette: string }> = [
  { css: "bg", palette: "bg" },
  { css: "ink", palette: "ink" },
  { css: "ink-2", palette: "ink2" },
  { css: "ink-3", palette: "ink3" },
  { css: "ink-4", palette: "ink4" },
  { css: "accent", palette: "accent" },
  { css: "warm", palette: "warm" },
  { css: "alert", palette: "alert" },
];

function readCssTokens(cssPath: string): Map<string, string> {
  const css = readFileSync(cssPath, "utf8");
  const rootBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!rootBlock?.[1]) throw new Error(`${cssPath} 里找不到 :root 块`);

  const tokens = new Map<string, string>();
  for (const line of rootBlock[1].split("\n")) {
    const m = line.match(/^\s*--([a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (m?.[1] && m[2]) tokens.set(m[1], m[2].trim());
  }
  return tokens;
}

function readPaletteTokens(palettePath: string): Map<string, string> {
  const src = readFileSync(palettePath, "utf8");
  const darkBlock = src.match(/\n\s*dark:\s*\{([\s\S]*?)\n\s*\},/);
  if (!darkBlock?.[1]) throw new Error(`${palettePath} 里找不到 dark 调色板`);

  const tokens = new Map<string, string>();
  for (const line of darkBlock[1].split("\n")) {
    const m = line.match(/^\s*"?([a-zA-Z0-9]+)"?\s*:\s*"([^"]+)"/);
    if (m?.[1] && m[2]) tokens.set(m[1], m[2]);
  }
  return tokens;
}

const cssTokens = readCssTokens(resolve(ROOT, "src/app/globals.css"));
const paletteTokens = readPaletteTokens(resolve(ROOT, "src/lib/design/palette.ts"));

const problems: string[] = [];

for (const { css, palette } of SHARED) {
  const cssValue = cssTokens.get(css);
  const paletteValue = paletteTokens.get(palette);

  if (!cssValue) {
    problems.push(`globals.css 缺少令牌 --${css}`);
    continue;
  }
  if (!paletteValue) {
    problems.push(`palette.ts 缺少令牌 ${palette}`);
    continue;
  }
  if (cssValue.toLowerCase() !== paletteValue.toLowerCase()) {
    problems.push(`令牌 ${css} 不一致:css=${cssValue} palette=${paletteValue}`);
  }
}

if (problems.length > 0) {
  console.error("设计令牌校验失败:\n" + problems.map((p) => `  x ${p}`).join("\n"));
  process.exit(1);
}

console.log(`设计令牌一致(${SHARED.length} 项)`);
