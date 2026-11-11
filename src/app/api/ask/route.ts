import { NextResponse } from "next/server";
import { z } from "zod";

import { runAskAgent } from "@/server/agent/run";
import { streamChat } from "@/server/llm/client";
import {
  ASK_SYSTEM,
  citedNumbers,
  extractSuggestions,
  extractiveAnswer,
} from "@/server/rag/answer";
import { requireUser } from "@/server/auth/require";
import { loadStarfield } from "@/server/starfield/store";
import { screenQuestion } from "@/server/safety/guard";
import { beginRun, checkBudget, checkLimit } from "@/server/safety/limits";
import { ASK_JSON_BYTES, readJsonLimited } from "@/server/security/request-body";
import { MAX_ASK_IMAGES, type AskEvent } from "@/types/rag";

export const dynamic = "force-dynamic";

const imageSchema = z.object({
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  data: z
    .string()
    .min(1)
    // 与客户端 4MB 原图对齐:base64 约为原图的 4/3,再留一点余量
    .max(5_600_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "图片内容不是有效的 base64"),
  name: z.string().max(160),
});

const bodySchema = z.object({
  starfieldId: z.string().min(1),
  question: z.string().trim().min(2).max(500),
  images: z.array(imageSchema).max(MAX_ASK_IMAGES).optional(),
});

/**
 * Agent 增强问答(流式)。
 *
 * 事件顺序:activity* / decision* → sources → delta* → done。
 *
 * 取数不再是一条写死的链路:模型先规划要查什么,再通过 MCP 调用星空工具
 * (检索原文 / 查关系证据 / 展开引文)。前端会在等待期间显示这条轨迹,
 * 让「它自己决定查了什么」变成可见过程,而不是黑箱。
 *
 * 规划失败时自动退回「默认检索」,与之前的 RAG 路径完全一致。
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await requireUser(req);
  if (!auth.ok) return auth.response;

  // 先限流再解析:大请求体在 req.json() 时就已经进内存了,不能等解析完才拦。
  const limit = checkLimit(req, "ask");
  if (!limit.ok) {
    return NextResponse.json(
      { error: limit.message ?? "请求过于频繁", hint: limit.hint, code: limit.code },
      {
        status: 429,
        headers: limit.retryAfterSec
          ? { "retry-after": String(limit.retryAfterSec) }
          : undefined,
      },
    );
  }

  const budget = await checkBudget(auth.user.id);
  if (!budget.ok) {
    return NextResponse.json(
      { error: budget.message, hint: budget.hint, code: budget.code, usage: budget.snapshot },
      { status: 429 },
    );
  }

  const body = await readJsonLimited(req, ASK_JSON_BYTES);
  if (!body.ok) {
    return NextResponse.json(
      { error: body.error, code: body.code },
      { status: body.status },
    );
  }
  const parsed = bodySchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "问题格式不正确", code: "bad_request" },
      { status: 400 },
    );
  }

  const { starfieldId } = parsed.data;
  // 输入护栏:剥不可见字符、压成单行、识别提示注入;命中密钥套取直接拒绝。
  const safety = screenQuestion(parsed.data.question);
  if (safety.level === "blocked") {
    return NextResponse.json(
      {
        error: safety.reason ?? "这条请求未通过安全检查。",
        hint: "可以换个问法,或直接问论文里的方法与结论。",
        code: "safety_blocked",
      },
      { status: 422 },
    );
  }
  const question = safety.question;
  const images = parsed.data.images ?? [];
  const payload = await loadStarfield(starfieldId, auth.user.id);
  if (!payload) {
    return NextResponse.json(
      { error: "这片星空不存在或已被删除", code: "not_found" },
      { status: 404 },
    );
  }

  const encoder = new TextEncoder();
  // 浏览器关页 / 点停止时,ReadableStream.cancel() 和 req.signal 都会触发这个控制器
  const abort = new AbortController();
  const onRequestAbort = () => abort.abort();
  if (req.signal.aborted) abort.abort();
  else req.signal.addEventListener("abort", onRequestAbort, { once: true });
  let closed = false;
  let releaseRun: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      releaseRun = beginRun(req, "ask");
      const send = (event: AskEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      try {
        // 护栏也是决策轨迹的一步:让「检查过、检查到了什么」可见,而不是黑箱。
        send({
          type: "activity",
          step: {
            slot: -2,
            round: 1,
            tool: "screen_input",
            label: "安全护栏",
            state: "done",
            detail: safety.summary,
            why: safety.findings.length
              ? "输入里的指令语句被当作数据隔离,不改变系统规则"
              : "已剥掉不可见字符,问题按纯数据送入模型",
          },
        });

        if (abort.signal.aborted) return;

        const agent = await runAskAgent({
          ownerId: auth.user.id,
          payload,
          question,
          images,
          safety,
          signal: abort.signal,
          onActivity: (step) => send({ type: "activity", step }),
          onDecision: (decision) => send({ type: "decision", decision }),
        });
        if (abort.signal.aborted) return;
        const sources = agent.sources;

        send({
          type: "sources",
          sources: sources.map((s, i) => ({
            n: i + 1,
            chunkId: s.chunkId,
            paperId: s.paperId,
            paperIds: s.paperIds,
            title: s.title,
            section: s.section,
            year: s.year,
            quote: s.quote,
          })),
        });

        if (images.length) {
          send({
            type: "imageEvidence",
            evidence: agent.imageEvidence,
            stats: agent.imageStats,
          });
        }

        if (!sources.length && !agent.imageEvidence.length) {
          send({ type: "delta", text: extractiveAnswer([], []) });
          send({ type: "done", citations: [] });
          closed = true;
          controller.close();
          return;
        }

        const result = await streamChat(
          {
            ownerId: auth.user.id,
            service: "ask",
            system: ASK_SYSTEM,
            user: agent.prompt,
            temperature: 0.3,
            // 推理模型的 reasoning token 和正文共用这一份预算。带图提问时
            // 光推理就能吃掉九百,正文会一个字都不剩,界面便降级成"模型不可用"。
            // 每多一张图,推理都会更久;4000 覆盖到四张图的余量。
            maxTokens: 4000,
            images,
            signal: abort.signal,
          },
          (text) => send({ type: "delta", text }),
        );
        if (abort.signal.aborted) return;

        if (!result.ok || !result.text.trim()) {
          // 模型不可用:退回到"只列检索原文",并标注 fallback
          const fallback = extractiveAnswer(sources, agent.imageEvidence);
          send({ type: "delta", text: fallback });
          send({
            type: "done",
            citations: citedNumbers(fallback, sources.length),
            fallback: true,
            fallbackReason: result.error,
          });
        } else {
          /**
           * 从回答里整理"提到但不在星空里"的论文。
           *
           * 放在 done 之前:前端拿到 done 就能一次把角标与候选论文都画出来,
           * 不会出现"回答完了,卡片过两秒才冒出来"的二次跳变。
           */
          const existingTitles = payload.graph.nodes
            .filter((n) => n.kind === "paper")
            .map((n) => n.title);
          const suggestions = await extractSuggestions(
            auth.user.id,
            question,
            result.text,
            existingTitles,
            abort.signal,
          );
          if (abort.signal.aborted) return;
          send({
            type: "done",
            citations: citedNumbers(result.text, sources.length),
            suggestions,
          });
        }

        closed = true;
        try {
          controller.close();
        } catch {
          // 客户端已经断开
        }
      } finally {
        req.signal.removeEventListener("abort", onRequestAbort);
        releaseRun?.();
      }
    },
    cancel() {
      closed = true;
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // 让调用方(以及评审)能直接看到本窗口还剩多少次
      "x-ratelimit-remaining": String(limit.remaining ?? 0),
    },
  });
}
