"use client";

import { useCallback, useEffect, useState } from "react";

import { SecondaryPage } from "@/components/shell/SecondaryPage";
import { GhostButton } from "@/components/ui/GhostButton";
import { fetchCapabilities, fetchPresets, testLlm, type LlmHealth } from "@/lib/api/client";
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
 * 一条贯穿全页的原则:**默认只给结论,细节藏起来,但一定找得到**。
 * 判定标准与反例是提示词内容,对多数用户来说是噪音,对少数用户来说是关键 ——
 * 所以它们默认折叠成一句人话的「系统怎么判断」,点「编辑」才露出原文。
 */
export default function SettingsPage() {
  const [presets, setPresets] = useState<RelationPreset[] | null>(null);
  const [baseline, setBaseline] = useState<RelationPreset[]>([]);
  const [caps, setCaps] = useState<CapabilityReport | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

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
    setPresets((prev) => (prev ? prev.map((p) => (p.id === id ? { ...p, ...patch } : p)) : prev));
    setDirty(true);
    setSavedAt(null);
  }, []);

  /**
   * 保存。
   *
   * 判定标准变了就自动递增 promptVersion —— 证据链要靠它回答
   * 「这条边是哪个版本的提示词判出来的」。让用户自己记得改版本号是不现实的,
   * 而忘了改的后果是事后无法区分两次判定的来源。
   */
  const save = useCallback(() => {
    if (!presets) return;
    const baseById = new Map(baseline.map((p) => [p.id, p]));
    const next = presets.map((p) => {
      const base = baseById.get(p.id);
      const rubricChanged =
        base && (base.definition !== p.definition || base.negativeExamples !== p.negativeExamples);
      if (!rubricChanged) return p;
      const [name, version] = p.promptVersion.split("@");
      const n = Number(version);
      return { ...p, promptVersion: `${name}@${Number.isFinite(n) ? n + 1 : 2}` };
    });

    setPresets(next);
    savePresetOverrides(next);
    setDirty(false);
    setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
  }, [presets, baseline]);

  const resetAll = useCallback(() => {
    clearPresetOverrides();
    setPresets(baseline);
    setDirty(false);
    setSavedAt(null);
  }, [baseline]);

  const resetOne = useCallback(
    (id: string) => {
      const base = baseline.find((p) => p.id === id);
      if (base) update(id, base);
    },
    [baseline, update],
  );

  return (
    <SecondaryPage
      title="设置"
      subtitle="这里决定系统怎么判断两篇论文之间的关系,以及用哪个模型来做判断。改动只影响之后新建或并入的星空,已有的星空保持原样。"
      actions={
        <div className="flex items-center gap-2">
          {savedAt && !dirty ? (
            <span className="text-[10.5px] text-accent">{savedAt} 已保存</span>
          ) : null}
          <GhostButton size="sm" onClick={resetAll} disabled={!presets}>
            全部恢复默认
          </GhostButton>
          <GhostButton size="sm" active={dirty} onClick={save} disabled={!dirty}>
            保存
          </GhostButton>
        </div>
      }
    >
      <div className="flex flex-col gap-12">
        <ModelSection caps={caps} />

        <section>
          <SectionHead
            title="关系判定"
            note="每一类关系都是一条可编辑的判定规则。关掉它,图里就不会再出现这种边。"
          />
          {presets === null ? (
            <p className="text-[12.5px] text-ink-4">正在读取…</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {presets.map((p) => (
                <PresetCard
                  key={p.id}
                  preset={p}
                  baseline={baseline.find((b) => b.id === p.id)}
                  onChange={(patch) => update(p.id, patch)}
                  onReset={() => resetOne(p.id)}
                />
              ))}
            </ul>
          )}
        </section>

        <section>
          <SectionHead title="数据与隐私" />
          <div className="rounded-xl border border-hair px-5 py-4">
            <Row label="账号">
              这一版不需要登录。星空保存在本机服务端,关系设置保存在本机浏览器。
            </Row>
            <Row label="出网的数据">
              只有论文标题与 ID 会发往 OpenAlex 与 arXiv 用于检索;摘要会发往你配置的模型用于关系判定。
            </Row>
            <Row label="密钥">
              只存在于服务端的 <code className="font-mono text-ink-3">.env.local</code>,
              从不进入浏览器,也不写入代码仓库。
            </Row>
          </div>
        </section>
      </div>
    </SecondaryPage>
  );
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

function ModelSection({ caps }: { caps: CapabilityReport | null }) {
  const [health, setHealth] = useState<LlmHealth | null>(null);
  const [testing, setTesting] = useState(false);
  const [showConfig, setShowConfig] = useState(false);

  const run = useCallback(async () => {
    setTesting(true);
    setHealth(null);
    try {
      setHealth(await testLlm());
    } catch (e) {
      setHealth({ ok: false, error: e instanceof Error ? e.message : "自检失败" });
    } finally {
      setTesting(false);
    }
  }, []);

  const connected = Boolean(caps?.llm);
  const open = showConfig || !connected;

  return (
    <section>
      <SectionHead title="模型" note="关系判定与问答都需要模型。没有也能用,但结论会明显变少。" />

      <div className="rounded-xl border border-hair px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className={`h-2 w-2 rounded-full ${connected ? "bg-accent" : "bg-warm"}`}
              aria-hidden="true"
            />
            <div>
              <p className="text-[13px] text-ink">
                {connected ? "已接入模型" : "未接入模型"}
              </p>
              <p className="mt-0.5 font-mono text-[10.5px] text-ink-4">
                {connected
                  ? (caps?.llmModel ?? "模型名未知")
                  : "关系判定会退回启发式规则,界面会如实标注"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <GhostButton size="sm" onClick={() => void run()} disabled={testing || !connected}>
              {testing ? "自检中…" : "测试连接"}
            </GhostButton>
            <GhostButton size="sm" onClick={() => setShowConfig((v) => !v)}>
              {open && connected ? "收起配置" : "怎么配置"}
            </GhostButton>
          </div>
        </div>

        {health ? (
          <div
            className={`mt-3.5 rounded-lg border px-3.5 py-2.5 ${
              health.ok ? "border-accent/35" : "border-warm/40"
            }`}
          >
            {health.ok ? (
              <p className="text-[11.5px] text-ink-2">
                模型正常响应 · {health.model} · 往返 {health.latencyMs} ms
                {health.answer ? ` · 探针回答「${health.answer}」` : ""}
              </p>
            ) : (
              <>
                <p className="text-[11.5px] text-warm">{health.error}</p>
                {health.hint ? (
                  <p className="mt-1 text-[10.5px] leading-relaxed text-ink-4">{health.hint}</p>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {open ? (
          <div className="mt-4 border-t border-hair pt-4">
            <p className="text-[11.5px] leading-[1.9] text-ink-3">
              在项目根目录建一个{" "}
              <code className="font-mono text-ink-2">.env.local</code>,填三行即可,
              然后重启服务。任何 OpenAI 兼容的接口都能用 —— 换供应商只改地址和模型名,代码不用动。
            </p>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-hair/50 px-3.5 py-3 font-mono text-[10.5px] leading-relaxed text-ink-2">
{`LLM_API_KEY=你的密钥
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat`}
            </pre>
            <p className="mt-3 text-[11px] leading-relaxed text-ink-4">
              这个文件已经被 <code className="font-mono">.gitignore</code> 忽略,不会被提交。
              结构层的引用、作者、发表信息来自 OpenAlex 与 arXiv,不消耗任何模型额度。
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 关系预设
// ---------------------------------------------------------------------------

/** 硬约束 → 人话。设置页只展示这些,改它们要改代码。 */
const CONSTRAINT_PROSE: Record<string, string> = {
  requireCitation: "两篇之间必须有引用关系",
  requireMutualNonCitation: "两篇必须**没有**互相引用(平行但未交汇)",
  requireSharedTask: "两篇必须面向同一个任务",
  requireSharedMethod: "两篇必须用到同一种方法",
};

function PresetCard({
  preset,
  baseline,
  onChange,
  onReset,
}: {
  preset: RelationPreset;
  baseline?: RelationPreset;
  onChange: (patch: Partial<RelationPreset>) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  const c = preset.hardConstraints;
  const rules: string[] = [];
  for (const [key, prose] of Object.entries(CONSTRAINT_PROSE)) {
    if (c[key as keyof typeof c]) rules.push(prose);
  }
  if (c.maxYearGap !== undefined) rules.push(`发表年份相差不超过 ${c.maxYearGap} 年`);
  if (c.minSimilarity !== undefined) rules.push("主题重合度要达到一定水平");

  const changed =
    baseline &&
    (baseline.definition !== preset.definition ||
      baseline.negativeExamples !== preset.negativeExamples ||
      baseline.maxPerSeed !== preset.maxPerSeed ||
      baseline.enabled !== preset.enabled);

  return (
    <li className={`rounded-xl border transition-colors ${preset.enabled ? "border-hair" : "border-hair opacity-55"}`}>
      <div className="flex items-start justify-between gap-4 px-5 py-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="group flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          <span
            className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full border"
            style={{
              borderColor: preset.visual.tone,
              borderStyle: preset.visual.dash && preset.visual.dash !== "none" ? "dashed" : "solid",
            }}
          />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-[13.5px] text-ink">{preset.label}</span>
              <span className="font-mono text-[10px] text-ink-4">{preset.labelEn}</span>
              {preset.directed ? (
                <span className="rounded-full border border-hair-2 px-1.5 py-px text-[9.5px] text-ink-4">
                  有方向
                </span>
              ) : null}
              {changed ? (
                <span className="rounded-full border border-accent/40 px-1.5 py-px text-[9.5px] text-accent">
                  已改
                </span>
              ) : null}
            </span>
            <span className="mt-1.5 block text-[12px] leading-[1.8] text-ink-3">
              {preset.description}
            </span>
          </span>
          {/* 展开指示:没有它,用户不知道这一行可以点开 */}
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            aria-hidden="true"
            className={`mt-2 shrink-0 text-ink-4 transition-transform duration-[var(--dur-fast)] group-hover:text-ink-3 ${
              open ? "rotate-90" : ""
            }`}
          >
            <path
              d="M3.4 1.6 L6.9 5 L3.4 8.4"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <Switch
          checked={preset.enabled}
          onChange={(v) => onChange({ enabled: v })}
          label={`启用${preset.label}`}
        />
      </div>

      {open ? (
        <div className="border-t border-hair px-5 py-4">
          <p className="text-[10px] tracking-[0.14em] text-ink-4 uppercase">系统怎么判断</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {rules.map((r) => (
              <li key={r} className="flex gap-2 text-[11.5px] leading-relaxed text-ink-2">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-4" />
                <span>{renderEmphasis(r)}</span>
              </li>
            ))}
            {rules.length === 0 ? (
              <li className="text-[11.5px] text-ink-4">没有硬性前置条件,完全由模型判断。</li>
            ) : null}
            <li className="flex gap-2 text-[11.5px] leading-relaxed text-ink-2">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-ink-4" />
              <span>{renderEmphasis("满足后交给模型逐条判断,并**必须给出原文依据**才算成立")}</span>
            </li>
          </ul>

          <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-4">
            <div>
              <p className="text-[10px] tracking-[0.14em] text-ink-4 uppercase">
                每篇种子最多显示
              </p>
              <div className="mt-2 flex items-center gap-1">
                {[3, 6, 10, 20].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => onChange({ maxPerSeed: n })}
                    className={`rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors duration-[var(--dur-fast)] ${
                      preset.maxPerSeed === n
                        ? "border-accent/45 text-accent"
                        : "border-hair-2 text-ink-4 hover:text-ink-3"
                    }`}
                  >
                    {n}
                  </button>
                ))}
                <span className="ml-1 text-[10.5px] text-ink-4">条</span>
              </div>
              <p className="mt-1.5 text-[10.5px] text-ink-4">
                数值越大越全,但画面也会更密、模型调用更贵。
              </p>
            </div>

            <div className="flex items-end gap-2">
              <GhostButton size="sm" onClick={() => setEditing((v) => !v)}>
                {editing ? "完成编辑" : "编辑判定标准"}
              </GhostButton>
              {changed ? (
                <GhostButton size="sm" onClick={onReset}>
                  恢复这条
                </GhostButton>
              ) : null}
            </div>
          </div>

          {editing ? (
            <div className="mt-5 rounded-lg border border-hair-2 px-4 py-4">
              <p className="text-[10.5px] leading-relaxed text-ink-4">
                下面两段会连同上面的硬约束一起送进模型。写完保存时,判定标准的版本号会自动 +1 ——
                这样每条关系都能追溯出它是哪个版本判出来的。
              </p>
              <TextArea
                label="判定标准 · 什么算"
                value={preset.definition}
                onChange={(v) => onChange({ definition: v })}
              />
              <TextArea
                label="反例 · 什么不算"
                value={preset.negativeExamples}
                onChange={(v) => onChange({ negativeExamples: v })}
              />
              <p className="mt-3 font-mono text-[10px] text-ink-4">
                当前版本 {preset.promptVersion}
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// 小件
// ---------------------------------------------------------------------------

function SectionHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-[13.5px] tracking-[0.06em] text-ink">{title}</h2>
      {note ? <span className="text-[10.5px] text-ink-4">{note}</span> : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-6 border-b border-hair py-3 last:border-b-0 last:pb-0 first:pt-0">
      <span className="w-[76px] shrink-0 text-[11px] text-ink-4">{label}</span>
      <p className="text-[11.5px] leading-[1.9] text-ink-2">{children}</p>
    </div>
  );
}

function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative mt-0.5 h-[18px] w-[32px] shrink-0 rounded-full border transition-colors duration-[var(--dur-fast)] ${
        checked ? "border-accent/50 bg-accent/25" : "border-hair-2 bg-transparent"
      }`}
    >
      <span
        className={`absolute top-[2px] h-[12px] w-[12px] rounded-full transition-[left,background-color] duration-[var(--dur-fast)] ${
          checked ? "left-[17px] bg-accent" : "left-[2px] bg-ink-4"
        }`}
      />
    </button>
  );
}

function TextArea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="mt-3.5 block">
      <span className="text-[10px] tracking-[0.14em] text-ink-4 uppercase">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        spellCheck={false}
        className="mt-1.5 w-full resize-y rounded-md border border-hair-2 bg-transparent px-3 py-2 text-[11.5px] leading-[1.85] text-ink-2 focus:border-accent/45"
      />
    </label>
  );
}

/** 极简强调渲染:只支持 **粗体**,避免为一个说明文字引入 Markdown 解析器。 */
function renderEmphasis(text: string): React.ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="text-ink">
        {part}
      </span>
    ) : (
      part
    ),
  );
}
