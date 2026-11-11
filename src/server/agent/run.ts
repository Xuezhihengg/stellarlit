/**
 * 站内 Agent 的入口:默认检索 → 规划 → MCP 执行 → 证据判定 → 再规划。
 *
 * 默认检索永远先做:它保证「即使规划器挂了,问答也还有证据底座」。
 * 工具调用只是增量,不是前置条件。闭环与停止条件在 `loop.ts`,这里只做装配。
 */

import type { StarfieldPayload } from "@/types/api";
import type {
  AskDecision,
  AskDecisionCode,
  AskImageIndexStats,
  AskStep,
  ImageEvidence,
} from "@/types/rag";

import type { ChatImage } from "../llm/client";
import { buildAskPrompt } from "../rag/answer";
import { indexAskImages, type ImageIndexResult } from "../rag/image-index";
import type { RetrievalDiagnostics, RetrievedSource } from "../rag/retrieve";
import { retrieveSourcesDetailed } from "../rag/retrieve";
import type { SafetyReport } from "../safety/guard";
import { assessEvidence } from "./assess";
import { executePlan } from "./execute";
import { runAgentRounds } from "./loop";
import { heuristicPlan, heuristicReplan, planAgentSteps, replanAgentSteps } from "./plan";

export interface AskAgentResult {
  sources: RetrievedSource[];
  external: string[];
  prompt: string;
  trace: AskStep[];
  decisions: AskDecision[];
  rounds: number;
  stopReason: AskDecisionCode;
  /** 计划了几步;0 表示规划失败或模型认为不需要工具 */
  planned: number;
  /** 默认混合检索的召回诊断,用于解释停止条件与低置信提示。 */
  retrieval: RetrievalDiagnostics;
  /** 从附图抽取出的 OCR / 表格 / 图表块;没有图片时为空。 */
  imageEvidence: ImageEvidence[];
  imageStats: AskImageIndexStats;
}

type ActivitySink = (step: AskStep) => void;
type DecisionSink = (decision: AskDecision) => void;

export async function runAskAgent(input: {
  /** 当前登录账号;规划、工具与向量检索都按它隔离 */
  ownerId: string;
  payload: StarfieldPayload;
  question: string;
  images?: ChatImage[];
  /** 输入护栏的判定结果;命中越权语句时会把中性声明一起写进提示词 */
  safety?: SafetyReport;
  onActivity: ActivitySink;
  onDecision?: DecisionSink;
  /** 浏览器断开时中止仍在进行的模型 / 工具 / 向量请求。 */
  signal?: AbortSignal;
}): Promise<AskAgentResult> {
  const { ownerId, payload, question, images = [], safety, onActivity, onDecision, signal } = input;

  const imageTask: Promise<ImageIndexResult> = images.length
    ? (() => {
        onActivity({
          slot: -1,
          round: 1,
          tool: "index_image_evidence",
          label: "解析图像证据",
          state: "running",
          detail: `${images.length} 张`,
          why: "先做 OCR、表格与图表数据抽取,再让回答引用具体图像块",
        });
        return indexAskImages(ownerId, images, question, signal)
          .then((result) => {
            onActivity({
              slot: -1,
              round: 1,
              tool: "index_image_evidence",
              label: "解析图像证据",
              state: result.evidence.length ? "done" : "failed",
              detail: `${images.length} 张 · ${result.stats.chunks} 块 · ${result.stats.numbers} 个数值${
                result.stats.cached ? ` · ${result.stats.cached} 缓存` : ""
              }${result.stats.degraded ? " · 部分降级" : ""}`,
              why: "图像块按问题重排后进入回答上下文,点击图号可定位原图区域",
            });
            return result;
          })
          .catch(() => {
            onActivity({
              slot: -1,
              round: 1,
              tool: "index_image_evidence",
              label: "解析图像证据",
              state: "failed",
              detail: "视觉抽取失败",
              why: "本次仍会把原图作为弱证据,但无法引用具体图像块",
            });
            return {
              evidence: [],
              stats: {
                images: images.length,
                chunks: 0,
                numbers: 0,
                cached: 0,
                degraded: true,
              },
            };
          });
      })()
    : Promise.resolve({
        evidence: [],
        stats: { images: 0, chunks: 0, numbers: 0, cached: 0, degraded: false },
      });

  const { sources: base, diagnostics: retrieval } = await retrieveSourcesDetailed(
    payload,
    question,
    8,
    { ownerId, signal },
  );
  const plannedTask = planAgentSteps(ownerId, payload, question, signal);
  // 停止判定要同时看文字证据与图像块:图里已经覆盖问题,就不再多跑检索。
  const imageIndex = await imageTask;
  const planned = await plannedTask;
  const baseEnough = assessEvidence(
    payload,
    question,
    base,
    [],
    retrieval,
    imageIndex.evidence,
  ).enough;

  // 默认检索已经足够时不再多跑工具;模型不可用或计划为空且证据不足时才兜底。
  const initialPlan = planned.fromModel
    ? planned.steps.length || baseEnough
      ? planned
      : { steps: heuristicPlan(payload, question), fromModel: true }
    : baseEnough
      ? { steps: [], fromModel: false }
      : { steps: heuristicPlan(payload, question), fromModel: false };

  const outcome = await runAgentRounds({
    payload,
    question,
    base,
    retrieval,
    imageEvidence: imageIndex.evidence,
    initialPlan,
    execute: (steps, round, startSlot) =>
      executePlan(payload, steps, onActivity, { ownerId, round, startSlot, signal }),
    replan: async (request) => {
      // 初始规划都没能调用模型时,不再等第二次超时,直接走确定性补查。
      if (planned.fromModel) {
        const next = await replanAgentSteps({
          ownerId,
          payload,
          question,
          round: request.round,
          executed: request.executed,
          trace: request.trace,
          sources: request.sources,
          external: request.external,
          assessment: request.assessment,
          signal,
        });
        if (next.fromModel && next.steps.length) return next;
      }
      return {
        steps: heuristicReplan({
          payload,
          question,
          assessment: request.assessment,
          executed: request.executed,
        }),
        fromModel: false,
      };
    },
    onActivity,
    onDecision,
  });

  return {
    sources: outcome.sources,
    external: outcome.external,
    prompt: buildAskPrompt(
      question,
      outcome.sources,
      images.length,
      outcome.external,
      retrieval,
      imageIndex.evidence,
      safety,
    ),
    trace: outcome.trace,
    decisions: outcome.decisions,
    rounds: outcome.rounds,
    stopReason: outcome.stopReason,
    planned: initialPlan.steps.length,
    retrieval,
    imageEvidence: imageIndex.evidence,
    imageStats: imageIndex.stats,
  };
}
