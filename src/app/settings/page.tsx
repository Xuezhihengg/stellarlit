"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { SecondaryPage } from "@/components/shell/SecondaryPage";
import { GhostButton } from "@/components/ui/GhostButton";
import { fetchCapabilities, fetchPresets } from "@/lib/api/client";
import {
  clearPresetOverrides,
  loadPresetOverrides,
  mergePresets,
  savePresetOverrides,
} from "@/lib/presets/local";
import type { CapabilityReport } from "@/types/api";
import type { RelationPreset } from "@/types/kg";

/**
 * 设置。
 *
 * 三块内容,顺序按「用户最可能来改什么」排:
 * 模型配置(接入自己的模型)→ 关系预设(改判定标准)→ 账户与数据。
 */
export default function SettingsPage() {
  const [presets, setPresets] = useState<RelationPreset[] | null>(null);
  const [baseline, setBaseline] = useState<RelationPreset[]>([]);
  const [caps, setCaps] = useState<CapabilityReport | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [builtin, capability] = await Promise.all([fetchPresets(), fetchCapabilities()]);
        setBaseline(builtin);
        setPresets(mergePresets(builtin, loadPresetOverrides()));
        setCaps(capability);
      } catch {
        setPresets([]);
      }
    })();
  }, []);

  const update = useCallback((id: string, patch: Partial<RelationPreset>) => {
    setPresets((prev) =>
      prev ? prev.map((p) => (p.id === id ? { ...p, ...patch } : p)) : prev,
    );
    setDirty(true);
    setSaved(false);
  }, []);

  const save = useCallback(() => {
    if (!presets) return;
    savePresetOverrides(presets);
    setDirty(false);
    setSaved(true);
  }, [presets]);

  const reset = useCallback(() => {
    clearPresetOverrides();
    setPresets(baseline);
    setDirty(false);
    setSaved(false);
  }, [baseline]);

  const enabledCount = useMemo(
    () => presets?.filter((p) => p.enabled).length ?? 0,
    [presets],
  );

  return (
    <SecondaryPage
      title="设置"
      subtitle="关系预设决定了系统怎么判断两篇论文之间的关系。每一条都包含判定标准与反例 —— 反例同样是提示词的一部分,它负责界定「什么不算」,是抑制误判的关键。"
      actions={
        <div className="flex items-center gap-2">
          {saved && !dirty ? (
            <span className="text-[10.5px] text-accent">已保存,下次建图生效</span>
          ) : null}
          <GhostButton size="sm" onClick={reset} disabled={!presets}>
            恢复默认
          </GhostButton>
          <GhostButton size="sm" active={dirty} onClick={save} disabled={!dirty}>
            保存
          </GhostButton>
        </div>
      }
    >
      <div className="flex flex-col gap-10">
        {/* ---------------- 模型配置 ---------------- */}
        <Section
          title="模型配置"
          note="密钥只通过环境变量注入,不经过界面、不写入仓库。"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <StatusCard
              label="大模型"
              ok={Boolean(caps?.llm)}
              okText={caps?.llmModel ? `已连接 · ${caps.llmModel}` : "已连接"}
              offText="未配置 —— 关系判定降级为启发式规则"
            />
            <StatusCard
              label="向量模型"
              ok={Boolean(caps?.embedding)}
              okText="已连接 —— 语义相似度来自真实向量"
              offText="未配置 —— 语义项回退到主题重叠度"
            />
          </div>

          <div className="mt-4 rounded-lg border border-hair px-4 py-3.5">
            <p className="text-[11.5px] leading-[1.9] text-ink-3">
              在项目根目录建 <code className="font-mono text-ink-2">.env.local</code>,按
              <code className="font-mono text-ink-2">.env.example</code>
              填写即可。任何 OpenAI 兼容接口都能用,换供应商只需改 base url:
            </p>
            <pre className="mt-3 overflow-x-auto rounded-md bg-hair/50 px-3 py-2.5 font-mono text-[10.5px] leading-relaxed text-ink-2">
{`LLM_API_KEY=...
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat`}
            </pre>
            <p className="mt-3 text-[11px] leading-relaxed text-ink-4">
              没有密钥时系统仍然可用:结构层(引用、作者、发表)来自 OpenAlex 与 arXiv,
              不依赖任何密钥;界面会明确标出哪些结论来自启发式规则。
            </p>
          </div>
        </Section>

        {/* ---------------- 关系预设 ---------------- */}
        <Section
          title="关系预设"
          note={`${enabledCount} / ${presets?.length ?? 0} 条启用。改动只影响之后新建或并入的星空。`}
        >
          {presets === null ? (
            <p className="text-[12.5px] text-ink-4">正在读取…</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {presets.map((p) => {
                const open = openId === p.id;
                return (
                  <li key={p.id} className="rounded-xl border border-hair">
                    <div className="flex items-start justify-between gap-4 px-4 py-3.5">
                      <button
                        type="button"
                        onClick={() => setOpenId(open ? null : p.id)}
                        className="flex min-w-0 flex-1 items-start gap-3 text-left"
                      >
                        <span
                          className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full border"
                          style={{
                            borderColor: p.visual.tone,
                            borderStyle: p.visual.dash && p.visual.dash !== "none" ? "dashed" : "solid",
                          }}
                        />
                        <span className="min-w-0">
                          <span className="flex items-baseline gap-2">
                            <span className="text-[13px] text-ink">{p.label}</span>
                            <span className="font-mono text-[10px] text-ink-4">
                              {p.labelEn}
                            </span>
                            {p.directed ? (
                              <span className="font-mono text-[9.5px] text-ink-4">有向</span>
                            ) : null}
                          </span>
                          <span className="mt-1 block text-[11.5px] leading-relaxed text-ink-3">
                            {p.description}
                          </span>
                        </span>
                      </button>

                      <label className="flex shrink-0 items-center gap-2 pt-0.5">
                        <input
                          type="checkbox"
                          checked={p.enabled}
                          onChange={(e) => update(p.id, { enabled: e.target.checked })}
                          className="h-3 w-3 accent-[var(--accent)]"
                          aria-label={`启用 ${p.label}`}
                        />
                        <span className="text-[10.5px] text-ink-4">启用</span>
                      </label>
                    </div>

                    {open ? (
                      <div className="border-t border-hair px-4 py-4">
                        <Field
                          label="判定标准(注入提示词)"
                          value={p.definition}
                          onChange={(v) => update(p.id, { definition: v })}
                        />
                        <Field
                          label="反例(什么不算)"
                          value={p.negativeExamples}
                          onChange={(v) => update(p.id, { negativeExamples: v })}
                        />

                        <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
                          <label className="flex items-center gap-2">
                            <span className="text-[10.5px] text-ink-4">每篇种子最多</span>
                            <input
                              type="number"
                              min={0}
                              max={40}
                              value={p.maxPerSeed}
                              onChange={(e) =>
                                update(p.id, { maxPerSeed: Number(e.target.value) || 0 })
                              }
                              className="w-14 rounded border border-hair-2 bg-transparent px-1.5 py-0.5 font-mono text-[11px] text-ink"
                            />
                            <span className="text-[10.5px] text-ink-4">条</span>
                          </label>
                          <span className="font-mono text-[10px] text-ink-4">
                            promptVersion {p.promptVersion}
                          </span>
                        </div>

                        <Constraints preset={p} />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>

        {/* ---------------- 账户与数据 ---------------- */}
        <Section title="账户与数据" note="当前版本把一切数据留在本机。">
          <div className="rounded-lg border border-hair px-4 py-3.5">
            <p className="text-[11.5px] leading-[1.9] text-ink-3">
              这一版没有账号系统:星空与图谱存在服务端的{" "}
              <code className="font-mono text-ink-2">data/</code> 目录,关系预设存在浏览器本地。
              两者都不含任何个人信息,也不会发送到第三方 —— 只有论文标题与 ID
              会发往 OpenAlex / arXiv 用于检索。
            </p>
            <p className="mt-3 text-[11.5px] leading-[1.9] text-ink-3">
              API 密钥从不进入浏览器:所有对上游与模型的调用都在服务端的
              Route Handler 里完成。
            </p>
          </div>
        </Section>
      </div>
    </SecondaryPage>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-[13px] tracking-[0.08em] text-ink">{title}</h2>
        {note ? <span className="text-[10.5px] text-ink-4">{note}</span> : null}
      </div>
      {children}
    </section>
  );
}

function StatusCard({
  label,
  ok,
  okText,
  offText,
}: {
  label: string;
  ok: boolean;
  okText: string;
  offText: string;
}) {
  return (
    <div className="rounded-lg border border-hair px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-accent" : "bg-warm"}`}
          aria-hidden="true"
        />
        <span className="text-[11px] tracking-[0.1em] text-ink-3">{label}</span>
      </div>
      <p className={`mt-2 text-[11.5px] ${ok ? "text-ink-2" : "text-warm/90"}`}>
        {ok ? okText : offText}
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="mt-3 block first:mt-0">
      <span className="text-[10px] tracking-[0.14em] text-ink-4 uppercase">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        spellCheck={false}
        className="mt-1.5 w-full resize-y rounded-md border border-hair-2 bg-transparent px-3 py-2 text-[11.5px] leading-[1.8] text-ink-2 focus:border-accent/45"
      />
    </label>
  );
}

const CONSTRAINT_LABEL: Record<string, string> = {
  requireCitation: "必须存在引用",
  requireMutualNonCitation: "必须互不引用",
  requireSharedTask: "必须共享任务",
  requireSharedMethod: "必须共享方法",
};

/** 硬约束只读展示:它们是确定性代码,改了就要改代码,不放在界面上造假象。 */
function Constraints({ preset }: { preset: RelationPreset }) {
  const c = preset.hardConstraints;
  const chips: string[] = [];
  for (const [key, label] of Object.entries(CONSTRAINT_LABEL)) {
    if (c[key as keyof typeof c]) chips.push(label);
  }
  if (c.maxYearGap !== undefined) chips.push(`年份差 ≤ ${c.maxYearGap}`);
  if (c.minSimilarity !== undefined) chips.push(`主题重叠 ≥ ${c.minSimilarity}`);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-[10px] tracking-[0.14em] text-ink-4 uppercase">硬约束</span>
      {chips.length ? (
        chips.map((chip) => (
          <span
            key={chip}
            className="rounded-full border border-hair-2 px-2 py-px font-mono text-[9.5px] text-ink-4"
          >
            {chip}
          </span>
        ))
      ) : (
        <span className="font-mono text-[9.5px] text-ink-4">无</span>
      )}
    </div>
  );
}
