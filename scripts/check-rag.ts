/**
 * RAG 检索层校验。
 *
 * 这里不测「模型答得好不好」(那需要金标准与稳定模型),只测检索是否可靠:
 * 切块不改原文、分词认识中文、BM25 排序正确、RRF 能融合两路名次、
 * 比较题会拆子问题、混合召回真的走了向量、三篇论文能补到多锚点关系、
 * 证据压缩不丢问题命中的句子、低置信结果会被门槛拦住。
 *
 * 运行:`pnpm check:rag`(已被 `pnpm check` 调用)
 */

import { buildBm25, searchBm25 } from "../src/lib/rag/bm25";
import { cosineSimilarity, reciprocalRankFusion } from "../src/lib/rag/hybrid";
import { chunkText, tokenizeForSearch } from "../src/lib/rag/text";
import { buildAskPrompt, citedNumbers, compressEvidence } from "../src/server/rag/answer";
import { buildCorpus } from "../src/server/rag/corpus";
import { buildQueryPlan } from "../src/server/rag/query";
import { retrieveSourcesDetailed } from "../src/server/rag/retrieve";
import type { EmbeddingProvider } from "../src/server/rag/embedding";
import type { StarfieldPayload } from "../src/types/api";
import type { PaperNode } from "../src/types/kg";

import raw from "../data/starfields/sf-1483870316-mvag7epo.json";

const problems: string[] = [];
let checks = 0;

function expect(name: string, ok: boolean, detail = "") {
  checks++;
  if (ok) return;
  problems.push(`${name}${detail ? ` —— ${detail}` : ""}`);
}

function fakeEmbeddingProvider(): EmbeddingProvider {
  const dimensions = 96;
  const hash = (token: string): number => {
    let value = 0;
    for (const char of token) value = (value * 31 + char.charCodeAt(0)) % dimensions;
    return value;
  };
  return {
    id: "check:bag-of-words",
    async embed(texts) {
      return texts.map((text) => {
        const vector = Array.from({ length: dimensions }, () => 0);
        for (const token of tokenizeForSearch(text)) vector[hash(token)]! += 1;
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
        return vector.map((value) => value / norm);
      });
    },
  };
}

async function main(): Promise<void> {
  // ------------------------------------------------------------------------
  // 1. 切块:不丢原文、不出空块
  // ------------------------------------------------------------------------
  const longText =
    "目标检测是计算机视觉的核心任务之一。YOLO 把检测建模为回归问题。" +
    "它用单个神经网络从整幅图像直接预测边界框与类别概率。" +
    "SSD 则使用多尺度特征图,在不同尺度上预测不同大小的目标。" +
    "两者都属于单阶段检测器,但技术路线明显不同。" +
    "Cascade R-CNN 关注高质量检测,通过多级级联提升 IoU 阈值下的精度。";

  const chunks = chunkText(longText, { target: 80, overlap: 20, minTail: 20 });
  expect("长文本会切成多块", chunks.length > 1, `${chunks.length} 块`);
  expect("切块不为空", chunks.every((chunk) => chunk.text.trim().length > 0));
  expect("切块内容来自原文", chunks.every((chunk) => longText.includes(chunk.text)));
  expect("切块按句尾收束", chunks.every((chunk) => /[。！？!?；;]$/.test(chunk.text.trim())));

  // ------------------------------------------------------------------------
  // 2. 分词:英文按词,中文按 bigram
  // ------------------------------------------------------------------------
  const tokens = tokenizeForSearch("YOLO 目标检测 baseline");
  expect("英文词", tokens.includes("yolo") && tokens.includes("baseline"));
  expect("中文二字组", tokens.includes("目标") && tokens.includes("检测"));

  // ------------------------------------------------------------------------
  // 3. BM25 + RRF + 余弦:基础排序单元
  // ------------------------------------------------------------------------
  const docs = [
    { id: "yolo", tokens: tokenizeForSearch("YOLO 单阶段 检测 把检测建模为回归问题") },
    { id: "cascade", tokens: tokenizeForSearch("Cascade R-CNN 级联 高质量 检测") },
    { id: "gan", tokens: tokenizeForSearch("生成对抗网络 图像合成") },
  ];
  const idx = buildBm25(docs);
  const hits = searchBm25(idx, tokenizeForSearch("YOLO 基线"), 3);
  expect("BM25 有命中", hits.length > 0);
  expect("YOLO 文档排第一", hits[0]?.id === "yolo", hits.map((hit) => hit.id).join(","));

  const fused = reciprocalRankFusion([
    { ids: ["a", "b"] },
    { ids: ["b", "c"] },
  ]);
  expect(
    "RRF 让两路共识排第一",
    [...fused.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] === "b",
  );
  expect("余弦相同向量为 1", Math.abs(cosineSimilarity([1, 0], [1, 0]) - 1) < 1e-9);
  expect("余弦正交向量为 0", Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);

  // ------------------------------------------------------------------------
  // 4. 真实语料:标题 / 摘要 / 关系证据都在
  // ------------------------------------------------------------------------
  const payload = raw as unknown as StarfieldPayload;
  const papers = payload.graph.nodes.filter((node): node is PaperNode => node.kind === "paper");
  const corpus = buildCorpus(payload);
  expect("语料非空", corpus.chunks.length > 0, `${corpus.chunks.length} 块`);
  expect("含论文元信息", corpus.chunks.some((chunk) => chunk.section === "title"));
  expect("含摘要块", corpus.chunks.some((chunk) => chunk.section === "abstract"));
  expect("含关系证据", corpus.chunks.some((chunk) => chunk.section === "relation"));
  expect(
    "关系块带两篇论文",
    corpus.chunks
      .filter((chunk) => chunk.section === "relation")
      .every((chunk) => chunk.paperIds.length === 2),
  );

  // ------------------------------------------------------------------------
  // 5. 比较题拆解:三篇论文 → 每篇子问题 + 一条共同任务对比
  // ------------------------------------------------------------------------
  const comparisonQuestion = `${papers[0]!.title}、${papers[1]!.title} 和 ${papers[2]!.title} 有哪些同任务但不同路线的工作?`;
  const plan = buildQueryPlan(payload, comparisonQuestion);
  expect("比较意图被识别", plan.intent === "comparison", plan.intent);
  expect("三篇论文都被点名", plan.mentionedPaperIds.length >= 3, String(plan.mentionedPaperIds.length));
  expect("生成了子问题", plan.variants.some((variant) => variant.kind === "subquestion"));
  expect("原始问题排第一路", plan.variants[0]?.kind === "original");
  expect("同义改写进入召回", plan.variants.some((variant) => /different approach/.test(variant.text)));

  // ------------------------------------------------------------------------
  // 6. 词面检索仍可用:没有向量配置时自动降级
  // ------------------------------------------------------------------------
  const lexical = await retrieveSourcesDetailed(payload, "哪篇论文是 YOLO 的基线?", 8, {
    embedding: null,
  });
  expect("词面检索有结果", lexical.sources.length > 0);
  expect("降级模式如实标注", lexical.diagnostics.mode === "lexical", lexical.diagnostics.mode);
  expect(
    "结果里出现 YOLO",
    lexical.sources.some((source) =>
      `${source.title} ${source.text}`.toLowerCase().includes("yolo"),
    ),
  );
  expect("结果带关系证据", lexical.sources.some((source) => source.section === "relation"));

  // ------------------------------------------------------------------------
  // 7. 混合召回:注入确定性向量,确认向量路真的进入 RRF
  // ------------------------------------------------------------------------
  const hybrid = await retrieveSourcesDetailed(payload, "YOLO 单阶段检测 回归", 8, {
    embedding: fakeEmbeddingProvider(),
  });
  expect("混合模式被启用", hybrid.diagnostics.mode === "hybrid", hybrid.diagnostics.mode);
  expect("向量路有候选", hybrid.diagnostics.vectorHits > 0, String(hybrid.diagnostics.vectorHits));
  expect("混合召回有结果", hybrid.sources.length > 0);

  // ------------------------------------------------------------------------
  // 8. 图扩展:三篇论文比较时,关系证据不能只围着一篇锚点转
  // ------------------------------------------------------------------------
  const noGraph = await retrieveSourcesDetailed(payload, comparisonQuestion, 10, {
    embedding: null,
    graph: false,
  });
  const withGraph = await retrieveSourcesDetailed(payload, comparisonQuestion, 10, {
    embedding: null,
    graph: true,
  });
  expect("关图扩展时不补关系", noGraph.diagnostics.graphRelations === 0, String(noGraph.diagnostics.graphRelations));
  expect("开图扩展后有多个关系块", withGraph.diagnostics.graphRelations >= 2, String(withGraph.diagnostics.graphRelations));
  expect(
    "三篇点名论文都被覆盖",
    plan.mentionedPaperIds.every((id) =>
      withGraph.sources.some((source) => source.paperIds.includes(id)),
    ),
  );
  expect(
    "至少覆盖两对点名论文的关系",
    withGraph.sources.filter((source) => source.section === "relation").length >= 2,
  );

  // ------------------------------------------------------------------------
  // 9. 证据压缩:长文本里与问题相关的后半段不能丢
  // ------------------------------------------------------------------------
  const longEvidence =
    "背景段落介绍研究动机与历史。".repeat(24) +
    "目标检测的关键结论是把检测建模为单阶段回归。";
  const compressed = compressEvidence(longEvidence, "单阶段回归 关键结论", 180);
  expect("压缩后长度受控", compressed.length <= 180, String(compressed.length));
  expect("问题命中的尾部证据被保留", compressed.includes("单阶段回归"));

  // ------------------------------------------------------------------------
  // 10. 低置信门槛:完全无关的问题不应被判为证据足够
  // ------------------------------------------------------------------------
  const irrelevant = await retrieveSourcesDetailed(payload, "量子纠缠实验中的超导材料相变", 8, {
    embedding: null,
  });
  expect("无关问题低置信", !irrelevant.diagnostics.enough, JSON.stringify(irrelevant.diagnostics));

  const prompt = buildAskPrompt("量子纠缠实验中的超导材料相变", irrelevant.sources, 0, [], irrelevant.diagnostics);
  expect("低置信状态进入提示词", prompt.includes("<检索状态>"));

  // ------------------------------------------------------------------------
  // 11. 角标解析
  // ------------------------------------------------------------------------
  expect("解析单角标", JSON.stringify(citedNumbers("结论[1]。", 3)) === "[1]");
  expect("解析多角标", JSON.stringify(citedNumbers("甲[3][1],乙[1]。", 3)) === "[1,3]");
  expect("越界角标被丢弃", JSON.stringify(citedNumbers("结论[9]。", 3)) === "[]");

  if (problems.length > 0) {
    console.error("RAG 检索校验失败:\n" + problems.map((problem) => `  x ${problem}`).join("\n"));
    process.exit(1);
  }

  console.log(
    `RAG 检索一致(切块 / 分词 / 融合 / 查询规划 / 混合召回 / 图扩展 / 压缩 / 门槛 / 角标 共 ${checks} 项)`,
  );
}

main().catch((error: unknown) => {
  console.error("RAG 检索校验崩溃:", error);
  process.exit(1);
});
