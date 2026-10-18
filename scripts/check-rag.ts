/**
 * RAG 检索层校验。
 *
 * 这里不测"模型答得好不好"(那需要金标准与稳定模型),只测**检索是否可靠**:
 * 切块不改原文、分词认识中文、BM25 能把相关块排前面、语料里确实有
 * 摘要与关系证据、真实问题能检索到 YOLO。
 *
 * 运行:`pnpm check:rag`(已被 `pnpm check` 调用)
 */

import { buildBm25, searchBm25 } from "../src/lib/rag/bm25";
import { chunkText, tokenizeForSearch } from "../src/lib/rag/text";
import { citedNumbers } from "../src/server/rag/answer";
import { buildCorpus } from "../src/server/rag/corpus";
import { retrieveSources } from "../src/server/rag/retrieve";
import type { StarfieldPayload } from "../src/types/api";

import raw from "../data/starfields/sf-1483870316-mvag7epo.json";

const problems: string[] = [];
let checks = 0;

function expect(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) return;
  problems.push(`${name}${detail ? ` —— ${detail}` : ""}`);
}

// --------------------------------------------------------------------------
// 1. 切块:不丢原文、不出空块
// --------------------------------------------------------------------------
const longText =
  "目标检测是计算机视觉的核心任务之一。YOLO 把检测建模为回归问题。" +
  "它用单个神经网络从整幅图像直接预测边界框与类别概率。" +
  "SSD 则使用多尺度特征图,在不同尺度上预测不同大小的目标。" +
  "两者都属于单阶段检测器,但技术路线明显不同。" +
  "Cascade R-CNN 关注高质量检测,通过多级级联提升 IoU 阈值下的精度。";

const chunks = chunkText(longText, { target: 80, overlap: 20, minTail: 20 });
expect("长文本会切成多块", chunks.length > 1, `${chunks.length} 块`);
expect("切块不为空", chunks.every((c) => c.text.trim().length > 0));
expect("切块内容来自原文", chunks.every((c) => longText.includes(c.text)));
expect("切块按句尾收束", chunks.every((c) => /[。！？!?；;]$/.test(c.text.trim())));

// --------------------------------------------------------------------------
// 2. 分词:英文按词,中文按 bigram
// --------------------------------------------------------------------------
const tokens = tokenizeForSearch("YOLO 目标检测 baseline");
expect("英文词", tokens.includes("yolo") && tokens.includes("baseline"));
expect("中文二字组", tokens.includes("目标") && tokens.includes("检测"));

// --------------------------------------------------------------------------
// 3. BM25:相关文档排第一
// --------------------------------------------------------------------------
const docs = [
  { id: "yolo", tokens: tokenizeForSearch("YOLO 单阶段 检测 把检测建模为回归问题") },
  { id: "cascade", tokens: tokenizeForSearch("Cascade R-CNN 级联 高质量 检测") },
  { id: "gan", tokens: tokenizeForSearch("生成对抗网络 图像合成") },
];
const idx = buildBm25(docs);
const hits = searchBm25(idx, tokenizeForSearch("YOLO 基线"), 3);
expect("BM25 有命中", hits.length > 0);
expect("YOLO 文档排第一", hits[0]?.id === "yolo", hits.map((h) => h.id).join(","));

// --------------------------------------------------------------------------
// 4. 真实语料:标题 / 摘要 / 关系证据都在
// --------------------------------------------------------------------------
const payload = raw as unknown as StarfieldPayload;
const corpus = buildCorpus(payload);
expect("语料非空", corpus.chunks.length > 0, `${corpus.chunks.length} 块`);
expect("含论文元信息", corpus.chunks.some((c) => c.section === "title"));
expect("含摘要块", corpus.chunks.some((c) => c.section === "abstract"));
expect("含关系证据", corpus.chunks.some((c) => c.section === "relation"));
expect(
  "关系块带两篇论文",
  corpus.chunks.filter((c) => c.section === "relation").every((c) => c.paperIds.length === 2),
);

// --------------------------------------------------------------------------
// 5. 真实检索:问 YOLO 能查到 YOLO
// --------------------------------------------------------------------------
const sources = retrieveSources(payload, "哪篇论文是 YOLO 的基线?", 8);
expect("真实检索有结果", sources.length > 0);
expect(
  "结果里出现 YOLO",
  sources.some((s) => `${s.title} ${s.text}`.toLowerCase().includes("yolo")),
);
expect("结果带关系证据", sources.some((s) => s.section === "relation"));

// --------------------------------------------------------------------------
// 6. 角标解析
// --------------------------------------------------------------------------
expect("解析单角标", JSON.stringify(citedNumbers("结论[1]。", 3)) === "[1]");
expect("解析多角标", JSON.stringify(citedNumbers("甲[3][1],乙[1]。", 3)) === "[1,3]");
expect("越界角标被丢弃", JSON.stringify(citedNumbers("结论[9]。", 3)) === "[]");

if (problems.length > 0) {
  console.error("RAG 检索校验失败:\n" + problems.map((p) => `  x ${p}`).join("\n"));
  process.exit(1);
}

console.log(`RAG 检索一致(切块 / 分词 / 排序 / 语料 / 检索 / 角标 共 ${checks} 项)`);
