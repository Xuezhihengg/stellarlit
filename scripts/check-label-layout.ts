/**
 * 标签排版校验。
 *
 * 为什么需要它:这套排版是**给动画用的** —— 选中进度从 0 到 1 的每一帧,
 * 它都必须给出同一份断行、同一个行距。一旦有人把折行改回"拿当帧字号去量",
 * 浏览器里的表现是"点击后标题在框里不停重排",看上去只是"丑",
 * 看不出是哪一行代码;在这里跑一次就定位了。
 *
 * 量宽用固定桩:真实字体是比例字体,但断行的正确性是**纯几何**,
 * 与具体字体无关 —— 用桩反而让断言稳定。
 *
 * 运行:`pnpm check:label`(已被 `pnpm check` 调用)
 */

import { placeLabelBlock, wrapByWidth } from "../src/lib/design/label-layout";

/** 确定性量宽:每个字符 7px。 */
const measure = (s: string) => [...s].length * 7;

const MAX_W = 300;
const MAX_LINES = 3;
const LINE_H = 18.5;
const PAD = 14;

const problems: string[] = [];
let checks = 0;

function expect(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) return;
  problems.push(`${name}${detail ? ` —— ${detail}` : ""}`);
}

const widthOf = (s: string) => measure(s);

// --------------------------------------------------------------------------
// 1. 短标题:一行,一个字符都不改
// --------------------------------------------------------------------------
const short = "Green AI";
const shortLines = wrapByWidth(short, MAX_W, MAX_LINES, measure);
expect("短标题不换行", shortLines.length === 1, `得到 ${shortLines.length} 行`);
expect("短标题不被截断", shortLines[0] === short, `得到 "${shortLines[0]}"`);

// --------------------------------------------------------------------------
// 2. 长英文标题:按词断行,最多三行,超出收省略号
// --------------------------------------------------------------------------
const long =
  "YOLO-v1 to YOLO-v8, the Rise of YOLO and Its Complementary Nature toward Digital Manufacturing and Industrial Defect Detection";
const longLines = wrapByWidth(long, MAX_W, MAX_LINES, measure);
expect("长标题不超过最大行数", longLines.length <= MAX_LINES, `${longLines.length} 行`);
expect("长标题每行不超栏宽", longLines.every((l) => widthOf(l) <= MAX_W), longLines.join(" / "));
expect("长标题末行收省略号", longLines[longLines.length - 1]?.endsWith("…") === true);
expect(
  "长标题不丢词(省略号前是完整词)",
  longLines.slice(0, -1).every((l) => long.includes(l)),
  longLines.join(" / "),
);

// --------------------------------------------------------------------------
// 3. 中文标题整句没有空格:按字符硬断,而不是顶穿栏宽
// --------------------------------------------------------------------------
const cjk =
  "面向工业缺陷检测的深度学习目标检测方法综述与展望:从YOLO系列到多模态大模型驱动的检测范式转变";
const cjkLines = wrapByWidth(cjk, MAX_W, MAX_LINES, measure);
expect("中文标题会断行", cjkLines.length > 1, `${cjkLines.length} 行`);
expect(
  "中文标题每行不超栏宽",
  cjkLines.every((l) => widthOf(l) <= MAX_W),
  cjkLines.map(widthOf).join(","),
);

// --------------------------------------------------------------------------
// 4. 排版稳定:同一输入永远是同一份断行(动画全程不重排)
// --------------------------------------------------------------------------
const again = wrapByWidth(long, MAX_W, MAX_LINES, measure);
expect("同一输入得到同一份断行", JSON.stringify(again) === JSON.stringify(longLines));

// --------------------------------------------------------------------------
// 5. 落位:首行对齐 anchor,整块被夹在可视区内
// --------------------------------------------------------------------------
const viewport = { width: 1440, height: 900 };
const centered = placeLabelBlock({
  lines: longLines,
  lineHeight: LINE_H,
  anchor: { x: 720, y: 450 },
  viewport,
  padding: PAD,
  measure,
});
expect("首行与 anchor 同一行", centered.positions[0]?.y === 450, `${centered.positions[0]?.y}`);
expect("居中的块不左右偏移", centered.positions.every((p) => p.x === 720));

const atCorner = placeLabelBlock({
  lines: longLines,
  lineHeight: LINE_H,
  anchor: { x: 1432, y: 894 },
  viewport,
  padding: PAD,
  measure,
});
const half = atCorner.width / 2;
expect(
  "贴边时整块仍在视口内(横向)",
  atCorner.positions.every((p) => p.x - half >= PAD && p.x + half <= viewport.width - PAD),
  `x=${atCorner.positions[0]?.x} width=${atCorner.width}`,
);
const cornerTop = (atCorner.positions[0]?.y ?? 0) - LINE_H / 2;
const cornerBottom =
  (atCorner.positions[atCorner.positions.length - 1]?.y ?? 0) + LINE_H / 2;
expect(
  "贴边时整块仍在视口内(纵向)",
  cornerTop >= PAD && cornerBottom <= viewport.height - PAD,
  `top=${cornerTop} bottom=${cornerBottom}`,
);

if (problems.length > 0) {
  console.error("标签排版校验失败:\n" + problems.map((p) => `  x ${p}`).join("\n"));
  process.exit(1);
}

console.log(`标签排版一致(折行 / 稳定 / 落位 共 ${checks} 项)`);
