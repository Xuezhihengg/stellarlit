"use client";

import { create } from "zustand";

import {
  ApiRequestError,
  fetchCapabilities,
  getStarfield,
  growStarfield,
  resolveSeed,
} from "@/lib/api/client";
import { loadPresetOverrides } from "@/lib/presets/local";
import type { CapabilityReport, StarfieldPayload } from "@/types/api";
import type { SeedCandidate } from "@/types/starfield";

/**
 * 星空状态。
 *
 * 进入 store 的只有**跨组件共享**且**需要跨路由存活**的东西:载荷、选中项、筛选项。
 * 相机位置与鼠标悬浮刻意留在渲染组件的 ref 里 —— 它们每帧都在变,
 * 放进 store 会让整棵子树跟着重渲染,而这正是 Canvas 方案要避免的开销。
 */

export type BuildPhase = "idle" | "resolving" | "confirming" | "growing" | "ready" | "error";

interface StarfieldState {
  payload: StarfieldPayload | null;
  phase: BuildPhase;
  error: { message: string; hint?: string } | null;
  capabilities: CapabilityReport | null;
  candidates: SeedCandidate[];
  query: string;
  selectedId: string | null;
  /** 用户关闭了哪些关系类型 */
  hiddenKinds: Set<string>;
  minYear: number | null;
  setQuery: (q: string) => void;
  setSelected: (id: string | null) => void;
  toggleKind: (kind: string) => void;
  setMinYear: (year: number | null) => void;
  dismissCandidates: () => void;
  loadCapabilities: () => Promise<void>;
  loadPayload: (payload: StarfieldPayload) => void;
  /** 按 id 载入一片既有的星空(历史页跳转、深链都用它) */
  loadById: (id: string) => Promise<void>;
  search: () => Promise<void>;
  grow: (seedPaperId: string, name?: string) => Promise<void>;
  reset: () => void;
}

function toError(e: unknown): { message: string; hint?: string } {
  if (e instanceof ApiRequestError) return { message: e.message, hint: e.hint };
  return { message: e instanceof Error ? e.message : "未知错误" };
}

export const useStarfieldStore = create<StarfieldState>((set, get) => ({
  payload: null,
  phase: "idle",
  error: null,
  capabilities: null,
  candidates: [],
  query: "",
  selectedId: null,
  hiddenKinds: new Set<string>(),
  minYear: null,

  setQuery: (q) => set({ query: q }),
  setSelected: (id) => set({ selectedId: id }),

  toggleKind: (kind) =>
    set((s) => {
      const next = new Set(s.hiddenKinds);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return { hiddenKinds: next };
    }),

  setMinYear: (year) => set({ minYear: year }),

  dismissCandidates: () => set({ candidates: [], phase: get().payload ? "ready" : "idle" }),

  loadCapabilities: async () => {
    try {
      set({ capabilities: await fetchCapabilities() });
    } catch {
      // 能力探测失败不影响主流程:默认按「没有大模型」处理,界面会如实降级
      set({ capabilities: { llm: false, embedding: false, llmModel: null } });
    }
  },

  loadPayload: (payload) =>
    set({
      payload,
      phase: "ready",
      error: null,
      selectedId: null,
      candidates: [],
      minYear: null,
    }),

  loadById: async (id) => {
    set({ phase: "growing", error: null });
    try {
      const payload = await getStarfield(id);
      set({ payload, phase: "ready", selectedId: null, candidates: [], minYear: null });
    } catch (e) {
      set({ error: toError(e), phase: "idle" });
    }
  },

  search: async () => {
    const { query, payload } = get();
    if (!query.trim()) return;

    set({ phase: "resolving", error: null, candidates: [] });
    try {
      const known = payload
        ? payload.graph.nodes.filter((n) => n.kind === "paper").map((n) => n.id)
        : [];
      const { candidates } = await resolveSeed(query, known);
      set({ candidates, phase: "confirming" });
    } catch (e) {
      set({ error: toError(e), phase: "error" });
    }
  },

  grow: async (seedPaperId, name) => {
    const { payload } = get();
    set({ phase: "growing", error: null, candidates: [] });
    try {
      const next = await growStarfield({
        starfieldId: payload?.starfield.id,
        seedPaperId,
        name,
        presets: loadPresetOverrides() ?? undefined,
      });
      set({ payload: next, phase: "ready" });
    } catch (e) {
      // 构建失败时回到 ready,而不是 error:老星空还在,用户不该被踢出画面
      set({ error: toError(e), phase: payload ? "ready" : "error" });
    }
  },

  reset: () =>
    set({
      payload: null,
      phase: "idle",
      error: null,
      candidates: [],
      query: "",
      selectedId: null,
      minYear: null,
    }),
}));
