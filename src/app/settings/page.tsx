"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { SecondaryPage } from "@/components/shell/SecondaryPage";
import { GhostButton } from "@/components/ui/GhostButton";
import { Modal } from "@/components/ui/Modal";
import { SelectMenu } from "@/components/ui/SelectMenu";
import {
  clearPresetOverridesRemote,
  createMcpToken,
  fetchPresetOverrides,
  fetchMcpTokens,
  fetchProviderModels,
  fetchPresets,
  getModelSettings,
  probeProvider,
  revokeMcpToken,
  saveModelSettings,
  savePresetOverrides as savePresetOverridesRemote,
  type ProviderModelsResponse,
} from "@/lib/api/client";
import {
  claudeCodeCommand,
  httpClientConfig,
  MCP_TOOLS,
} from "@/lib/mcp/catalog";
import { formatDate } from "@/lib/format";
import {
  inferModelModalities,
  MODEL_SERVICES,
  PROVIDER_PRESETS,
  providerPreset,
} from "@/lib/models/catalog";
import { mergePresets } from "@/lib/presets/merge";
import {
  MAX_RELATION_PRESETS,
  makeCustomPreset,
  validateCustomPreset,
  type CustomPresetInput,
} from "@/lib/presets/custom";
import type { RelationFamily, RelationPreset } from "@/types/kg";
import type { McpTokenSummary } from "@/types/mcp";
import type {
  ModelModality,
  ModelProviderId,
  ModelSettingsDto,
  ProviderAccountDto,
} from "@/types/model-settings";

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
  /** 上一次保存后的快照:版本号只比较它,不再拿内置默认值反复比较。 */
  const [savedPresets, setSavedPresets] = useState<RelationPreset[]>([]);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const [presetSaving, setPresetSaving] = useState(false);
  const [activeSection, setActiveSection] = useState<"models" | "relations" | "mcp">("models");

  useEffect(() => {
    void (async () => {
      try {
        const [builtin, remoteOverrides] = await Promise.all([
          fetchPresets(),
          fetchPresetOverrides().catch(() => null),
        ]);
        // 服务端是唯一副本:本地不再保存关系预设,避免切换账号时串数据
        const merged = mergePresets(builtin, remoteOverrides);
        setBaseline(builtin);
        setPresets(merged);
        setSavedPresets(merged);
      } catch {
        setPresets([]);
      }
    })();
  }, []);

  const update = useCallback((id: string, patch: Partial<RelationPreset>) => {
    setPresets((prev) => (prev ? prev.map((p) => (p.id === id ? { ...p, ...patch } : p)) : prev));
    setDirty(true);
    setSavedAt(null);
    setPresetError(null);
  }, []);

  const addPreset = useCallback((preset: RelationPreset) => {
    setPresets((prev) => (prev ? [...prev, preset] : [preset]));
    setDirty(true);
    setSavedAt(null);
    setPresetError(null);
  }, []);

  const removePreset = useCallback((id: string) => {
    setPresets((prev) => (prev ? prev.filter((preset) => preset.id !== id) : prev));
    setDirty(true);
    setSavedAt(null);
    setPresetError(null);
  }, []);

  /**
   * 保存。
   *
   * 判定标准变了就自动递增 promptVersion —— 证据链要靠它回答
   * 「这条边是哪个版本的提示词判出来的」。让用户自己记得改版本号是不现实的,
   * 而忘了改的后果是事后无法区分两次判定的来源。
   */
  const save = useCallback(async () => {
    if (presetSaving) return;
    if (!presets) return;
    if (presets.length > MAX_RELATION_PRESETS) {
      setPresetError(`最多只能有 ${MAX_RELATION_PRESETS} 条关系`);
      return;
    }
    const invalid = presets.find(
      (preset) => !preset.definition.trim() || !preset.negativeExamples.trim(),
    );
    if (invalid) {
      setPresetError(`「${invalid.label}」的判定标准与反例不能为空`);
      return;
    }
    const seenIds = new Set<string>();
    const seenLabels = new Set<string>();
    const seenLabelEns = new Set<string>();
    const duplicate = presets.find((preset) => {
      const label = preset.label.trim().toLowerCase();
      const labelEn = preset.labelEn.trim().toLowerCase();
      if (seenIds.has(preset.id) || seenLabels.has(label) || seenLabelEns.has(labelEn)) return true;
      seenIds.add(preset.id);
      seenLabels.add(label);
      seenLabelEns.add(labelEn);
      return false;
    });
    if (duplicate) {
      setPresetError(`「${duplicate.label}」的名称或 id 与另一条关系重复`);
      return;
    }
    setPresetError(null);
    const previousById = new Map(savedPresets.map((p) => [p.id, p]));
    const next = presets.map((p) => {
      const base = previousById.get(p.id);
      const rubricChanged =
        base && (base.definition !== p.definition || base.negativeExamples !== p.negativeExamples);
      if (!rubricChanged) return p;
      const [name, version] = p.promptVersion.split("@");
      const n = Number(version);
      return { ...p, promptVersion: `${name}@${Number.isFinite(n) ? n + 1 : 2}` };
    });

    setPresetSaving(true);
    try {
      await savePresetOverridesRemote(next);
    } catch (error) {
      setPresetError(
        error instanceof Error ? error.message : "服务端保存失败,请检查网络后重试",
      );
      return;
    } finally {
      setPresetSaving(false);
    }
    setPresets(next);
    setSavedPresets(next);
    setDirty(false);
    setSavedAt(new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }));
  }, [presetSaving, presets, savedPresets]);

  const resetAll = useCallback(async () => {
    setPresetSaving(true);
    try {
      await clearPresetOverridesRemote();
    } catch (error) {
      setPresetError(error instanceof Error ? error.message : "恢复默认失败,请重试");
      return;
    } finally {
      setPresetSaving(false);
    }
    setPresets(baseline);
    setSavedPresets(baseline);
    setDirty(false);
    setSavedAt(null);
    setPresetError(null);
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
      actions={
        activeSection === "relations" ? (
          <div className="flex items-center gap-2">
            {savedAt && !dirty ? (
              <span className="text-[10.5px] text-accent">{savedAt} 已保存</span>
            ) : null}
            <GhostButton size="sm" onClick={() => void resetAll()} disabled={!presets || presetSaving}>
              全部恢复默认
            </GhostButton>
            <GhostButton size="sm" active={dirty} onClick={() => void save()} disabled={!dirty || presetSaving}>
              保存
            </GhostButton>
          </div>
        ) : null
      }
    >
      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[188px_minmax(0,1fr)] lg:gap-10">
        <aside className="flex flex-row flex-wrap gap-1 border-b border-hair pb-4 lg:sticky lg:top-8 lg:flex-col lg:border-b-0 lg:border-r lg:pb-0 lg:pr-5">
          {[
            ["models", "模型服务"],
            ["relations", "关系判定"],
            ["mcp", "MCP 工具"],
          ].map(([id, label]) => {
            const active = activeSection === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveSection(id as "models" | "relations" | "mcp")}
                className={`rounded-lg px-3 py-2.5 text-left transition-colors duration-[var(--dur-fast)] ${
                  active ? "bg-hair/50 text-ink" : "text-ink-3 hover:bg-hair/25"
                }`}
              >
                <span className="block text-[12px]">{label}</span>
              </button>
            );
          })}
        </aside>

        <div className="min-w-0">
          {activeSection === "models" ? (
            <ModelSection />
          ) : null}

          {activeSection === "relations" ? (
            <section>
              <SectionHead
                title="关系判定"
                note="改动只影响之后新建或并入的星空"
              />
              {presets === null ? (
                <p className="text-[12.5px] text-ink-4">正在读取…</p>
              ) : (
                <>
                  {presetError ? (
                    <p className="mb-3 text-[11px] text-warm">{presetError}</p>
                  ) : null}
                  <RelationStudio
                    presets={presets}
                    baseline={baseline}
                    onChange={update}
                    onReset={resetOne}
                    onAdd={addPreset}
                    onRemove={removePreset}
                  />
                </>
              )}
            </section>
          ) : null}

          {activeSection === "mcp" ? <McpSection /> : null}

        </div>
      </div>
    </SecondaryPage>
  );
}

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

function ModelSection() {
  const [settings, setSettings] = useState<ModelSettingsDto | null>(null);
  const [providerDraft, setProviderDraft] = useState<ModelProviderId>("openai");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providerModalOpen, setProviderModalOpen] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [editingProviderHasKey, setEditingProviderHasKey] = useState(false);
  const [removeProviderId, setRemoveProviderId] = useState<string | null>(null);
  const [testingProvider, setTestingProvider] = useState(false);
  const [providerTest, setProviderTest] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [providerModels, setProviderModels] = useState<
    NonNullable<ProviderModelsResponse["models"]>
  >([]);
  const [providerForm, setProviderForm] = useState({
    name: "",
    apiKey: "",
    baseUrl: "",
    modelIds: [] as string[],
  });
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [embeddingDraft, setEmbeddingDraft] = useState({ accountId: "", model: "" });

  const boundEmbeddingAccountId = settings?.embedding.accountId ?? "";
  const boundEmbeddingModel = settings?.embedding.model ?? "";

  useEffect(() => {
    setEmbeddingDraft({
      accountId: boundEmbeddingAccountId,
      model: boundEmbeddingModel,
    });
  }, [boundEmbeddingAccountId, boundEmbeddingModel]);

  useEffect(() => {
    void getModelSettings()
      .then(setSettings)
      .catch((e) => setError(e instanceof Error ? e.message : "读取模型设置失败"));
  }, []);

  /** 点击服务商卡片 = 直接进入添加,不再需要「先选中、再点按钮」这一步。 */
  const openAddProvider = (providerId: ModelProviderId) => {
    if (!settings) return;
    const preset = providerPreset(providerId);
    setProviderDraft(providerId);
    setProviderForm({
      name: preset.label,
      apiKey: "",
      baseUrl: preset.baseUrl,
      modelIds: preset.models[0] ? [preset.models[0].model] : [],
    });
    setProviderModels(
      dedupeModels(
        preset.models.map((model) => ({
          id: model.model,
          name: model.name,
          modalities: model.modalities,
        })),
      ),
    );
    setEditingProviderId(null);
    setEditingProviderHasKey(false);
    setProviderTest(null);
    setModelPickerOpen(false);
    setProviderModalOpen(true);
  };

  const openEditProvider = (account: ProviderAccountDto) => {
    const models = settings?.models.filter((model) => model.accountId === account.id) ?? [];
    const preset = providerPreset(account.provider);
    setProviderDraft(account.provider);
    setProviderForm({
      name: account.name,
      apiKey: "",
      baseUrl: account.baseUrl,
      modelIds: [...new Set(models.map((model) => model.model))],
    });
    setProviderModels(
      dedupeModels([
        ...preset.models.map((model) => ({
          id: model.model,
          name: model.name,
          modalities: model.modalities,
        })),
        ...models
          .filter((model) => !preset.models.some((item) => item.model === model.model))
          .map((model) => ({
            id: model.model,
            name: model.name,
            modalities: model.modalities,
          })),
      ]),
    );
    setEditingProviderId(account.id);
    setEditingProviderHasKey(account.hasApiKey);
    setProviderTest(null);
    setModelPickerOpen(false);
    setProviderModalOpen(true);
  };

  /** 只测 Base URL + Key 是否连得上 —— 与「获取模型清单」互不代劳。 */
  const testProviderDraft = async () => {
    if (!providerForm.baseUrl.trim()) return;
    if (!providerForm.apiKey.trim() && !editingProviderHasKey) return;
    setTestingProvider(true);
    setProviderTest({ ok: false, message: "正在检测 Base URL…" });
    try {
      const result = await probeProvider({
        accountId: editingProviderId ?? undefined,
        provider: providerDraft,
        baseUrl: providerForm.baseUrl.trim(),
        apiKey: providerForm.apiKey.trim() || undefined,
      });
      setProviderTest({
        ok: result.ok,
        message: result.ok
          ? result.message ?? "连接正常"
          : result.error ?? "连接失败",
      });
    } catch (e) {
      setProviderTest({
        ok: false,
        message: e instanceof Error ? e.message : "连接测试失败",
      });
    } finally {
      setTestingProvider(false);
    }
  };

  /** 拉取厂商模型清单,只负责「给用户挑」,不承担连接测试。 */
  const loadProviderModels = async () => {
    if (!providerForm.baseUrl.trim()) {
      setProviderTest({ ok: false, message: "请先填写 API Base URL" });
      return;
    }
    if (!providerForm.apiKey.trim() && !editingProviderHasKey) {
      setProviderTest({ ok: false, message: "请先填写 API Key" });
      return;
    }
    setFetchingModels(true);
    setProviderTest(null);
    try {
      const result = await fetchProviderModels({
        accountId: editingProviderId ?? undefined,
        provider: providerDraft,
        baseUrl: providerForm.baseUrl.trim(),
        apiKey: providerForm.apiKey.trim() || undefined,
      });
      if (!result.ok || !result.models?.length) {
        setProviderTest({
          ok: false,
          message: result.error ?? "连接成功,但没有读取到可用模型",
        });
        return;
      }
      const fetched = result.models;
      setProviderModels((current) => {
        const manual = current.filter(
          (model) =>
            !fetched.some((item) => item.id === model.id) &&
            providerForm.modelIds.includes(model.id),
        );
        return [...fetched, ...manual];
      });
      setModelPickerOpen(true);
      setProviderTest({ ok: true, message: `已获取 ${fetched.length} 个模型` });
    } catch (e) {
      setProviderTest({
        ok: false,
        message: e instanceof Error ? e.message : "获取模型清单失败",
      });
    } finally {
      setFetchingModels(false);
    }
  };

  const toggleModel = (id: string) => {
    setProviderForm((current) => ({
      ...current,
      modelIds: current.modelIds.includes(id)
        ? current.modelIds.filter((item) => item !== id)
        : [...current.modelIds, id],
    }));
  };

  /** 手动输入一个清单里没有的模型 ID:补进候选,再选中。 */
  const addManualModel = (raw: string) => {
    const id = raw.trim();
    if (!id) return;
    setProviderModels((current) =>
      current.some((model) => model.id === id)
        ? current
        : [
            ...current,
            {
              id,
              name: id,
              modalities: inferModelModalities(providerDraft, id),
            },
          ],
    );
    setProviderForm((current) =>
      current.modelIds.includes(id)
        ? current
        : { ...current, modelIds: [...current.modelIds, id] },
    );
  };

  const addAccount = () => {
    if (!settings || !providerForm.name.trim() || !providerForm.baseUrl.trim()) return;
    const accountId = editingProviderId ?? makeId("account");
    const previous = settings.accounts.find((account) => account.id === accountId);
    const account: ProviderAccountDto = {
      id: accountId,
      provider: providerDraft,
      name: providerForm.name.trim(),
      baseUrl: providerForm.baseUrl.trim().replace(/\/+$/, ""),
      hasApiKey: Boolean(providerForm.apiKey.trim()) || Boolean(previous?.hasApiKey),
      apiKey: providerForm.apiKey.trim(),
    };
    const addedModels: ModelSettingsDto["models"] = providerModels
      .filter((model) => providerForm.modelIds.includes(model.id))
      .map((model) => ({
        id: makeId("model"),
        accountId,
        name: model.name,
        model: model.id,
        modalities: [...model.modalities],
      }));
    const previousModels = settings.models.filter(
      (model) => model.accountId === accountId,
    );
    const mergedModels = addedModels.map((model) => {
      const existing = previousModels.find((item) => item.model === model.model);
      return existing ? { ...model, id: existing.id } : model;
    });
    const removedIds = new Set(
      previousModels
        .filter((model) => !mergedModels.some((item) => item.model === model.model))
        .map((model) => model.id),
    );
    const next: ModelSettingsDto = {
      ...settings,
      accounts: previous
        ? settings.accounts.map((item) => (item.id === accountId ? account : item))
        : [...settings.accounts, account],
      models: [
        ...settings.models.filter((model) => model.accountId !== accountId),
        ...mergedModels,
      ],
      services: {
        relation:
          settings.services.relation && removedIds.has(settings.services.relation)
            ? null
            : settings.services.relation,
        ask:
          settings.services.ask && removedIds.has(settings.services.ask)
            ? null
            : settings.services.ask,
        translate:
          settings.services.translate && removedIds.has(settings.services.translate)
            ? null
            : settings.services.translate,
      },
    };
    setSettings(next);
    setEditingProviderId(null);
    setProviderModalOpen(false);
    void persistSettings(next);
  };

  const persistSettings = async (next: ModelSettingsDto) => {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveModelSettings({
        accounts: next.accounts,
        models: next.models,
        services: next.services,
        embedding: next.embedding,
      });
      setSettings(saved);
      setSavedAt(new Date().toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存模型设置失败");
    } finally {
      setSaving(false);
    }
  };

  const removeAccount = (id: string) => {
    if (!settings) return;
    const modelIds = new Set(
      settings.models.filter((model) => model.accountId === id).map((model) => model.id),
    );
    const next: ModelSettingsDto = {
      ...settings,
      accounts: settings.accounts.filter((account) => account.id !== id),
      models: settings.models.filter((model) => model.accountId !== id),
      services: {
        relation:
          settings.services.relation && modelIds.has(settings.services.relation)
            ? null
            : settings.services.relation,
        ask:
          settings.services.ask && modelIds.has(settings.services.ask)
            ? null
            : settings.services.ask,
        translate:
          settings.services.translate && modelIds.has(settings.services.translate)
            ? null
            : settings.services.translate,
      },
      embedding:
        settings.embedding.accountId === id
          ? { accountId: null, model: "" }
          : settings.embedding,
    };
    setSettings(next);
    void persistSettings(next);
  };

  const saveEmbedding = (draft: { accountId: string; model: string }) => {
    if (!settings) return;
    const embedding = {
      accountId: draft.accountId || null,
      model: draft.model.trim(),
    };
    if (
      settings.embedding.accountId === embedding.accountId &&
      settings.embedding.model === embedding.model
    ) {
      return;
    }
    const next: ModelSettingsDto = {
      ...settings,
      embedding,
    };
    setSettings(next);
    void persistSettings(next);
  };

  const usableModels =
    settings?.models.filter((model) => {
      const account = settings.accounts.find((item) => item.id === model.accountId);
      return Boolean(account?.hasApiKey || account?.apiKey);
    }) ?? [];
  const addProviderPreset = providerPreset(providerDraft);
  const addedProviders = new Set(settings?.accounts.map((account) => account.provider) ?? []);
  const hasSelectedModels = providerForm.modelIds.length > 0;
  return (
    <section className="flex flex-col gap-4">
      {error ? <p className="text-[11px] text-alert">{error}</p> : null}

      <div className="rounded-xl border border-hair px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-[16px] font-medium tracking-[0.02em] text-ink">添加服务商</h2>
            <span className="text-[10.5px] text-ink-4">点击卡片添加</span>
          </div>
          {savedAt ? <span className="text-[10.5px] text-accent">{savedAt} 已保存</span> : null}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {PROVIDER_PRESETS.map((provider) => {
            const added = addedProviders.has(provider.id);
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => openAddProvider(provider.id)}
                disabled={!settings}
                aria-label={`添加 ${provider.label} 服务商`}
                title={provider.note}
                className="group relative flex min-h-[78px] flex-col items-center justify-center gap-2 rounded-lg border border-hair px-2 py-3 text-center text-ink-3 transition-colors duration-[var(--dur-fast)] hover:border-accent/45 hover:bg-accent/8 hover:text-accent disabled:pointer-events-none disabled:opacity-50"
              >
                <ProviderMark provider={provider.id} />
                <span className="text-[10px] leading-tight">{provider.label}</span>
                {added ? (
                  <span className="absolute right-1.5 top-1.5 rounded-full bg-accent/12 px-1.5 py-px text-[9px] leading-none text-accent">
                    已添加
                  </span>
                ) : (
                  <span
                    aria-hidden="true"
                    className="absolute right-1.5 top-1.5 text-[13px] leading-none opacity-0 transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100"
                  >
                    +
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {settings === null ? (
        <p className="text-[12px] text-ink-4">正在读取模型设置…</p>
      ) : (
        <div className="rounded-xl border border-hair px-5 py-4">
          <h2 className="text-[16px] font-medium tracking-[0.02em] text-ink">
            已保存服务商
          </h2>
          <div className="mt-3 flex flex-col gap-3">
            {settings.accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                onRemove={() => setRemoveProviderId(account.id)}
                onEdit={() => openEditProvider(account)}
              />
            ))}
            {!settings.accounts.length ? (
              <p className="text-[11px] text-ink-4">暂无服务商</p>
            ) : null}
          </div>
        </div>
      )}

      {settings ? (
        <div className="rounded-xl border border-hair px-5 py-4">
          <h2 className="text-[16px] font-medium tracking-[0.02em] text-ink">
            服务绑定
          </h2>
          <div className="mt-4 flex flex-col divide-y divide-hair">
            {MODEL_SERVICES.map((service) => {
              return (
                <ServiceBinding
                  key={service.id}
                  label={service.label}
                  value={settings.services[service.id]}
                  models={usableModels}
                  accounts={settings.accounts}
                  onChange={(id) => {
                    const next: ModelSettingsDto = {
                      ...settings,
                      services: { ...settings.services, [service.id]: id || null },
                    };
                    setSettings(next);
                    void persistSettings(next);
                  }}
                />
              );
            })}
            <EmbeddingBinding
              draft={embeddingDraft}
              accounts={settings.accounts}
              bound={Boolean(settings.embedding.accountId && settings.embedding.model)}
              onChange={(patch) => {
                setEmbeddingDraft((current) => ({ ...current, ...patch }));
              }}
              onCommit={saveEmbedding}
            />
          </div>
        </div>
      ) : null}

      <Modal
        open={providerModalOpen}
        onClose={() => setProviderModalOpen(false)}
        label={`${editingProviderId ? "修改" : "添加"} ${addProviderPreset.label} 服务商`}
        className="max-w-[580px]"
      >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="text-ink-2">
                  <ProviderMark provider={providerDraft} />
                </span>
                <h2 className="text-[16px] font-medium text-ink">
                  {editingProviderId ? "修改服务商" : "添加服务商"}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setProviderModalOpen(false)}
                className="text-[11px] text-ink-4 hover:text-ink-2"
              >
                关闭
              </button>
            </div>

            <div className="mt-4 flex flex-col gap-3">
              <label>
                <span className="mb-1.5 block text-[10px] text-ink-4">服务商名称</span>
                <input
                  value={providerForm.name}
                  onChange={(event) =>
                    setProviderForm((current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-hair-2 bg-hair/20 px-3 py-2 text-[11.5px] text-ink outline-none focus:border-accent/45"
                />
              </label>
              <label>
                <span className="mb-1.5 block text-[10px] text-ink-4">API Key</span>
                <input
                  type="password"
                  autoComplete="off"
                  value={providerForm.apiKey}
                  onChange={(event) =>
                    setProviderForm((current) => ({
                      ...current,
                      apiKey: event.target.value,
                    }))
                  }
                  placeholder={
                    editingProviderHasKey
                      ? "已保存密钥，留空则保持不变"
                      : "输入 API Key"
                  }
                  className="w-full rounded-lg border border-hair-2 bg-hair/20 px-3 py-2 font-mono text-[11px] text-ink outline-none focus:border-accent/45"
                />
              </label>
              <label>
                <span className="mb-1.5 block text-[10px] text-ink-4">API Base URL</span>
                <input
                  value={providerForm.baseUrl}
                  onChange={(event) =>
                    setProviderForm((current) => ({
                      ...current,
                      baseUrl: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-hair-2 bg-hair/20 px-3 py-2 font-mono text-[11px] text-ink outline-none focus:border-accent/45"
                />
              </label>

              <div>
                <span className="mb-1.5 block text-[10px] text-ink-4">模型</span>
                <ModelPicker
                  selected={providerForm.modelIds}
                  options={providerModels}
                  open={modelPickerOpen}
                  fetching={fetchingModels}
                  onOpenChange={setModelPickerOpen}
                  onToggle={toggleModel}
                  onAdd={addManualModel}
                  onFetch={() => void loadProviderModels()}
                />
              </div>
            </div>

            {providerTest ? (
              <p
                role="status"
                aria-live="polite"
                className={`mt-3 flex items-center gap-2 text-[10.5px] ${
                  providerTest.ok ? "text-accent" : "text-warm"
                }`}
              >
                <span
                  className={`h-1 w-1 shrink-0 rounded-full ${
                    providerTest.ok ? "bg-accent" : "bg-warm"
                  }`}
                  aria-hidden="true"
                />
                {providerTest.message}
              </p>
            ) : null}

            <div className="mt-5 flex justify-end gap-2">
              <GhostButton
                size="sm"
                shape="rect"
                onClick={() => setProviderModalOpen(false)}
              >
                取消
              </GhostButton>
              <GhostButton
                size="sm"
                shape="rect"
                onClick={() => void testProviderDraft()}
                disabled={
                  testingProvider ||
                  (!providerForm.apiKey.trim() && !editingProviderHasKey) ||
                  !providerForm.baseUrl.trim()
                }
              >
                {testingProvider ? "测试中…" : "测试连接"}
              </GhostButton>
              <GhostButton
                size="sm"
                shape="rect"
                active
                onClick={addAccount}
                disabled={
                  !providerForm.name.trim() ||
                  !providerForm.baseUrl.trim() ||
                  !hasSelectedModels ||
                  saving
                }
              >
                {saving ? "保存中…" : "确定"}
              </GhostButton>
            </div>
      </Modal>

      <Modal
        open={Boolean(removeProviderId)}
        onClose={() => setRemoveProviderId(null)}
        label="确认移除服务商"
        className="max-w-[420px]"
      >
        <h2 className="text-[16px] font-medium text-ink">确认移除服务商</h2>
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-3">
          移除后,该服务商及其模型会从设置中删除,相关服务绑定也会解除。
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <GhostButton size="sm" onClick={() => setRemoveProviderId(null)}>
            取消
          </GhostButton>
          <GhostButton
            size="sm"
            onClick={() => {
              if (removeProviderId) removeAccount(removeProviderId);
              setRemoveProviderId(null);
            }}
          >
            确认移除
          </GhostButton>
        </div>
      </Modal>

    </section>
  );
}

function AccountCard({
  account,
  onRemove,
  onEdit,
}: {
  account: ProviderAccountDto;
  onRemove: () => void;
  onEdit: () => void;
}) {
  const preset = providerPreset(account.provider);
  return (
    <div className="flex items-center gap-3 rounded-lg border border-hair px-3 py-2.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-hair bg-hair/25 text-ink-2">
        <ProviderMark provider={account.provider} size={18} />
      </span>
      <span className="min-w-0 flex-1 text-[12px] text-ink-2">{account.name || preset.label}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onEdit}
          aria-label={`修改${account.name}`}
          title="修改"
          className="grid h-7 w-7 place-items-center rounded-md text-ink-4 transition-colors hover:bg-hair/50 hover:text-ink"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M11.4 2.1l2.5 2.5-8.2 8.2-3.2.7.7-3.2 8.2-8.2z"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`移除${account.name}`}
          title="移除"
          className="grid h-7 w-7 place-items-center rounded-md text-ink-4 transition-colors hover:bg-alert/10 hover:text-alert"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.6 8h4.8l.6-8M7 7v3.5M9 7v3.5"
              stroke="currentColor"
              strokeWidth="1.2"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

function ServiceBinding({
  label,
  value,
  models,
  accounts,
  onChange,
}: {
  label: string;
  value: string | null;
  models: ModelSettingsDto["models"];
  accounts: ProviderAccountDto[];
  onChange: (id: string) => void;
}) {
  const sorted = [...models].sort((a, b) => {
    const aVision = a.modalities.includes("vision") ? 1 : 0;
    const bVision = b.modalities.includes("vision") ? 1 : 0;
    if (aVision !== bVision) return bVision - aVision;
    const aProvider = accounts.find((account) => account.id === a.accountId)?.name ?? "";
    const bProvider = accounts.find((account) => account.id === b.accountId)?.name ?? "";
    return aProvider.localeCompare(bProvider) || a.name.localeCompare(b.name);
  });
  return (
    <div className="grid grid-cols-1 items-center gap-3 py-3 first:pt-0 last:pb-0 md:grid-cols-[180px_1fr] md:gap-5">
      <div>
        <p className="text-[12px] text-ink-2">{label}</p>
      </div>
      <SelectMenu
        value={value ?? ""}
        onChange={onChange}
        ariaLabel={`选择${label}模型`}
        options={[
          { value: "", label: "未绑定" },
          ...sorted.map((model) => ({
            value: model.id,
            label: `${
              accounts.find((account) => account.id === model.accountId)?.name ??
              "未知服务商"
            } · ${model.name}`,
            note: model.model,
            group: model.modalities.includes("vision")
              ? "多模态模型"
              : "文本模型",
          })),
        ]}
      />
    </div>
  );
}

function EmbeddingBinding({
  draft,
  accounts,
  bound,
  onChange,
  onCommit,
}: {
  draft: { accountId: string; model: string };
  accounts: ProviderAccountDto[];
  bound: boolean;
  onChange: (patch: Partial<{ accountId: string; model: string }>) => void;
  onCommit: (draft: { accountId: string; model: string }) => void;
}) {
  const usableAccounts = accounts.filter((account) => account.hasApiKey || account.apiKey);
  return (
    <div className="grid grid-cols-1 items-center gap-3 py-3 last:pb-0 md:grid-cols-[180px_1fr] md:gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="group relative inline-flex items-center gap-1.5">
          <span className="text-[12px] text-ink-2">向量检索</span>
          <span
            role="img"
            tabIndex={0}
            aria-label="向量检索说明"
            className="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-hair-2 text-[9px] leading-none text-ink-4 outline-none transition-colors duration-[var(--dur-fast)] hover:border-accent/45 hover:text-accent focus-visible:border-accent/45"
          >
            ?
          </span>
          <span
            role="tooltip"
            className="pointer-events-none absolute left-0 top-full z-20 mt-2 w-[260px] rounded-lg border border-hair bg-bg px-3 py-2 text-[10.5px] font-normal leading-relaxed text-ink-3 opacity-0 shadow-[0_10px_28px_rgba(0,0,0,0.12)] transition-opacity duration-[var(--dur-fast)] group-hover:opacity-100 group-focus-within:opacity-100"
          >
            在 BM25 词面检索之外，用向量模型补充语义召回；两路结果融合后交给问答模型。未绑定或调用失败时自动退回词面检索。
          </span>
        </span>
        <span
          className={`rounded-full border px-1.5 py-0.5 font-mono text-[9px] ${
            bound
              ? "border-accent/30 text-accent/90"
              : "border-hair-2 text-ink-4"
          }`}
        >
          {bound ? "混合召回" : "词面召回"}
        </span>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[160px_minmax(0,1fr)]">
        <SelectMenu
          value={draft.accountId}
          onChange={(accountId) => {
            const next = { accountId, model: accountId ? draft.model : "" };
            onChange(next);
            onCommit(next);
          }}
          ariaLabel="选择向量模型服务商账户"
          options={[
            { value: "", label: "未绑定" },
            ...usableAccounts.map((account) => ({
              value: account.id,
              label: account.name,
              note: providerPreset(account.provider).label,
            })),
          ]}
        />
        <input
          value={draft.model}
          onChange={(event) => onChange({ model: event.target.value })}
          onBlur={() => onCommit(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          placeholder="向量模型 ID · 例如 text-embedding-3-small"
          aria-label="向量模型 ID"
          spellCheck={false}
          className="h-[38px] w-full rounded-lg border border-hair-2 bg-hair/20 px-3 font-mono text-[11px] text-ink outline-none transition-colors duration-[var(--dur-fast)] placeholder:text-ink-4/70 focus:border-accent/45"
        />
      </div>
    </div>
  );
}

/**
 * 品牌图标。SVG 取自各家官方标识(LobeHub 官方图标库与服务商自己的站点),
 * 用 mask 而非 <img> 渲染:形状是官方的,颜色跟着主题走。
 */
function ProviderMark({
  provider,
  size = 32,
}: {
  provider: ModelProviderId;
  size?: number;
}) {
  return (
    <span
      aria-hidden="true"
      className="shrink-0 bg-current"
      style={{
        width: size,
        height: size,
        maskImage: `url(/icons/providers/${provider}.svg)`,
        WebkitMaskImage: `url(/icons/providers/${provider}.svg)`,
        maskPosition: "center",
        WebkitMaskPosition: "center",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        maskSize: "contain",
        WebkitMaskSize: "contain",
      }}
    />
  );
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// 关系预设
// ---------------------------------------------------------------------------

/** 关系族:只用于信息架构,不参与判定。 */
const RELATION_FAMILIES: Array<{ id: RelationFamily; label: string; note: string }> = [
  { id: "lineage", label: "谱系", note: "谁站在谁的肩膀上" },
  { id: "comparison", label: "对照", note: "平行工作之间的差异" },
  { id: "conflict", label: "冲突", note: "结论是否互相拆台" },
  { id: "custom", label: "其他", note: "自定义关系" },
];

const familyOf = (preset: RelationPreset): RelationFamily => preset.family ?? "custom";

/** 只比较会影响判定结果的字段,用来判断某条是否偏离默认。 */
function presetSignature(preset: RelationPreset): string {
  return JSON.stringify({
    description: preset.description,
    definition: preset.definition,
    negativeExamples: preset.negativeExamples,
    directed: preset.directed,
    hardConstraints: preset.hardConstraints,
    evidencePolicy: preset.evidencePolicy,
    visual: preset.visual,
    maxPerSeed: preset.maxPerSeed,
    enabled: preset.enabled,
  });
}

/**
 * 关系工作台。
 *
 * 六条规则不是六个独立开关,而是一张有结构的分类表:先按关系族分组,
 * 再在右侧编辑「前置条件 → 证据标准 → rubric → 产出上限」。
 * 左侧只负责选择与状态,右侧才承担编辑,避免每张卡都摊开一遍相同控件。
 */
function RelationStudio({
  presets,
  baseline,
  onChange,
  onReset,
  onAdd,
  onRemove,
}: {
  presets: RelationPreset[];
  baseline: RelationPreset[];
  onChange: (id: string, patch: Partial<RelationPreset>) => void;
  onReset: (id: string) => void;
  onAdd: (preset: RelationPreset) => void;
  onRemove: (id: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string>(presets[0]?.id ?? "");
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CustomPresetInput>({
    label: "",
    labelEn: "",
    description: "",
    definition: "",
    negativeExamples: "",
    family: "custom",
    directed: false,
    evidencePolicy: "textual",
  });
  const selected = presets.find((preset) => preset.id === selectedId) ?? presets[0];
  const base = selected ? baseline.find((preset) => preset.id === selected.id) : undefined;
  const changed = selected
    ? !selected.builtin || (base ? presetSignature(selected) !== presetSignature(base) : false)
    : false;
  const enabledCount = presets.filter((preset) => preset.enabled).length;
  const groups = RELATION_FAMILIES.map((family) => ({
    ...family,
    items: presets.filter((preset) => familyOf(preset) === family.id),
  })).filter((group) => group.items.length > 0);

  useEffect(() => {
    if (presets.some((preset) => preset.id === selectedId)) return;
    setSelectedId(presets[0]?.id ?? "");
  }, [presets, selectedId]);

  const openCreate = () => {
    setDraft({
      label: "",
      labelEn: "",
      description: "",
      definition: "",
      negativeExamples: "",
      family: "custom",
      directed: false,
      evidencePolicy: "textual",
    });
    setCreateError(null);
    setCreateOpen(true);
  };

  const create = () => {
    const problem = validateCustomPreset(draft, presets);
    if (problem) {
      setCreateError(problem);
      return;
    }
    const preset = makeCustomPreset(draft, presets);
    onAdd(preset);
    setSelectedId(preset.id);
    setCreateOpen(false);
  };

  return (
    <div className="rounded-xl border border-hair">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hair px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-ink-4">
          <PipelineStep index="1" label="硬约束" />
          <span className="h-px w-4 bg-hair-2" aria-hidden="true" />
          <PipelineStep index="2" label="多标签判定" />
          <span className="h-px w-4 bg-hair-2" aria-hidden="true" />
          <PipelineStep index="3" label="证据校验" />
        </div>
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[9.5px] text-ink-4">
            {enabledCount}/{presets.length} 启用
          </span>
          <GhostButton
            size="sm"
            shape="rect"
            onClick={openCreate}
            disabled={presets.length >= MAX_RELATION_PRESETS}
            title={
              presets.length >= MAX_RELATION_PRESETS
                ? `最多 ${MAX_RELATION_PRESETS} 条关系`
                : "新建一条由你定义的关系"
            }
          >
            + 新建关系
          </GhostButton>
        </div>
      </div>

      <div className="grid md:grid-cols-[210px_minmax(0,1fr)]">
        <aside className="border-b border-hair p-2 md:border-r md:border-b-0">
          <div className="flex flex-wrap gap-1 md:flex-col md:gap-0">
            {groups.map((group, groupIndex) => (
              <div
                key={group.id}
                className={`flex flex-wrap items-center gap-1 md:block ${
                  groupIndex > 0 ? "ml-1 border-l border-hair pl-1 md:ml-0 md:border-l-0 md:pl-0 md:mt-2" : ""
                }`}
              >
                <p
                  className="hidden px-2.5 pt-2 pb-1 text-[9px] tracking-[0.14em] text-ink-4 uppercase md:block"
                  title={group.note}
                >
                  {group.label}
                </p>
                <div className="flex flex-wrap items-center gap-1 md:flex-col md:gap-0.5">
                  {group.items.map((preset) => {
                    const active = preset.id === selected?.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => setSelectedId(preset.id)}
                        aria-current={active ? "true" : undefined}
                        className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)] md:w-full md:gap-2.5 md:rounded-lg md:px-2.5 md:py-2 ${
                          active ? "bg-hair/45" : "hover:bg-hair/25"
                        } ${preset.enabled ? "" : "opacity-55"}`}
                      >
                        <span className="hidden md:block">
                          <RelationGlyph preset={preset} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block truncate text-[10.5px] md:text-[11.5px] ${active ? "text-ink" : "text-ink-2"}`}
                          >
                            {preset.label}
                          </span>
                          <span className="mt-0.5 hidden truncate font-mono text-[8.5px] text-ink-4 md:block">
                            {preset.labelEn}
                          </span>
                        </span>
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                            preset.enabled ? "bg-accent" : "border border-ink-4/50"
                          }`}
                          aria-hidden="true"
                        />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </aside>

        {selected ? (
          <RelationDetail
            preset={selected}
            changed={changed}
            onChange={(patch) => onChange(selected.id, patch)}
            onReset={() => onReset(selected.id)}
            onRemove={() => onRemove(selected.id)}
          />
        ) : (
          <p className="px-5 py-6 text-[11.5px] text-ink-4">没有可编辑的关系规则。</p>
        )}
      </div>

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        label="新建关系"
        className="max-w-[640px]"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-medium text-ink">新建关系</h2>
            <p className="mt-1 text-[10.5px] leading-relaxed text-ink-4">
              名称与 rubric 会直接进入多标签判定提示词;创建后仍可继续调整前置条件与产出上限。
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreateOpen(false)}
            className="text-[11px] text-ink-4 hover:text-ink-2"
          >
            关闭
          </button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <TextField
            label="中文名称"
            value={draft.label}
            maxLength={24}
            placeholder="例如:因果关系"
            onChange={(label) => setDraft((current) => ({ ...current, label }))}
          />
          <TextField
            label="英文名称"
            value={draft.labelEn}
            maxLength={48}
            placeholder="例如:Causal link"
            onChange={(labelEn) => setDraft((current) => ({ ...current, labelEn }))}
          />
        </div>

        <TextField
          label="一句话说明"
          value={draft.description}
          maxLength={400}
          placeholder="这条关系在图上意味着什么?"
          onChange={(description) => setDraft((current) => ({ ...current, description }))}
        />

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <span className="mb-1.5 block text-[10px] text-ink-4">关系族</span>
            <Segmented<RelationFamily>
              value={draft.family}
              ariaLabel="关系族"
              options={RELATION_FAMILIES.map((family) => ({
                value: family.id,
                label: family.label,
              }))}
              onChange={(family) => setDraft((current) => ({ ...current, family }))}
            />
          </div>
          <div>
            <span className="mb-1.5 block text-[10px] text-ink-4">方向</span>
            <Segmented<"directed" | "undirected">
              value={draft.directed ? "directed" : "undirected"}
              ariaLabel="关系方向"
              options={[
                { value: "undirected", label: "无向" },
                { value: "directed", label: "有向" },
              ]}
              onChange={(direction) =>
                setDraft((current) => ({ ...current, directed: direction === "directed" }))
              }
            />
          </div>
        </div>

        <div className="mt-3">
          <span className="mb-1.5 block text-[10px] text-ink-4">证据标准</span>
          <Segmented<RelationPreset["evidencePolicy"]>
            value={draft.evidencePolicy}
            ariaLabel="证据标准"
            options={[
              { value: "textual", label: "原文片段" },
              { value: "structural", label: "结构事实" },
            ]}
            onChange={(evidencePolicy) =>
              setDraft((current) => ({ ...current, evidencePolicy }))
            }
          />
          <p className="mt-1 text-[9.5px] leading-relaxed text-ink-4">
            原文片段更严格:拿不到可核验的摘要原句,这条边会被丢弃。
          </p>
        </div>

        <TextArea
          label="判定标准 · 什么算"
          value={draft.definition}
          onChange={(definition) => setDraft((current) => ({ ...current, definition }))}
        />
        <TextArea
          label="反例 · 什么不算"
          value={draft.negativeExamples}
          onChange={(negativeExamples) =>
            setDraft((current) => ({ ...current, negativeExamples }))
          }
        />

        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-[9.5px] text-ink-4">id 由英文名自动生成,判定版本从 v1 开始。</p>
          {createError ? (
            <p role="alert" className="text-[10px] text-warm">
              {createError}
            </p>
          ) : null}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <GhostButton size="sm" shape="rect" onClick={() => setCreateOpen(false)}>
            取消
          </GhostButton>
          <GhostButton size="sm" shape="rect" active onClick={create}>
            创建关系
          </GhostButton>
        </div>
      </Modal>
    </div>
  );
}

function PipelineStep({ index, label }: { index: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="grid h-4 w-4 place-items-center rounded-full border border-hair-2 font-mono text-[8px] text-ink-3">
        {index}
      </span>
      <span>{label}</span>
    </span>
  );
}

/** 左侧列表里的微型边样例 —— 颜色与虚实直接对应用户在星图里看到的边。 */
function RelationGlyph({ preset }: { preset: RelationPreset }) {
  const dashed = preset.visual.dash && preset.visual.dash !== "none";
  return (
    <svg
      width="26"
      height="10"
      viewBox="0 0 26 10"
      aria-hidden="true"
      className={preset.enabled ? "shrink-0" : "shrink-0 opacity-50"}
    >
      <line
        x1="1"
        y1="5"
        x2={preset.directed ? "21" : "25"}
        y2="5"
        stroke={preset.visual.tone}
        strokeWidth="1.2"
        strokeDasharray={dashed ? preset.visual.dash : undefined}
        strokeLinecap="round"
      />
      {preset.directed ? (
        <path
          d="M20 2.2 L25 5 L20 7.8"
          fill="none"
          stroke={preset.visual.tone}
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}

function RelationDetail({
  preset,
  changed,
  onChange,
  onReset,
  onRemove,
}: {
  preset: RelationPreset;
  changed: boolean;
  onChange: (patch: Partial<RelationPreset>) => void;
  onReset: () => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => setEditing(false), [preset.id]);
  useEffect(() => setConfirmRemove(false), [preset.id]);

  const constraints = preset.hardConstraints;
  const family = RELATION_FAMILIES.find((item) => item.id === familyOf(preset));
  const citationMode = constraints.requireCitation
    ? "require"
    : constraints.requireMutualNonCitation
      ? "forbid"
      : "any";
  const yearGap = typeof constraints.maxYearGap === "number" ? constraints.maxYearGap : null;
  const similarity =
    typeof constraints.minSimilarity === "number" ? constraints.minSimilarity : null;
  const version = preset.promptVersion.split("@")[1] ?? preset.promptVersion;

  const setConstraints = (patch: Partial<RelationPreset["hardConstraints"]>) =>
    onChange({ hardConstraints: { ...constraints, ...patch } });

  return (
    <div className="min-w-0 px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[15px] font-medium tracking-[0.02em] text-ink">
              {preset.label}
            </h3>
            <span className="font-mono text-[10px] text-ink-4">{preset.labelEn}</span>
            <span className="rounded-full border border-hair-2 px-1.5 py-px text-[9px] text-ink-4">
              {family?.label ?? "其他"}
            </span>
            <span className="rounded-full border border-hair-2 px-1.5 py-px text-[9px] text-ink-4">
              {preset.directed ? "有向" : "无向"}
            </span>
            {!preset.builtin ? (
              <span className="rounded-full border border-accent/40 px-1.5 py-px text-[9px] text-accent">
                自定义
              </span>
            ) : null}
            {changed && preset.builtin ? (
              <span className="rounded-full border border-accent/40 px-1.5 py-px text-[9px] text-accent">
                已改
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 text-[11.5px] leading-[1.8] text-ink-3">
            {preset.description}
          </p>
        </div>
        <Switch
          checked={preset.enabled}
          onChange={(value) => onChange({ enabled: value })}
          label={`启用${preset.label}`}
        />
      </div>

      {!preset.builtin ? (
        <div className="mt-3 rounded-lg border border-hair bg-hair/10 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="名称"
              value={preset.label}
              maxLength={24}
              onChange={(label) => onChange({ label })}
            />
            <TextField
              label="英文名"
              value={preset.labelEn}
              maxLength={48}
              onChange={(labelEn) => onChange({ labelEn })}
            />
          </div>
          <TextField
            label="一句话说明"
            value={preset.description}
            maxLength={400}
            className="mt-3"
            onChange={(description) => onChange({ description })}
          />
        </div>
      ) : null}

      <div className="mt-5 border-t border-hair pt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-[10px] tracking-[0.14em] text-ink-4 uppercase">判定条件</h4>
          <span className="text-[9.5px] text-ink-4">纯代码过滤,不花 token</span>
        </div>
        <div className="mt-1 divide-y divide-hair">
          <ControlRow label="引用条件" hint="引用方向决定有向关系里谁是 A、谁是 B">
            <Segmented
              value={citationMode}
              ariaLabel="引用条件"
              options={[
                { value: "any", label: "不限" },
                { value: "require", label: "必须引用" },
                { value: "forbid", label: "互不引用" },
              ]}
              onChange={(mode) =>
                setConstraints({
                  requireCitation: mode === "require",
                  requireMutualNonCitation: mode === "forbid",
                })
              }
            />
          </ControlRow>

          <ControlRow label="年份差上限" hint="超过跨度的论文对不送审">
            <div className="flex items-center gap-2">
              <NumberStepper
                value={yearGap}
                min={0}
                max={60}
                suffix="年"
                disabled={yearGap === null}
                onChange={(value) => setConstraints({ maxYearGap: value })}
              />
              <MiniToggle
                active={yearGap === null}
                onClick={() => setConstraints({ maxYearGap: yearGap === null ? 8 : null })}
              >
                不限
              </MiniToggle>
            </div>
          </ControlRow>

          <ControlRow label="共享主题" hint="两篇至少在 OpenAlex topic 上有交集">
            <Switch
              checked={Boolean(constraints.requireSharedTask)}
              onChange={(value) => setConstraints({ requireSharedTask: value })}
              label="要求共享任务"
            />
          </ControlRow>

          <ControlRow label="文本相似度" hint="摘要 TF-IDF 余弦,低于阈值不送审">
            <div className="flex items-center gap-2.5">
              <input
                type="range"
                min={0}
                max={0.6}
                step={0.01}
                value={similarity ?? 0.2}
                disabled={similarity === null}
                onChange={(event) => setConstraints({ minSimilarity: Number(event.target.value) })}
                aria-label="文本相似度下限"
                className="h-1 w-24 disabled:opacity-40"
                style={{ accentColor: "var(--accent)" }}
              />
              <span className="w-8 text-right font-mono text-[10.5px] text-ink-2">
                {similarity === null ? "—" : similarity.toFixed(2)}
              </span>
              <MiniToggle
                active={similarity === null}
                onClick={() => setConstraints({ minSimilarity: similarity === null ? 0.2 : null })}
              >
                不限
              </MiniToggle>
            </div>
          </ControlRow>

          <ControlRow
            label="证据标准"
            hint={
              preset.evidencePolicy === "textual"
                ? "必须有可回查的原文片段,否则丢弃这条边"
                : "允许用引用记录与元数据作为证据"
            }
          >
            <Segmented
              value={preset.evidencePolicy}
              ariaLabel="证据标准"
              options={[
                { value: "structural", label: "结构事实" },
                { value: "textual", label: "原文片段" },
              ]}
              onChange={(value) => onChange({ evidencePolicy: value })}
            />
          </ControlRow>
        </div>
      </div>

      <div className="mt-5 border-t border-hair pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h4 className="text-[10px] tracking-[0.14em] text-ink-4 uppercase">判定标准</h4>
            <p className="mt-0.5 text-[9.5px] text-ink-4">送进模型的 rubric 与反例</p>
          </div>
          <GhostButton size="sm" shape="rect" onClick={() => setEditing((value) => !value)}>
            {editing ? "收起" : "编辑"}
          </GhostButton>
        </div>
        {editing ? (
          <div className="mt-2">
            <TextArea
              label="判定标准 · 什么算"
              value={preset.definition}
              onChange={(value) => onChange({ definition: value })}
            />
            <TextArea
              label="反例 · 什么不算"
              value={preset.negativeExamples}
              onChange={(value) => onChange({ negativeExamples: value })}
            />
            <p className="mt-2 text-[9.5px] text-ink-4">
              保存时版本自动 +1,只有这条关系的旧结论失效;其它关系仍命中缓存。
            </p>
          </div>
        ) : (
          <div className="mt-2 rounded-lg border border-hair bg-hair/10 px-3 py-2.5">
            <p className="line-clamp-2 text-[10.5px] leading-[1.8] text-ink-3">
              {renderEmphasis(preset.definition)}
            </p>
            <p className="mt-1 line-clamp-2 text-[10px] leading-[1.8] text-ink-4">
              反例:{renderEmphasis(preset.negativeExamples)}
            </p>
          </div>
        )}
      </div>

      <div className="mt-5 border-t border-hair pt-3">
        <div className="divide-y divide-hair">
          <ControlRow label="每篇种子最多保留" hint="超出上限的关系不再写入星图">
            <NumberStepper
              value={preset.maxPerSeed}
              min={1}
              max={20}
              suffix="条"
              onChange={(value) => onChange({ maxPerSeed: value })}
            />
          </ControlRow>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-hair pt-3">
        <span className="font-mono text-[9.5px] text-ink-4">
          rubric v{version}
          {!preset.builtin ? " · 自定义关系" : changed ? " · 已偏离默认" : " · 与默认一致"}
        </span>
        {!preset.builtin ? (
          confirmRemove ? (
            <div className="flex items-center gap-2">
              <GhostButton size="sm" shape="rect" onClick={() => setConfirmRemove(false)}>
                取消
              </GhostButton>
              <button
                type="button"
                onClick={onRemove}
                className="rounded-md border border-alert/45 px-3 py-[5px] text-[11px] text-alert transition-colors duration-[var(--dur-fast)] hover:border-alert/75"
              >
                确认删除
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmRemove(true)}
              className="rounded-md border border-alert/35 px-3 py-[5px] text-[11px] text-alert transition-colors duration-[var(--dur-fast)] hover:border-alert/70"
            >
              删除关系
            </button>
          )
        ) : changed ? (
          <GhostButton size="sm" shape="rect" onClick={onReset}>
            恢复此条
          </GhostButton>
        ) : null}
      </div>
    </div>
  );
}

function ControlRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <span className="block text-[11px] text-ink-2">{label}</span>
        <span className="mt-0.5 block text-[9.5px] leading-relaxed text-ink-4">{hint}</span>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex rounded-md border border-hair-2 p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`rounded-[4px] px-2 py-1 text-[10px] transition-colors duration-[var(--dur-fast)] ${
              active ? "bg-hair/70 text-ink" : "text-ink-4 hover:text-ink-2"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function NumberStepper({
  value,
  min,
  max,
  suffix,
  disabled = false,
  onChange,
}: {
  value: number | null;
  min: number;
  max: number;
  suffix?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const current = value ?? min;
  return (
    <div
      className={`inline-flex items-center rounded-md border border-hair-2 ${
        disabled ? "opacity-40" : ""
      }`}
    >
      <button
        type="button"
        aria-label="减少"
        disabled={disabled || current <= min}
        onClick={() => onChange(Math.max(min, current - 1))}
        className="grid h-7 w-6 place-items-center text-[11px] text-ink-4 transition-colors duration-[var(--dur-fast)] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        −
      </button>
      <span className="w-8 text-center font-mono text-[10.5px] text-ink-2">
        {value ?? "—"}
      </span>
      <button
        type="button"
        aria-label="增加"
        disabled={disabled || current >= max}
        onClick={() => onChange(Math.min(max, current + 1))}
        className="grid h-7 w-6 place-items-center text-[11px] text-ink-4 transition-colors duration-[var(--dur-fast)] hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        +
      </button>
      {suffix ? <span className="pr-2 text-[9.5px] text-ink-4">{suffix}</span> : null}
    </div>
  );
}

function MiniToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-md border px-2 py-1 text-[9.5px] transition-colors duration-[var(--dur-fast)] ${
        active
          ? "border-accent/40 text-accent"
          : "border-hair-2 text-ink-4 hover:text-ink-2"
      }`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/**
 * MCP 工具集。
 *
 * 沿用设置页统一的卡片语言:一张卡讲连接,一张卡列工具,一张卡给配置。
 * 内容保持克制 —— 端点一行、工具一行一个、配置可直接复制。
 */
function McpSection() {
  const [origin, setOrigin] = useState("http://localhost:3000");
  const [tokens, setTokens] = useState<McpTokenSummary[] | null>(null);
  const [tokenName, setTokenName] = useState("Claude Code");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ token: string; id: string } | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
    void fetchMcpTokens()
      .then(setTokens)
      .catch(() => setTokens([]));
  }, []);

  const endpoint = `${origin}/api/mcp`;
  const config = httpClientConfig(origin, created?.token);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setTokenError(null);
    try {
      const result = await createMcpToken(tokenName.trim() || "默认令牌");
      setTokens((prev) => [result.summary, ...(prev ?? [])]);
      setCreated({ token: result.token, id: result.summary.id });
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : "生成令牌失败");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: string) => {
    if (revokingId) return;
    setRevokingId(id);
    setTokenError(null);
    try {
      await revokeMcpToken(id);
      setTokens((prev) => (prev ?? []).filter((token) => token.id !== id));
      if (created?.id === id) setCreated(null);
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : "撤销令牌失败");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <section>
      <SectionHead title="MCP 工具" />

      <div className="rounded-xl border border-hair px-5 py-4">
        <h2 className="text-[16px] font-medium tracking-[0.02em] text-ink">连接</h2>
        <div className="mt-2 flex flex-col divide-y divide-hair">
          <ConnectionRow
            label="HTTP 端点"
            value={endpoint}
            note="需个人令牌"
          />
          <ConnectionRow label="stdio 入口" value="pnpm mcp" note="需 STELLARLIT_MCP_TOKEN" />
          <div className="flex items-start gap-4 py-3">
            <span className="w-[76px] shrink-0 text-[11px] text-ink-4">安全边界</span>
            <p className="text-[11.5px] leading-[1.9] text-ink-2">
              9 个工具全部声明{" "}
              <code className="font-mono text-[11px] text-ink-3">readOnlyHint</code>
              ,不写文件、不改星空、不触发判定。协议自检见{" "}
              <code className="font-mono text-[11px] text-ink-3">pnpm check:mcp</code>。
            </p>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-hair px-5 py-4">
        <h2 className="text-[16px] font-medium tracking-[0.02em] text-ink">工具清单</h2>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {MCP_TOOLS.map((tool) => (
            <div
              key={tool.name}
              className="flex min-h-[96px] flex-col gap-1.5 rounded-lg border border-hair bg-hair/10 px-3.5 py-3"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 text-[11.5px] leading-tight text-ink">
                  {tool.title}
                </span>
                <span
                  className={`shrink-0 rounded-full border px-1.5 py-px text-[9px] leading-none ${
                    tool.openWorld
                      ? "border-hair-2 text-ink-4"
                      : "border-accent/30 text-accent/85"
                  }`}
                >
                  {tool.openWorld ? "联网" : "本地"}
                </span>
              </div>
              <code className="block truncate font-mono text-[10px] text-ink-3">
                {tool.name}
              </code>
              <span className="mt-auto block text-[10.5px] leading-relaxed text-ink-3">
                {tool.note}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-hair px-5 py-4">
        <h2 className="text-[16px] font-medium tracking-[0.02em] text-ink">接入配置</h2>
        <div className="mt-3 flex flex-col gap-4">
          <div className="rounded-lg border border-hair-2 bg-hair/10 px-3.5 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[11.5px] text-ink-2">个人访问令牌</p>
                <p className="mt-0.5 text-[10.5px] text-ink-4">
                  每个令牌只读取它所属账号的星空。原始令牌只显示一次。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={tokenName}
                  onChange={(event) => setTokenName(event.target.value.slice(0, 40))}
                  placeholder="令牌名称"
                  className="h-7 w-[132px] rounded-md border border-hair-2 bg-bg/40 px-2 text-[11px] text-ink outline-none transition-colors focus:border-accent/45"
                />
                <GhostButton type="button" size="sm" onClick={() => void create()} disabled={creating}>
                  {creating ? "生成中…" : "生成令牌"}
                </GhostButton>
              </div>
            </div>

            {created ? (
              <div className="mt-3 rounded-md border border-accent/30 bg-accent/[0.06] px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[10.5px] text-accent">请现在复制，关闭后不再显示</p>
                  <CopyButton text={created.token} label="复制令牌" />
                </div>
                <code className="mt-1.5 block overflow-x-auto font-mono text-[10.5px] whitespace-nowrap text-ink-2">
                  {created.token}
                </code>
              </div>
            ) : null}

            {tokens === null ? (
              <p className="mt-3 text-[10.5px] text-ink-4">正在读取令牌…</p>
            ) : tokens.length ? (
              <div className="mt-2 divide-y divide-hair">
                {tokens.map((token) => (
                  <div key={token.id} className="flex items-center gap-3 py-2">
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-2">{token.name}</span>
                    <span className="shrink-0 font-mono text-[9px] text-ink-4">
                      {token.lastUsedAt ? `最近使用 ${formatDate(token.lastUsedAt)}` : "尚未使用"}
                    </span>
                    <button
                      type="button"
                      onClick={() => void revoke(token.id)}
                      disabled={revokingId === token.id}
                      className="shrink-0 text-[10px] text-ink-4 transition-colors hover:text-alert disabled:opacity-50"
                    >
                      {revokingId === token.id ? "撤销中…" : "撤销"}
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-[10.5px] text-ink-4">
                还没有令牌。生成后把下面的配置复制给 MCP 客户端。
              </p>
            )}
            {tokenError ? <p className="mt-2 text-[10.5px] text-alert">{tokenError}</p> : null}
          </div>

          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
              <span className="text-[11.5px] text-ink-2">
                Cursor / 任意 Streamable HTTP 客户端
              </span>
              <CopyButton text={config} label="复制 JSON" />
            </div>
            <pre className="mt-1.5 overflow-x-auto rounded-lg border border-hair-2 bg-hair/20 px-3 py-2.5 font-mono text-[11px] leading-[1.85] whitespace-pre text-ink-3">
              {config}
            </pre>
          </div>
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
              <span className="text-[11.5px] text-ink-2">Claude Code</span>
              <CopyButton text={claudeCodeCommand(origin)} label="复制命令" />
            </div>
            <pre className="mt-1.5 overflow-x-auto rounded-lg border border-hair-2 bg-hair/20 px-3 py-2.5 font-mono text-[11px] leading-[1.85] whitespace-pre text-ink-3">
              {claudeCodeCommand(origin, created?.token)}
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}

function ConnectionRow({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="flex items-center gap-4 py-3">
      <span className="w-[76px] shrink-0 text-[11px] text-ink-4">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">
        {value}
      </code>
      <span className="hidden shrink-0 text-[10px] text-ink-4 sm:inline">{note}</span>
      <CopyButton text={value} />
    </div>
  );
}

function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [pulse, setPulse] = useState(0);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setPulse((value) => value + 1);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <GhostButton
      size="sm"
      active={copied}
      className="relative min-w-[58px]"
      onClick={() => void copy()}
    >
      <span key={pulse} className="copy-label-in inline-flex items-center justify-center">
        {copied ? "已复制" : label}
      </span>
      {pulse > 0 ? <span key={`ring-${pulse}`} className="copy-ring" aria-hidden="true" /> : null}
    </GhostButton>
  );
}

// ---------------------------------------------------------------------------
// 小件
// ---------------------------------------------------------------------------

function dedupeModels<T extends { id: string }>(models: T[]): T[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

/**
 * 模型选择器。
 *
 * 一个控件解决三件事:已选模型变成行内标签、可直接输入清单外的模型 ID、
 * 右侧按需拉取厂商清单。清单放在浮层里,不把弹窗撑高 ——
 * 因此它始终只占一行,选得再多也只是标签换行。
 */
function ModelPicker({
  selected,
  options,
  open,
  fetching,
  onOpenChange,
  onToggle,
  onAdd,
  onFetch,
}: {
  selected: string[];
  options: NonNullable<ProviderModelsResponse["models"]>;
  open: boolean;
  fetching: boolean;
  onOpenChange: (open: boolean) => void;
  onToggle: (id: string) => void;
  onAdd: (id: string) => void;
  onFetch: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [placement, setPlacement] = useState<"bottom" | "top">("top");
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 弹窗底部空间不够时向上展开:浮层不该被裁掉,也不该盖住底部按钮。
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom;
      const above = rect.top;
      // 这个控件总在弹窗靠下位置:默认向上,只有上方确实放不下才向下。
      setPlacement(above >= 240 || above >= below ? "top" : "bottom");
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) setFilter("");
  }, [open]);

  const byId = new Map(options.map((model) => [model.id, model]));
  const chosen: Array<{ id: string; name: string; modalities: ModelModality[] }> = [
    ...new Set(selected),
  ].map((id) => byId.get(id) ?? { id, name: id, modalities: [] as ModelModality[] });
  const keyword = filter.trim().toLowerCase();
  const filtered = keyword
    ? options.filter((model) =>
        `${model.id} ${model.name}`.toLowerCase().includes(keyword),
      )
    : options;

  const commit = () => {
    const value = query.trim();
    if (!value) return;
    const match =
      options.find((model) => model.id === value) ??
      options.find((model) => model.name.toLowerCase() === value.toLowerCase());
    if (match) {
      if (!selected.includes(match.id)) onToggle(match.id);
    } else {
      onAdd(value);
    }
    setQuery("");
    onOpenChange(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <div
        className={`flex min-h-[38px] flex-wrap items-center gap-1.5 rounded-lg border bg-hair/20 px-2 py-1.5 transition-colors duration-[var(--dur-fast)] ${
          open ? "border-accent/45" : "border-hair-2"
        }`}
      >
        {chosen.map((model) => (
          <span
            key={model.id}
            title={model.id}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-hair-2 bg-bg/60 py-0.5 pr-1 pl-1.5 text-[10px] text-ink-2"
          >
            <span className="max-w-[150px] truncate">{model.name}</span>
            <button
              type="button"
              aria-label={`移除 ${model.name}`}
              onClick={() => onToggle(model.id)}
              className="text-[11px] leading-none text-ink-4 transition-colors duration-[var(--dur-fast)] hover:text-alert"
            >
              ×
            </button>
          </span>
        ))}
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => onOpenChange(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
            if (event.key === "Backspace" && !query && chosen.length > 0) {
              onToggle(chosen[chosen.length - 1]!.id);
            }
            if (event.key === "Escape") onOpenChange(false);
          }}
          placeholder={chosen.length > 0 ? "添加模型 ID" : "输入模型 ID,回车添加"}
          className="min-w-[120px] flex-1 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:text-ink-4"
        />
        <button
          type="button"
          onClick={onFetch}
          disabled={fetching}
          className="flex shrink-0 items-center gap-1.5 border-l border-hair pl-2.5 font-mono text-[9.5px] tracking-[0.06em] text-ink-4 transition-colors duration-[var(--dur-fast)] hover:text-accent disabled:opacity-50"
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            aria-hidden="true"
            className={fetching ? "animate-spin" : ""}
          >
            <path
              d="M8.4 5a3.4 3.4 0 1 1-1-2.4M8.4 1.4v2.2H6.2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {fetching ? "获取中…" : "获取清单"}
        </button>
      </div>

      {open ? (
        <div
          className={`model-pop absolute inset-x-0 z-30 overflow-hidden rounded-lg border border-hair-2 bg-bg/95 shadow-[0_24px_60px_-24px_rgba(0,0,0,0.95)] backdrop-blur-xl ${
            placement === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"
          }`}
        >
          {options.length > 0 ? (
            <div className="flex items-center gap-2 border-b border-hair px-2.5 py-1.5">
              <svg
                width="10"
                height="10"
                viewBox="0 0 12 12"
                aria-hidden="true"
                className="shrink-0 text-ink-4"
              >
                <circle
                  cx="5"
                  cy="5"
                  r="3.4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.1"
                />
                <path
                  d="M7.6 7.6 10 10"
                  stroke="currentColor"
                  strokeWidth="1.1"
                  strokeLinecap="round"
                />
              </svg>
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="筛选模型"
                className="min-w-0 flex-1 bg-transparent py-1 text-[10.5px] text-ink outline-none placeholder:text-ink-4"
              />
              <span className="shrink-0 font-mono text-[9px] text-ink-4">
                {options.length}
              </span>
            </div>
          ) : null}
          <ul className="max-h-[min(184px,30vh)] overflow-y-auto p-1">
            {filtered.map((model) => {
              const active = selected.includes(model.id);
              return (
                <li key={model.id}>
                  <button
                    type="button"
                    onClick={() => onToggle(model.id)}
                    aria-pressed={active}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-[var(--dur-fast)] ${
                      active ? "bg-accent/8" : "hover:bg-hair/40"
                    }`}
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[10.5px] ${active ? "text-accent" : "text-ink-2"}`}
                      >
                        {model.name}
                      </span>
                      {model.name !== model.id ? (
                        <span className="block truncate font-mono text-[9px] text-ink-4">
                          {model.id}
                        </span>
                      ) : null}
                    </span>
                    {model.modalities.includes("vision") ? (
                      <span className="shrink-0 rounded-full border border-hair-2 px-1.5 py-px text-[8.5px] text-ink-4">
                        多模态
                      </span>
                    ) : null}
                    <span
                      className={`grid h-3 w-3 shrink-0 place-items-center text-accent transition-opacity duration-[var(--dur-fast)] ${
                        active ? "opacity-100" : "opacity-0"
                      }`}
                    >
                      <svg width="9" height="9" viewBox="0 0 8 8" aria-hidden="true">
                        <path
                          d="M1.4 4.2 L3.2 6 L6.6 2.2"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                  </button>
                </li>
              );
            })}
            {!filtered.length ? (
              <li className="flex flex-col items-center gap-1.5 px-4 py-6 text-center">
                <span className="grid h-6 w-6 place-items-center rounded-full border border-hair-2 text-ink-4">
                  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                    <path
                      d="M1.5 6h9M6 1.5v9"
                      stroke="currentColor"
                      strokeWidth="1.1"
                      strokeLinecap="round"
                    />
                  </svg>
                </span>
                <span className="text-[10px] text-ink-4">
                  {options.length > 0
                    ? "没有匹配的模型"
                    : "还没有清单,点右侧「获取清单」"}
                </span>
                {options.length === 0 ? (
                  <span className="font-mono text-[9px] text-ink-4/70">
                    也可以直接输入模型 ID
                  </span>
                ) : null}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function SectionHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 className="text-[13.5px] tracking-[0.06em] text-ink">{title}</h2>
      {note ? <span className="text-[10.5px] text-ink-4">{note}</span> : null}
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

function TextField({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1.5 block text-[10px] text-ink-4">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        spellCheck={false}
        className="w-full rounded-lg border border-hair-2 bg-hair/20 px-3 py-2 text-[11.5px] text-ink outline-none transition-colors duration-[var(--dur-fast)] placeholder:text-ink-4/70 focus:border-accent/45"
      />
    </label>
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
        maxLength={2000}
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

