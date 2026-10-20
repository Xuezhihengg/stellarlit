"use client";

import { useCallback, useEffect, useState } from "react";

import { SecondaryPage } from "@/components/shell/SecondaryPage";
import { GhostButton } from "@/components/ui/GhostButton";
import { Modal } from "@/components/ui/Modal";
import { SelectMenu } from "@/components/ui/SelectMenu";
import {
  fetchProviderModels,
  fetchPresets,
  getModelSettings,
  saveModelSettings,
  testLlm,
  type ProviderModelsResponse,
} from "@/lib/api/client";
import {
  inferModelModalities,
  MODEL_SERVICES,
  PROVIDER_PRESETS,
  providerPreset,
} from "@/lib/models/catalog";
import {
  clearPresetOverrides,
  loadPresetOverrides,
  mergePresets,
  savePresetOverrides,
} from "@/lib/presets/local";
import type { RelationPreset } from "@/types/kg";
import type {
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
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<"models" | "relations" | "privacy">(
    "models",
  );

  useEffect(() => {
    void (async () => {
      try {
        const builtin = await fetchPresets();
        setBaseline(builtin);
        setPresets(mergePresets(builtin, loadPresetOverrides()));
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
      actions={
        activeSection === "relations" ? (
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
        ) : null
      }
    >
      <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[188px_minmax(0,1fr)] lg:gap-10">
        <aside className="flex flex-row flex-wrap gap-1 border-b border-hair pb-4 lg:sticky lg:top-8 lg:flex-col lg:border-b-0 lg:border-r lg:pb-0 lg:pr-5">
          {[
            ["models", "模型服务"],
            ["relations", "关系判定"],
            ["privacy", "数据与隐私"],
          ].map(([id, label]) => {
            const active = activeSection === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() =>
                  setActiveSection(id as "models" | "relations" | "privacy")
                }
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
              <SectionHead title="关系判定" />
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
          ) : null}

          {activeSection === "privacy" ? (
            <section>
              <SectionHead title="数据与隐私" />
              <div className="rounded-xl border border-hair px-5 py-4">
                <Row label="账号">
                  这一版不需要登录。星空和关系设置只保存在本机。
                </Row>
                <Row label="出网的数据">
                  论文标题与 ID 会发往 OpenAlex 与 arXiv;摘要及你主动上传的图表会发往当前服务绑定的模型。
                </Row>
                <Row label="密钥">
                  设置页提交的厂商密钥保存在本机服务端的{" "}
                  <code className="font-mono text-ink-3">data/model-settings.json</code>,
                  文件权限为仅当前用户可读。读取接口只返回掩码,不会把密钥原文发回浏览器。
                </Row>
                <Row label="兼容配置">
                  未在设置页绑定的服务仍可回退到{" "}
                  <code className="font-mono text-ink-3">.env.local</code> 中的 LLM 配置。
                </Row>
              </div>
            </section>
          ) : null}
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
    customModel: "",
    customModelName: "",
  });

  useEffect(() => {
    void getModelSettings()
      .then(setSettings)
      .catch((e) => setError(e instanceof Error ? e.message : "读取模型设置失败"));
  }, []);

  const openProviderModal = () => {
    const preset = providerPreset(providerDraft);
    setProviderForm({
      name: preset.label,
      apiKey: "",
      baseUrl: preset.baseUrl,
      modelIds: preset.models[0] ? [preset.models[0].model] : [],
      customModel: "",
      customModelName: "",
    });
    setProviderModels(
      preset.models.map((model) => ({
        id: model.model,
        name: model.name,
        modalities: model.modalities,
      })),
    );
    setEditingProviderId(null);
    setEditingProviderHasKey(false);
    setProviderTest(null);
    setProviderModalOpen(true);
  };

  const openEditProvider = (account: ProviderAccountDto) => {
    const models = settings?.models.filter((model) => model.accountId === account.id) ?? [];
    const preset = providerPreset(account.provider);
    const custom = models.find(
      (model) => !preset.models.some((item) => item.model === model.model),
    );
    setProviderDraft(account.provider);
    setProviderForm({
      name: account.name,
      apiKey: "",
      baseUrl: account.baseUrl,
      modelIds: models
        .filter((model) => preset.models.some((item) => item.model === model.model))
        .map((model) => model.model),
      customModel: custom?.model ?? "",
      customModelName: custom?.name ?? "",
    });
    setProviderModels([
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
    ]);
    setEditingProviderId(account.id);
    setEditingProviderHasKey(account.hasApiKey);
    setProviderTest(null);
    setProviderModalOpen(true);
  };

  const testProviderDraft = async () => {
    if (!providerForm.baseUrl.trim()) return;
    if (!providerForm.apiKey.trim() && !editingProviderHasKey) return;
    const candidateModel =
      providerForm.customModel.trim() || providerForm.modelIds[0] || "";
    setTestingProvider(true);
    setProviderTest({ ok: false, message: "正在读取服务商模型列表…" });
    try {
      const result = await fetchProviderModels({
        accountId: editingProviderId ?? undefined,
        provider: providerDraft,
        baseUrl: providerForm.baseUrl.trim(),
        apiKey: providerForm.apiKey.trim() || undefined,
      });
      if (!result.ok || !result.models?.length) {
        const canFallback = /HTTP (404|405)/.test(result.error ?? "");
        if (candidateModel && canFallback) {
          const fallback = await testLlm({
            accountId: editingProviderId ?? undefined,
            provider: providerDraft,
            baseUrl: providerForm.baseUrl.trim(),
            apiKey: providerForm.apiKey.trim() || undefined,
            model: candidateModel,
          });
          if (fallback.ok) {
            setProviderTest({
              ok: true,
              message: "API Key 有效，当前模型连接正常",
            });
            return;
          }
        }
        setProviderTest({
          ok: false,
          message:
            result.error ??
            (candidateModel
              ? "API Key 或模型 ID 不正确"
              : "连接成功,但没有读取到可用模型"),
        });
        return;
      }
      setProviderModels(result.models);
      setProviderForm((current) => {
        const stillAvailable = current.modelIds.filter((id) =>
          result.models!.some((model) => model.id === id),
        );
        return {
          ...current,
          modelIds:
            stillAvailable.length > 0
              ? stillAvailable
              : [result.models![0]!.id],
        };
      });
      setProviderTest({
        ok: true,
        message: `连接成功,读取到 ${result.models.length} 个模型`,
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
    if (providerForm.customModel.trim()) {
      addedModels.push({
        id: makeId("model"),
        accountId,
        name: providerForm.customModelName.trim() || providerForm.customModel.trim(),
        model: providerForm.customModel.trim(),
        modalities: inferModelModalities(providerDraft, providerForm.customModel.trim()),
      });
    }
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
  const hasSelectedModels =
    providerForm.modelIds.length > 0 || Boolean(providerForm.customModel.trim());
  return (
    <section className="flex flex-col gap-4">
      {error ? <p className="text-[11px] text-alert">{error}</p> : null}

      <div className="rounded-xl border border-hair px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[16px] font-medium tracking-[0.02em] text-ink">添加服务商</h2>
          {savedAt ? <span className="text-[10.5px] text-accent">{savedAt} 已保存</span> : null}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {PROVIDER_PRESETS.map((provider) => {
            const active = providerDraft === provider.id;
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => setProviderDraft(provider.id)}
                aria-pressed={active}
                className={`flex min-h-[78px] flex-col items-center justify-center gap-2 rounded-lg border px-2 py-3 text-center transition-colors duration-[var(--dur-fast)] ${
                  active
                    ? "border-accent/45 bg-accent/8 text-accent"
                    : "border-hair text-ink-3 hover:border-hair-2 hover:bg-hair/25"
                }`}
              >
                <ProviderMark provider={provider.id} />
                <span className="text-[10px] leading-tight">{provider.label}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex justify-end">
          <GhostButton size="sm" onClick={openProviderModal} disabled={!settings}>
            添加服务商
          </GhostButton>
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
                <p className="mb-2 text-[10px] text-ink-4">模型清单</p>
                <div className="flex flex-col gap-2">
                  {providerModels.map((model) => (
                    <label
                      key={model.id}
                      className="flex items-center gap-3 rounded-lg border border-hair px-3 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={providerForm.modelIds.includes(model.id)}
                        onChange={(event) =>
                          setProviderForm((current) => ({
                            ...current,
                            modelIds: event.target.checked
                              ? [...current.modelIds, model.id]
                              : current.modelIds.filter(
                                  (id) => id !== model.id,
                                ),
                          }))
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] text-ink-2">
                          {model.name}
                        </span>
                        <span className="block font-mono text-[9.5px] text-ink-4">
                          {model.id}
                        </span>
                      </span>
                      <span className="text-[9.5px] text-ink-4">
                        {model.modalities.includes("vision") ? "多模态" : "文本"}
                      </span>
                    </label>
                  ))}
                  <div className="grid grid-cols-2 gap-2">
                      <input
                        value={providerForm.customModel}
                        onChange={(event) =>
                          setProviderForm((current) => ({
                            ...current,
                            customModel: event.target.value,
                          }))
                        }
                        placeholder="模型 ID"
                        className="rounded-lg border border-hair-2 bg-hair/20 px-3 py-2 font-mono text-[11px] text-ink outline-none focus:border-accent/45"
                      />
                      <input
                        value={providerForm.customModelName}
                        onChange={(event) =>
                          setProviderForm((current) => ({
                            ...current,
                            customModelName: event.target.value,
                          }))
                        }
                        placeholder="显示名"
                        className="rounded-lg border border-hair-2 bg-hair/20 px-3 py-2 text-[11px] text-ink outline-none focus:border-accent/45"
                      />
                  </div>
                </div>
              </div>
            </div>

            {providerTest ? (
              <p
                className={`mt-3 rounded-lg border px-3 py-2 text-[10.5px] ${
                  providerTest.ok
                    ? "border-accent/30 text-accent"
                    : "border-warm/35 text-warm"
                }`}
              >
                {providerTest.message}
              </p>
            ) : null}

            <div className="mt-5 flex justify-end gap-2">
              <GhostButton size="sm" onClick={() => setProviderModalOpen(false)}>
                取消
              </GhostButton>
              <GhostButton
                size="sm"
                onClick={() => void testProviderDraft()}
                disabled={
                  testingProvider ||
                  (!providerForm.apiKey.trim() && !editingProviderHasKey) ||
                  !providerForm.baseUrl.trim() ||
                  !hasSelectedModels
                }
              >
                {testingProvider ? "测试中…" : "测试连接"}
              </GhostButton>
              <GhostButton
                size="sm"
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
      <span className="shrink-0 text-ink-3">
        <ProviderMark provider={account.provider} />
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

function ProviderMark({ provider }: { provider: ModelProviderId }) {
  return (
    <span
      aria-hidden="true"
      className="h-8 w-8 bg-current"
      style={{
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
