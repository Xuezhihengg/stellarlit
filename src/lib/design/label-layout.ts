/**
 * 标签排版 —— 折行与落位,与 Canvas 无关。
 *
 * 为什么单独一层:渲染每帧都在跑,而"文字怎么断、整块落在哪"是纯几何。
 * 混在绘制代码里就没法脱离浏览器验证 —— 偏偏这一类 bug("断行点每帧重算,
 * 于是文字看起来一直在重排")靠肉眼看是发现不了根因的:看到的现象是"怪",
 * 但不知道怪在哪。抽出来之后,它能在 Node 里用确定性的量宽桩跑检查,
 * 也能被别的渲染器(导出图、文档截图)复用。
 *
 * 度量由调用方注入:页面传 ctx.measureText,检查脚本传一个固定桩。
 * 因此这里零依赖、不认识浏览器。
 */

export interface LabelPoint {
  x: number;
  y: number;
}

/** 量宽:给一段文字,返回它在当前字号下的像素宽度 */
export type MeasureText = (text: string) => number;

/**
 * 按像素宽度折行。
 *
 * 按空格断词并逐行测量,而不是按字符数 —— 后者在比例字体里会让长短行差得
 * 很远。但只按空格断还不够:一个词本身就超宽时(中文标题常常整句没有空格,
 * 英文标题里也偶尔夹一个长缩写),它会顶穿栏宽,把整块文字拉成一条横线 ——
 * 所以这种词按字符硬断。
 *
 * 超过 maxLines 时在末行收省略号:与其让标题压到邻居身上,不如让它有一个
 * 明确的收尾。
 */
export function wrapByWidth(
  text: string,
  maxWidth: number,
  maxLines: number,
  measure: MeasureText,
): string[] {
  // 断行单元自己带前导空格(除了第一个),这样换行时把空格一并丢掉即可
  const units: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const lead = units.length ? " " : "";
    if (measure(word) <= maxWidth) {
      units.push(`${lead}${word}`);
      continue;
    }
    // 这个词本身就超宽 → 按字符硬断(只有第一段继承那个空格)
    let part = "";
    let prefix = lead;
    for (const ch of word) {
      if (part && measure(part + ch) > maxWidth) {
        units.push(prefix + part);
        prefix = "";
        part = "";
      }
      part += ch;
    }
    if (part) units.push(prefix + part);
  }

  const lines: string[] = [];
  let line = "";
  let rest = "";

  for (const u of units) {
    if (!line) {
      line = u.trimStart();
      continue;
    }
    if (measure(line + u) <= maxWidth) {
      line += u;
      continue;
    }
    lines.push(line);
    if (lines.length === maxLines) {
      rest = u.trimStart();
      break;
    }
    line = u.trimStart();
  }

  if (rest) {
    const last = lines[lines.length - 1] ?? "";
    let trimmed = last;
    while (trimmed.length > 1 && measure(`${trimmed}…`) > maxWidth) {
      trimmed = trimmed.slice(0, -1);
    }
    lines[lines.length - 1] = `${trimmed}…`;
  } else if (line) {
    lines.push(line);
  }

  return lines;
}

export interface LabelBlockInput {
  /** 已经断好的行 */
  lines: string[];
  /** 行高(像素) */
  lineHeight: number;
  /** 第一行文字中心的落点:整块以它为基准向下生长 */
  anchor: LabelPoint;
  /** 可视区尺寸 */
  viewport: { width: number; height: number };
  /** 与视口边缘的最小留白 */
  padding: number;
  measure: MeasureText;
}

export interface LabelBlock {
  /** 每行文字的绘制中心点 */
  positions: LabelPoint[];
  /** 整块的包围尺寸(像素) */
  width: number;
  height: number;
}

/**
 * 整块文字的落位。
 *
 * 两条规则:
 *   一、首行与 anchor 对齐,整块向下生长。于是"一行的短标签"换成"多行的
 *   完整标题"时,两者的第一行在同一个位置上,交叉淡入读起来是文字从这一行
 *   往下长出来,而不是旁边另起一块;
 *   二、贴着视口边缘时把整块平移进来。位移只跟星体位置有关、与动画进度无关,
 *   所以不会出现"动画中途整块跳一下"。
 */
export function placeLabelBlock(input: LabelBlockInput): LabelBlock {
  const { lines, lineHeight, anchor, viewport, padding, measure } = input;
  if (!lines.length) return { positions: [], width: 0, height: 0 };

  const height = lineHeight * lines.length;
  const width = Math.max(...lines.map(measure));

  let top = anchor.y - lineHeight / 2;
  if (top + height > viewport.height - padding) top = viewport.height - padding - height;
  if (top < padding) top = padding;

  // 整块比视口还宽时只能居中;否则夹进可视区
  const x =
    width + padding * 2 > viewport.width
      ? viewport.width / 2
      : Math.min(Math.max(anchor.x, width / 2 + padding), viewport.width - width / 2 - padding);

  return {
    positions: lines.map((_, i) => ({ x, y: top + lineHeight * (i + 0.5) })),
    width,
    height,
  };
}
