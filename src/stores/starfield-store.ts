"use client";

import { create } from "zustand";

import {
  ApiRequestError,
  fetchAccountPresets,
  fetchCapabilities,
  getStarfield,
  growStarfieldStream,
  resolveSeed,
} from "@/lib/api/client";
import type { CapabilityReport, StarfieldPayload } from "@/types/api";
import type { SeedCandidate } from "@/types/starfield";

/**
 * 星空状态。
 *
 * 进入 store 的只有**跨组件共享**且**需要跨路由存活**的东西:载荷、选中项、筛选项。
 * 相机位置与鼠标悬浮刻意留在渲染组件的 ref 里 —— 它们每帧都在变,
 * 放进 store 会让整棵子树跟着重渲染,而这正是 Canvas 方案要避免的开销。
 */

export type BuildPhase =
  | "idle"
  | "resolving"
  | "confirming"
  | "growing"
  | "settling"
  | "ready"
  | "error";

interface StarfieldState {
  payload: StarfieldPayload | null;
  phase: BuildPhase;
  /** code 用来决定这条错误该出现在哪:quota 是全局提示,不进侧栏 */
  error: { message: string; hint?: string; code?: string } | null;
  capabilities: CapabilityReport | null;
  candidates: SeedCandidate[];
  query: string;
  selectedId: string | null;
  /**
   * 用户关掉了哪些关系类型(淡出对应星星与边,不是隐藏)。
   *
   * 引用边**默认关掉**:它是骨架,数量最多(实测 140 条可绘制的边里 112 条是引用),
   * 全开时画面上是一张灰色的网,语义关系那二十几条反而被淹掉。
   * 想看引用结构时从筛选栏打开即可。
   */
  dimmedKinds: Set<string>;
  minYear: number | null;
  /** 流式构建的实时进度;null 表示当前没有在构建 */
  streamProgress: {
    round: number;
    depth: number;
    judged: number;
    matched: number;
    llmCalls: number;
  } | null;
  setQuery: (q: string) => void;
  setSelected: (id: string | null) => void;
  toggleKind: (kind: string) => void;
  setMinYear: (year: number | null) => void;
  dismissCandidates: () => void;
  clearError: () => void;
  loadCapabilities: () => Promise<void>;
  loadPayload: (payload: StarfieldPayload) => void;
  /** 按 id 载入一片既有的星空(历史页跳转、深链都用它) */
  loadById: (id: string) => Promise<void>;
  search: () => Promise<void>;
  grow: (seedPaperId: string, name?: string) => Promise<void>;
  reset: () => void;
}

function toError(e: unknown): { message: string; hint?: string; code?: string } {
  if (e instanceof ApiRequestError) return { message: e.message, hint: e.hint, code: e.code };
  return { message: e instanceof Error ? e.message : "未知错误" };
}

/** 构建完成后的收尾展示时长:让最后一层关系与统计停留一会儿,不要直接切到指南。 */
const SETTLE_MS = 2_800;
/** 解析请求本身可能几十毫秒就返回;给动画一个最短可见时间。 */
const RESOLVE_MIN_MS = 1_000;

let settleTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * 当前这条异步链路的编号。
 *
 * 「新建星空」会在构建中途清空画布;如果旧请求的回调继续写 state,
 * 刚清空的星空就会被旧结果重新填回来。所有异步写入口都先对编号,
 * reset 时递增一次,旧回调自然失效。
 */
let flowId = 0;
let growAbort: AbortController | null = null;

function clearSettleTimer(): void {
  if (!settleTimer) return;
  clearTimeout(settleTimer);
  settleTimer = null;
}

function beginFlow(): number {
  growAbort?.abort();
  growAbort = null;
  flowId += 1;
  return flowId;
}

function isCurrentFlow(id: number): boolean {
  return id === flowId;
}

export const useStarfieldStore = create<StarfieldState>((set, get) => ({
  payload: null,
  phase: "idle",
  error: null,
  capabilities: null,
  candidates: [],
  query: "",
  selectedId: null,
  dimmedKinds: new Set<string>(["CITES"]),
  minYear: null,
  streamProgress: null,

  setQuery: (q) => set({ query: q }),
  setSelected: (id) => {
    // 用户主动点论文时,不必等收尾动画走完
    clearSettleTimer();
    set({
      selectedId: id,
      ...(get().phase === "settling" ? { phase: "ready", streamProgress: null } : {}),
    });
  },

  toggleKind: (kind) =>
    set((s) => {
      const next = new Set(s.dimmedKinds);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return { dimmedKinds: next };
    }),

  setMinYear: (year) => set({ minYear: year }),

  dismissCandidates: () => set({ candidates: [], phase: get().payload ? "ready" : "idle" }),
  clearError: () => set({ error: null, phase: get().payload ? "ready" : "idle" }),

  loadCapabilities: async () => {
    try {
      set({ capabilities: await fetchCapabilities() });
    } catch {
      // 能力探测失败不影响主流程:默认按「没有大模型」处理,界面会如实降级
      set({ capabilities: { llm: false, embedding: false, llmModel: null } });
    }
  },

  loadPayload: (payload) => {
    clearSettleTimer();
    set({
      payload,
      phase: "ready",
      error: null,
      selectedId: null,
      candidates: [],
      minYear: null,
    });
  },

  loadById: async (id) => {
    const flow = beginFlow();
    clearSettleTimer();
    set({ phase: "growing", error: null });
    try {
      const payload = await getStarfield(id);
      if (!isCurrentFlow(flow)) return;
      /**
       * 图例要回答的是「我现在有哪些关系」,而不是「这张图当初用哪些关系建的」。
       * 存量的 payload.presets 是快照:后来新加的自定义关系不在里面,
       * 打开旧星空时就看不到它。这里补一次账号级刷新,失败就按快照展示。
       */
      const presets = await fetchAccountPresets().catch(() => payload.presets);
      if (!isCurrentFlow(flow)) return;
      set({
        payload: { ...payload, presets },
        phase: "ready",
        selectedId: null,
        candidates: [],
        minYear: null,
      });
    } catch (e) {
      if (!isCurrentFlow(flow)) return;
      set({ error: toError(e), phase: "idle" });
    }
  },

  search: async () => {
    const { query, payload } = get();
    if (!query.trim()) return;

    const flow = beginFlow();
    clearSettleTimer();
    set({ phase: "resolving", error: null, candidates: [] });
    const startedAt = Date.now();
    try {
      const known = payload
        ? payload.graph.nodes.filter((n) => n.kind === "paper").map((n) => n.id)
        : [];
      const { candidates } = await resolveSeed(query, known);
      const wait = RESOLVE_MIN_MS - (Date.now() - startedAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      if (!isCurrentFlow(flow)) return;
      set({ candidates, phase: "confirming" });
    } catch (e) {
      if (!isCurrentFlow(flow)) return;
      set({ error: toError(e), phase: "error" });
    }
  },

  grow: async (seedPaperId, name) => {
    const { payload } = get();
    const flow = beginFlow();
    const abort = new AbortController();
    growAbort = abort;
    clearSettleTimer();
    set({ phase: "growing", error: null, candidates: [], streamProgress: null });

    /**
     * 结构骨架先落地,关系再一条条叠上来。
     *
     * 这里刻意不做"等全部完成再一次性替换":用户点下按钮后一秒内就能看到
     * 种子与它的三前一后,而关系判定在后台推进。等待从"盯着转圈"变成
     * "看着它长出来"——这也是评分表里「AI 思考状态可视化」那一项真正该有的样子。
     */
    const started = Date.now();
    await growStarfieldStream(
      {
        starfieldId: payload?.starfield.id,
        seedPaperId,
        name,
      },
      {
        /**
         * 结构快照自带服务端本次实际使用的 `presets`。
         *
         * 以前这里沿用上一份 payload 的预设:新建星空时是空的(图例只剩引用),
         * 往旧星空里并入新关系时又会继承旧清单 —— 自定义关系在流式阶段没有名字,
         * 详情面板里只能显示 `CUSTOM_XXX`。服务端既然已经算好了,就直接用它的。
         */
        onStructure: ({ starfield, graph, layout, presets }) => {
          if (!isCurrentFlow(flow)) return;
          set({
            payload: {
              starfield,
              graph,
              layout,
              presets,
              meta: provisionalMeta(started),
            },
          });
        },
        onGraph: ({ graph, layout }) => {
          if (!isCurrentFlow(flow)) return;
          const current = get().payload;
          if (!current) return;
          set({
            payload: {
              ...current,
              graph,
              layout,
              starfield: { ...current.starfield, stats: statsOf(graph) },
            },
          });
        },
        onProgress: (p) => {
          if (!isCurrentFlow(flow)) return;
          set({
            streamProgress: {
              round: p.round,
              depth: p.depth,
              judged: p.judged,
              matched: p.matched,
              llmCalls: p.llmCalls,
            },
          });
        },
        onDone: (done) => {
          if (!isCurrentFlow(flow)) return;
          clearSettleTimer();
          // 保留 streamProgress:收尾阶段还要显示最后一层的数字
          set({ payload: done, phase: "settling" });
          settleTimer = setTimeout(() => {
            settleTimer = null;
            if (!isCurrentFlow(flow)) return;
            if (get().phase !== "settling") return;
            set({ phase: "ready", streamProgress: null });
          }, SETTLE_MS);
        },
        onError: (message, code) => {
          if (!isCurrentFlow(flow)) return;
          clearSettleTimer();
          set({
            // 构建失败时回到 ready,而不是 error:老星空还在,用户不该被踢出画面
            phase: get().payload ? "ready" : "error",
            error: { message, code },
            streamProgress: null,
          });
        },
      },
      abort.signal,
    );
    if (growAbort === abort) growAbort = null;
  },

  reset: () => {
    beginFlow();
    clearSettleTimer();
    set({
      payload: null,
      phase: "idle",
      error: null,
      candidates: [],
      query: "",
      selectedId: null,
      minYear: null,
      streamProgress: null,
      dimmedKinds: new Set<string>(["CITES"]),
    });
  },
}));

function statsOf(graph: StarfieldPayload["graph"]) {
  return {
    papers: graph.stats.papers,
    edges: graph.stats.edges,
    communities: graph.stats.communities,
    domains: graph.stats.domains,
  };
}

/**
 * 骨架阶段的占位元信息。
 *
 * 刻意不编造 relations 的数字:这一阶段还没有结论,填 0 是**如实**,
 * 而界面上会显示"正在判定",不会让用户把 0 误当成结果。
 */
function provisionalMeta(startedAt: number): StarfieldPayload["meta"] {
  return {
    quality: { kept: 0, droppedTotal: 0, droppedByReason: {} },
    relations: {
      perPreset: {},
      rejectedQuotes: 0,
      llmCalls: 0,
      estimatedTokens: 0,
      cacheHits: 0,
      batchFallbacks: 0,
    },
    capabilities: { llm: false, embedding: false, llmModel: null },
    builtAt: new Date(startedAt).toISOString(),
    durationMs: 0,
    addedPapers: 0,
  };
}
