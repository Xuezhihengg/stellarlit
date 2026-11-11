/**
 * 多模态图像证据自检。
 *
 * 不调用视觉模型,只验证:结构化结果能不能稳定切成 OCR / 表格 / 图表 / 数值块,
 * 区域坐标会不会被归一化,问题意图能不能选对证据,提示词与降级答案有没有引用图号。
 */

import raw from "../data/starfields/sf-1483870316-mvag7epo.json";
import { assessEvidence } from "../src/server/agent/assess";
import { buildAskPrompt, extractiveAnswer } from "../src/server/rag/answer";
import {
  buildImageEvidence,
  normalizeRegion,
  selectImageEvidence,
  type ImageAnalysis,
} from "../src/server/rag/image-index";
import type { StarfieldPayload } from "../src/types/api";

const problems: string[] = [];
let checks = 0;

function expect(name: string, ok: boolean, detail = "") {
  checks++;
  if (!ok) problems.push(`${name}${detail ? ` —— ${detail}` : ""}`);
}

const analysis: ImageAnalysis = {
  caption: "图 1 展示不同检测方法在 COCO 上的 F1 与 IoU 曲线。",
  ocr: [
    {
      text: "F1-score 0.87; AP 42.1%; IoU 0.50",
      region: { x: 10, y: 20, width: 60, height: 12 },
    },
    {
      text: "Ours 相比 Baseline 提升 3.2 个点",
      region: { x: 8, y: 80, width: 80, height: 10 },
    },
  ],
  charts: [
    {
      title: "F1 vs IoU",
      type: "line",
      xAxis: "IoU",
      yAxis: "F1-score",
      series: [
        {
          label: "Ours",
          points: [
            { x: 0.5, y: 0.87 },
            { x: 0.75, y: 0.64 },
          ],
        },
        {
          label: "Baseline",
          points: [
            { x: 0.5, y: 0.81 },
            { x: 0.75, y: 0.58 },
          ],
        },
      ],
      trend: "IoU 提高时 F1 下降,但 Ours 始终高于 Baseline",
      region: { x: 20, y: 25, width: 70, height: 60 },
    },
  ],
  keyValues: [
    { label: "AP", value: "42.1", unit: "%", region: { x: 12, y: 30, width: 10, height: 8 } },
  ],
};

const evidence = buildImageEvidence(analysis, 0, "result-chart.png", "abcdef1234567890");
expect("图像至少切出多块", evidence.length >= 5, String(evidence.length));
expect("图号从图1-1开始", evidence[0]?.label === "图1-1", evidence[0]?.label);
expect("OCR 块存在", evidence.some((item) => item.kind === "ocr"));
expect("图表块存在", evidence.some((item) => item.kind === "chart" || item.kind === "trend"));
expect("数值块存在", evidence.some((item) => item.kind === "numeric"));
expect("OCR 数字被抽出", evidence.some((item) => item.numbers.includes("0.87")));
expect("百分比被抽出", evidence.some((item) => item.numbers.includes("42.1%")), JSON.stringify(evidence.map((item) => item.numbers)));

const ocr = evidence.find((item) => item.kind === "ocr");
expect("0-100 坐标被归一化", Boolean(ocr?.region && ocr.region.x <= 1 && ocr.region.width <= 1));
expect("区域保留宽度", Boolean(ocr?.region && ocr.region.width > 0.5));
expect(
  "百分比区域转换正确",
  Boolean(
    normalizeRegion({ x: 20, y: 30, width: 40, height: 50 })?.x === 0.2 &&
      normalizeRegion({ x: 20, y: 30, width: 40, height: 50 })?.height === 0.5,
  ),
);

const trendQuestion = "这张图里 F1 随 IoU 变化的趋势是什么?";
const trendPicked = selectImageEvidence(evidence, trendQuestion);
expect("趋势问题保留概述块", trendPicked.some((item) => item.kind === "caption"));
expect(
  "趋势问题选中图表/趋势块",
  trendPicked.some((item) => item.kind === "chart" || item.kind === "trend"),
);

const ocrPicked = selectImageEvidence(evidence, "图中写了什么文字和标签?");
expect("文字问题选中 OCR 块", ocrPicked.some((item) => item.kind === "ocr"));

const prompt = buildAskPrompt(trendQuestion, [], 1, [], undefined, trendPicked);
expect("提示词包含图像证据段", prompt.includes("<图像证据>"));
expect("提示词包含图号", /\[图1-\d+\]/.test(prompt));
expect("提示词要求用图号引用", prompt.includes("引用图像结论时用 [图1-1]"));

const fallback = extractiveAnswer([], trendPicked);
expect("降级答案保留图号", /\[图1-\d+\]/.test(fallback));
expect("降级答案包含数值", fallback.includes("0.87") || fallback.includes("42.1"));

const assessment = assessEvidence(
  raw as StarfieldPayload,
  trendQuestion,
  [],
  [],
  undefined,
  trendPicked,
);
expect("图像块参与停止判定", assessment.enough, JSON.stringify(assessment.gaps));
expect("图块统计进入决策", assessment.stats.imageChunks === trendPicked.length);
expect("图像数量进入决策", assessment.stats.images === 1);

if (problems.length > 0) {
  console.error("多模态图像证据校验失败:\n" + problems.map((problem) => `  x ${problem}`).join("\n"));
  process.exit(1);
}

console.log(`多模态图像证据一致(OCR / 图表 / 数值 / 区域 / 重排 / 引用 共 ${checks} 项)`);
