"use client";

import { useCallback, useEffect, useState } from "react";

import { SecondaryPage } from "@/components/shell/SecondaryPage";
import { GhostButton } from "@/components/ui/GhostButton";
import { SelectMenu } from "@/components/ui/SelectMenu";
import {
  fetchPresets,
  getModelSettings,
  saveModelSettings,
  testLlm,
  type LlmHealth,
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
  const [modelDraft, setModelDraft] = useState({
    accountId: "",
    model: "",
    name: "",
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, LlmHealth>>({});
  const [testingId, setTestingId] = useState<string | null>(null);

  useEffect(() => {
    void getModelSettings()
      .then(setSettings)
      .catch((e) => setError(e instanceof Error ? e.message : "读取模型设置失败"));
  }, []);

  useEffect(() => {
    if (!settings?.accounts.length) return;
    setModelDraft((current) => {
      const currentAccount = settings.accounts.find(
        (account) => account.id === current.accountId,
      );
      if (currentAccount && current.model) return current;
      const account = settings.accounts[0]!;
      const first = providerPreset(account.provider).models[0];
      return {
        accountId: account.id,
        model: first?.model ?? "",
        name: first?.name ?? "",
      };
    });
  }, [settings?.accounts]);

  const change = (fn: (current: ModelSettingsDto) => ModelSettingsDto) => {
    setSettings((current) => (current ? fn(current) : current));
    setDirty(true);
    setSavedAt(null);
  };

  const addAccount = () => {
    const preset = providerPreset(providerDraft);
    const accountId = makeId("account");
    const account: ProviderAccountDto = {
      id: accountId,
      provider: providerDraft,
      name: preset.label,
      baseUrl: preset.baseUrl,
      hasApiKey: false,
      apiKey: "",
    };
    change((current) => ({
      ...current,
      accounts: [...current.accounts, account],
    }));
  };

  const updateAccount = (id: string, patch: Partial<ProviderAccountDto>) => {
    change((current) => ({
      ...current,
      accounts: current.accounts.map((account) =>
        account.id === id ? { ...account, ...patch } : account,
      ),
    }));
  };

  const removeAccount = (id: string) => {
    change((current) => {
      const modelIds = new Set(
        current.models.filter((model) => model.accountId === id).map((model) => model.id),
      );
      return {
        ...current,
        accounts: current.accounts.filter((account) => account.id !== id),
        models: current.models.filter((model) => model.accountId !== id),
        services: {
          relation:
            current.services.relation && modelIds.has(current.services.relation)
              ? null
              : current.services.relation,
          ask:
            current.services.ask && modelIds.has(current.services.ask)
              ? null
              : current.services.ask,
          translate:
            current.services.translate && modelIds.has(current.services.translate)
              ? null
              : current.services.translate,
        },
      };
    });
  };

  const removeModel = (id: string) => {
    change((current) => ({
      ...current,
      models: current.models.filter((model) => model.id !== id),
      services: {
        relation: current.services.relation === id ? null : current.services.relation,
        ask: current.services.ask === id ? null : current.services.ask,
        translate: current.services.translate === id ? null : current.services.translate,
      },
    }));
  };

  const testModel = async (id: string) => {
    setTestingId(id);
    setHealth((current) => ({ ...current, [id]: { ok: false, error: "测试中…" } }));
    try {
      const result = await testLlm(id);
      setHealth((current) => ({ ...current, [id]: result }));
    } catch (e) {
      setHealth((current) => ({
        ...current,
        [id]: { ok: false, error: e instanceof Error ? e.message : "自检失败" },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveModelSettings({
        accounts: settings.accounts,
        models: settings.models,
        services: settings.services,
      });
      setSettings(saved);
      setDirty(false);
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

  const draftAccount = settings?.accounts.find(
    (account) => account.id === modelDraft.accountId,
  );
  const draftPreset = providerPreset(draftAccount?.provider ?? "custom");

  const saveDraftModel = () => {
    if (!draftAccount || !modelDraft.model.trim()) return;
    change((current) => {
      if (
        current.models.some(
          (model) =>
            model.accountId === draftAccount.id &&
            model.model === modelDraft.model.trim(),
        )
      ) {
        return current;
      }
      return {
        ...current,
        models: [
          ...current.models,
          {
            id: makeId("model"),
            accountId: draftAccount.id,
            name: modelDraft.name.trim() || modelDraft.model.trim(),
            model: modelDraft.model.trim(),
            modalities: inferModelModalities(
              draftAccount.provider,
              modelDraft.model.trim(),
            ),
          },
        ],
      };
    });
    setModelDraft((current) => ({ ...current, model: "", name: "" }));
  };

  const usableModels =
    settings?.models.filter((model) => {
      const account = settings.accounts.find((item) => item.id === model.accountId);
      return Boolean(account?.hasApiKey || account?.apiKey);
    }) ?? [];
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-5">
        <h2 className="text-[18px] tracking-[0.02em] text-ink">添加服务商</h2>
        <div className="flex shrink-0 items-center gap-2">
          {savedAt ? <span className="text-[10.5px] text-accent">{savedAt} 已保存</span> : null}
          <GhostButton size="sm" active={dirty} onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? "保存中…" : "保存模型设置"}
          </GhostButton>
        </div>
      </div>

      {error ? <p className="text-[11px] text-alert">{error}</p> : null}

      <div className="rounded-xl border border-hair px-5 py-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
          <GhostButton size="sm" onClick={addAccount} disabled={!settings}>
            添加服务商
          </GhostButton>
        </div>
      </div>

      {settings === null ? (
        <p className="text-[12px] text-ink-4">正在读取模型设置…</p>
      ) : (
        <div className="flex flex-col gap-3">
          {settings.accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              onChange={(patch) => updateAccount(account.id, patch)}
              onRemove={() => removeAccount(account.id)}
            />
          ))}
        </div>
      )}

      {settings ? (
        <div className="rounded-xl border border-hair px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15px] text-ink">添加模型</h2>
            <GhostButton
              size="sm"
              onClick={saveDraftModel}
              disabled={!draftAccount || !modelDraft.model.trim()}
            >
              保存模型
            </GhostButton>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <p className="mb-1.5 text-[10px] text-ink-4">服务商</p>
              <SelectMenu
                value={modelDraft.accountId}
                ariaLabel="选择模型所属服务商"
                onChange={(accountId) => {
                  const account = settings.accounts.find((item) => item.id === accountId);
                  const first = account ? providerPreset(account.provider).models[0] : null;
                  setModelDraft({
                    accountId,
                    model: first?.model ?? "",
                    name: first?.name ?? "",
                  });
                }}
                options={settings.accounts.map((account) => ({
                  value: account.id,
                  label: account.name,
                  icon: <ProviderMark provider={account.provider} />,
                }))}
              />
            </div>
            <div>
              <p className="mb-1.5 text-[10px] text-ink-4">默认模型</p>
              <SelectMenu
                value={modelDraft.model}
                ariaLabel="选择默认模型"
                onChange={(modelId) => {
                  const selected = draftPreset.models.find(
                    (model) => model.model === modelId,
                  );
                  setModelDraft((current) => ({
                    ...current,
                    model: modelId,
                    name: selected?.name ?? modelId,
                  }));
                }}
                options={draftPreset.models.map((model) => ({
                  value: model.model,
                  label: model.name,
                  note: model.model,
                }))}
              />
            </div>
            <label>
              <span className="mb-1.5 block text-[10px] text-ink-4">模型 ID</span>
              <input
                value={modelDraft.model}
                onChange={(e) =>
                  setModelDraft((current) => ({
                    ...current,
                    model: e.target.value,
                  }))
                }
                placeholder="model-id"
                className="w-full rounded-lg border border-hair-2 bg-bg/35 px-3 py-2 font-mono text-[11px] text-ink outline-none focus:border-accent/45"
              />
            </label>
            <label>
              <span className="mb-1.5 block text-[10px] text-ink-4">显示名</span>
              <input
                value={modelDraft.name}
                onChange={(e) =>
                  setModelDraft((current) => ({ ...current, name: e.target.value }))
                }
                placeholder="模型显示名"
                className="w-full rounded-lg border border-hair-2 bg-bg/35 px-3 py-2 text-[11px] text-ink outline-none focus:border-accent/45"
              />
            </label>
          </div>
          {draftAccount && modelDraft.model ? (
            <p className="mt-3 text-[10.5px] text-ink-3">
              模态识别：
              {inferModelModalities(draftAccount.provider, modelDraft.model).includes(
                "vision",
              )
                ? "多模态"
                : "文本"}
            </p>
          ) : null}
        </div>
      ) : null}

      {settings ? (
        <div className="rounded-xl border border-hair px-5 py-4">
          <h2 className="text-[15px] text-ink">模型清单</h2>
          <div className="mt-3 flex flex-col gap-2">
            {settings.models.map((model) => {
              const account = settings.accounts.find(
                (item) => item.id === model.accountId,
              );
              const result = health[model.id];
              const multimodal = model.modalities.includes("vision");
              return (
                <div
                  key={model.id}
                  className="flex flex-wrap items-center gap-3 rounded-lg bg-hair/20 px-3 py-2.5"
                >
                  {account ? (
                    <span className="text-ink-3">
                      <ProviderMark provider={account.provider} />
                    </span>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="text-[11.5px] text-ink-2">{model.name}</p>
                    <p className="mt-0.5 font-mono text-[9.5px] text-ink-4">
                      {model.model}
                    </p>
                    {result ? (
                      <p className={`mt-1 text-[9.5px] ${result.ok ? "text-accent" : "text-warm"}`}>
                        {result.ok ? `连接正常 · ${result.latencyMs} ms` : result.error}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[9.5px] ${
                      multimodal
                        ? "border-accent/35 text-accent"
                        : "border-hair-2 text-ink-4"
                    }`}
                  >
                    {multimodal ? "多模态模型" : "文本模型"}
                  </span>
                  <button
                    type="button"
                    onClick={() => void testModel(model.id)}
                    disabled={testingId === model.id || dirty}
                    title={dirty ? "请先保存模型设置" : "测试连通性"}
                    className="text-[10px] text-ink-3 hover:text-ink"
                  >
                    {testingId === model.id ? "测试中…" : "测试"}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeModel(model.id)}
                    className="text-[10px] text-ink-4 hover:text-alert"
                  >
                    删除
                  </button>
                </div>
              );
            })}
            {!settings.models.length ? (
              <p className="text-[11px] text-ink-4">暂无模型</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {settings ? (
        <div className="rounded-xl border border-hair px-5 py-4">
          <h2 className="text-[15px] text-ink">服务绑定</h2>
          <div className="mt-4 flex flex-col divide-y divide-hair">
            {MODEL_SERVICES.map((service) => {
              return (
                <ServiceBinding
                  key={service.id}
                  label={service.label}
                  value={settings.services[service.id]}
                  models={usableModels}
                  onChange={(id) =>
                    change((current) => ({
                      ...current,
                      services: { ...current.services, [service.id]: id || null },
                    }))
                  }
                />
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function AccountCard({
  account,
  onChange,
  onRemove,
}: {
  account: ProviderAccountDto;
  onChange: (patch: Partial<ProviderAccountDto>) => void;
  onRemove: () => void;
}) {
  const preset = providerPreset(account.provider);
  return (
    <div className="rounded-xl border border-hair px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[13px] text-ink">{preset.label}</p>
          <p className="mt-0.5 text-[10px] text-ink-4">
            {account.hasApiKey ? `密钥 ${account.apiKeyHint ?? "已保存"}` : "尚未保存密钥"}
          </p>
        </div>
        <button
          type="button"
          onClick={onRemove}
          className="text-[10.5px] text-ink-4 transition-colors hover:text-alert"
        >
          移除服务商
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <label>
          <span className="mb-1 block text-[10px] text-ink-4">服务商名称</span>
          <input
            value={account.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className="w-full rounded-lg border border-hair-2 bg-bg/35 px-3 py-2 text-[11.5px] text-ink outline-none focus:border-accent/45"
          />
        </label>
        <label>
          <span className="mb-1 block text-[10px] text-ink-4">API Key</span>
          <input
            type="password"
            autoComplete="off"
            value={account.apiKey ?? ""}
            onChange={(e) =>
              onChange({
                apiKey: e.target.value,
                hasApiKey: Boolean(e.target.value) || account.hasApiKey,
              })
            }
            placeholder={account.hasApiKey ? "留空则保留现有密钥" : "输入厂商 API Key"}
            className="w-full rounded-lg border border-hair-2 bg-bg/35 px-3 py-2 font-mono text-[11px] text-ink outline-none focus:border-accent/45"
          />
        </label>
        <label className="md:col-span-2">
          <span className="mb-1 block text-[10px] text-ink-4">API Base URL</span>
          <input
            value={account.baseUrl}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            placeholder="https://…/v1"
            className="w-full rounded-lg border border-hair-2 bg-bg/35 px-3 py-2 font-mono text-[11px] text-ink outline-none focus:border-accent/45"
          />
        </label>
      </div>

    </div>
  );
}

function ServiceBinding({
  label,
  value,
  models,
  onChange,
}: {
  label: string;
  value: string | null;
  models: ModelSettingsDto["models"];
  onChange: (id: string) => void;
}) {
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
          ...models.map((model) => ({
            value: model.id,
            label: `${model.name} · ${model.model}`,
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
