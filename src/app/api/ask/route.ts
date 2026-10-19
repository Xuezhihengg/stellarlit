import { NextResponse } from "next/server";
import { z } from "zod";

import { streamChat } from "@/server/llm/client";
import {
  ASK_SYSTEM,
  buildAskPrompt,
  citedNumbers,
  extractSuggestions,
  extractiveAnswer,
} from "@/server/rag/answer";
import { retrieveSources } from "@/server/rag/retrieve";
import { loadStarfield } from "@/server/starfield/store";
import type { AskEvent } from "@/types/rag";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  starfieldId: z.string().min(1),
  question: z.string().trim().min(2).max(500),
});

/**
 * 检索增强问答(流式)。
 *
 * 事件顺序:sources → delta* → done。
 * sources 先到,前端可以先画出"依据"再逐字显示答案 —— 这比"等答案出来
 * 才知道引用了谁"更像检索,而不是事后补引用。
 */
export async function POST(req: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "问题格式不正确", code: "bad_request" },
      { status: 400 },
    );
  }

  const { starfieldId, question } = parsed.data;
  const payload = await loadStarfield(starfieldId);
  if (!payload) {
    return NextResponse.json(
      { error: "这片星空不存在或已被删除", code: "not_found" },
      { status: 404 },
    );
  }

  const sources = retrieveSources(payload, question, 8);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: AskEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

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

      if (!sources.length) {
        send({ type: "delta", text: extractiveAnswer([]) });
        send({ type: "done", citations: [] });
        closed = true;
        controller.close();
        return;
      }

      const result = await streamChat(
        {
          system: ASK_SYSTEM,
          user: buildAskPrompt(question, sources),
          temperature: 0.3,
          maxTokens: 900,
        },
        (text) => send({ type: "delta", text }),
      );

      if (!result.ok || !result.text.trim()) {
        // 模型不可用:退回到"只列检索原文",并标注 fallback
        const fallback = extractiveAnswer(sources);
        send({ type: "delta", text: fallback });
        send({ type: "done", citations: citedNumbers(fallback, sources.length), fallback: true });
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
        const suggestions = await extractSuggestions(question, result.text, existingTitles);
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
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
