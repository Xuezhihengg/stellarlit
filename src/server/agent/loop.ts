/**
 * Agent 闭环:规划 → 执行 → 判定 → 再规划 → 停止。
 *
 * 和「一次性规划」的区别只有一件事:第一轮的工具结果会进入第二轮规划,
 * 并且每轮结束都要给出明确的停止理由。所有判定都是确定性的,模型只负责
 * 「补查什么」,不能决定「证据够不够」—— 后者必须可解释、可复现。
 */

import type { StarfieldPayload } from "@/types/api";
import type { AskDecision, AskDecisionCode, AskStep, ImageEvidence } from "@/types/rag";

import type { RagSource } from "../rag/corpus";
import type { RetrievalDiagnostics, RetrievedSource } from "../rag/retrieve";
import { assessEvidence, type EvidenceAssessment } from "./assess";
import { mergeExternal, mergeSources } from "./evidence";
import type { PlanResult, PlannedStep } from "./plan";

export interface ReplanRequest {
  round: number;
  executed: PlannedStep[];
  trace: AskStep[];
  sources: RetrievedSource[];
  external: string[];
  assessment: EvidenceAssessment;
}

export interface AgentExecution {
  sources: RagSource[];
  external: string[];
  trace: AskStep[];
}

export interface AgentLoopInput {
  payload: StarfieldPayload;
  question: string;
  base: RetrievedSource[];
  /** 默认混合检索的诊断:用于低置信门槛,不参与工具执行。 */
  retrieval?: RetrievalDiagnostics;
  /** 附图抽取出的证据块:参与覆盖率和停止判定 */
  imageEvidence?: ImageEvidence[];
  initialPlan: PlanResult;
  execute: (steps: PlannedStep[], round: number, startSlot: number) => Promise<AgentExecution>;
  replan: (request: ReplanRequest) => Promise<PlanResult>;
  onActivity?: (step: AskStep) => void;
  onDecision?: (decision: AskDecision) => void;
  /** 默认两轮:初始规划 + 一次补查。 */
  maxRounds?: number;
  /** 默认五步:两轮共享的工具调用预算。 */
  maxSteps?: number;
}

export interface AgentLoopResult {
  sources: RetrievedSource[];
  external: string[];
  trace: AskStep[];
  decisions: AskDecision[];
  rounds: number;
  stopReason: AskDecisionCode;
}

function makeDecision(
  round: number,
  action: AskDecision["action"],
  code: AskDecisionCode,
  reason: string,
  assessment: EvidenceAssessment,
): AskDecision {
  return { round, action, code, reason, gaps: assessment.gaps, stats: assessment.stats };
}

export async function runAgentRounds(input: AgentLoopInput): Promise<AgentLoopResult> {
  const maxRounds = input.maxRounds ?? 2;
  const maxSteps = input.maxSteps ?? 5;
  const trace: AskStep[] = [];
  const decisions: AskDecision[] = [];
  const executed: PlannedStep[] = [];
  let additions: RagSource[] = [];
  let externalGroups: string[] = [];
  let sources = mergeSources(input.base, additions);
  let external = mergeExternal(externalGroups);
  let assessment = assessEvidence(
    input.payload,
    input.question,
    sources,
    external,
    input.retrieval,
    input.imageEvidence,
  );
  let rounds = 0;
  let stopReason: AskDecisionCode = "max_rounds";

  const emitDecision = (decision: AskDecision) => {
    decisions.push(decision);
    input.onDecision?.(decision);
  };

  for (let round = 1; round <= maxRounds; round++) {
    rounds = round;
    const plan =
      round === 1
        ? input.initialPlan
        : await input.replan({
            round,
            executed: [...executed],
            trace: [...trace],
            sources,
            external,
            assessment,
          });

    if (!plan.steps.length) {
      stopReason = assessment.enough ? "enough" : "no_more_tools";
      emitDecision(
        makeDecision(
          round,
          "stop",
          stopReason,
          assessment.enough
            ? "默认检索已覆盖问题所需,停止补充检索"
            : round === 1
              ? "没有可执行的检索步骤,直接使用默认检索"
              : "没有更多可补充的查询,停止补充检索",
          assessment,
        ),
      );
      break;
    }

    const remaining = maxSteps - executed.length;
    if (remaining <= 0) {
      stopReason = "max_steps";
      emitDecision(
        makeDecision(round, "stop", stopReason, `已达到 ${maxSteps} 步工具调用上限`, assessment),
      );
      break;
    }

    const steps = plan.steps.slice(0, remaining);
    const beforeIds = new Set(sources.map((source) => source.chunkId));
    const beforeExternal = external.length;
    const outcome = await input.execute(steps, round, executed.length);

    trace.push(...outcome.trace);
    executed.push(...steps);
    additions = [...additions, ...outcome.sources];
    externalGroups = [...externalGroups, ...outcome.external];
    sources = mergeSources(input.base, additions);
    external = mergeExternal(externalGroups);
    assessment = assessEvidence(
      input.payload,
      input.question,
      sources,
      external,
      input.retrieval,
      input.imageEvidence,
    );

    const addedSources = sources.filter((source) => !beforeIds.has(source.chunkId)).length;
    const addedExternal = Math.max(0, external.length - beforeExternal);
    const madeProgress = addedSources > 0 || addedExternal > 0;

    if (assessment.enough) {
      stopReason = "enough";
      emitDecision(
        makeDecision(round, "stop", stopReason, "证据已覆盖问题所需,停止继续检索", assessment),
      );
      break;
    }

    if (round >= maxRounds) {
      stopReason = madeProgress ? "max_rounds" : "no_new_evidence";
      emitDecision(
        makeDecision(
          round,
          "stop",
          stopReason,
          madeProgress
            ? `已完成 ${round} 轮检索,${assessment.gaps[0] ?? "带着现有证据回答"}`
            : "本轮没有新增证据,停止以避免重复检索",
          assessment,
        ),
      );
      break;
    }

    if (executed.length >= maxSteps) {
      stopReason = "max_steps";
      emitDecision(
        makeDecision(round, "stop", stopReason, `已达到 ${maxSteps} 步工具调用上限`, assessment),
      );
      break;
    }

    emitDecision(
      makeDecision(
        round,
        "continue",
        "continue",
        `仍缺${assessment.gaps[0] ?? "部分证据"},继续补充检索`,
        assessment,
      ),
    );
  }

  return { sources, external, trace, decisions, rounds, stopReason };
}
