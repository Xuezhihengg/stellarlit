/**
 * 模型配置解析 —— 全部按账号隔离。
 *
 * 账户、模型清单、服务绑定、向量绑定都落在 owner_id 下:切换账号就是切换
 * 整套 API Key 与模型选择,不再有「全站共用一份部署配置」的漏洞。
 * 环境变量只在当前账号没有绑定任何模型时兜底,方便纯部署 / 演示场景。
 */

import type {
  ModelModality,
  ModelProviderId,
  ModelServiceId,
  ModelSettingsDto,
  ProviderAccountDto,
  SaveModelSettingsRequest,
} from "@/types/model-settings";

import { serverConfig } from "./config";
import {
  ensureLegacyModelSettings,
  readStoredSettings,
  writeStoredSettings,
  type StoredAccount,
  type StoredSettings,
} from "./db/model-settings";

export interface ResolvedModelTarget {
  accountId: string;
  provider: ModelProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  name: string;
  modalities: ModelModality[];
}

export interface ResolvedEmbeddingTarget {
  accountId: string;
  provider: ModelProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 每进程只尝试导入一次旧的 JSON 配置;失败也不影响新账号。 */
let legacyImport: Promise<void> | undefined;

async function readStored(ownerId: string): Promise<StoredSettings | null> {
  try {
    if (ownerId === "legacy") {
      legacyImport ??= ensureLegacyModelSettings().catch(() => undefined);
      await legacyImport;
    }
    return await readStoredSettings(ownerId);
  } catch {
    return null;
  }
}

function toPublic(settings: StoredSettings | null): ModelSettingsDto {
  return {
    version: 1,
    accounts: (settings?.accounts ?? []).map(
      (account): ProviderAccountDto => ({
        id: account.id,
        provider: account.provider,
        name: account.name,
        baseUrl: account.baseUrl,
        hasApiKey: Boolean(account.apiKey),
        apiKeyHint: account.apiKey ? `••••${account.apiKey.slice(-4)}` : undefined,
      }),
    ),
    models: settings?.models ?? [],
    services: settings?.services ?? { relation: null, ask: null, translate: null },
    embedding: settings?.embedding ?? { accountId: null, model: "" },
  };
}

export async function getModelSettings(ownerId: string): Promise<ModelSettingsDto> {
  return toPublic(await readStored(ownerId));
}

export async function saveModelSettings(
  ownerId: string,
  input: SaveModelSettingsRequest,
): Promise<ModelSettingsDto> {
  const previous = await readStored(ownerId);
  const previousAccounts = new Map(
    (previous?.accounts ?? []).map((account) => [account.id, account]),
  );
  const accounts: StoredAccount[] = input.accounts.map((account) => ({
    id: account.id,
    provider: account.provider,
    name: account.name.trim(),
    baseUrl: account.baseUrl.trim().replace(/\/+$/, ""),
    apiKey:
      account.apiKey?.trim() || previousAccounts.get(account.id)?.apiKey || "",
  }));
  const accountIds = new Set(accounts.map((account) => account.id));
  const models = input.models
    .filter((model) => accountIds.has(model.accountId))
    .map((model) => ({
      ...model,
      name: model.name.trim() || model.model.trim(),
      model: model.model.trim(),
      modalities: [...new Set(model.modalities)],
    }));
  const modelIds = new Set(models.map((model) => model.id));
  const validBinding = (id: string | null): string | null =>
    id && modelIds.has(id) ? id : null;
  const settings: StoredSettings = {
    version: 1,
    accounts,
    models,
    services: {
      relation: validBinding(input.services.relation),
      ask: validBinding(input.services.ask),
      translate: validBinding(input.services.translate),
    },
    embedding: {
      accountId:
        input.embedding.accountId && accountIds.has(input.embedding.accountId)
          ? input.embedding.accountId
          : null,
      model: input.embedding.model.trim(),
    },
  };

  await writeStoredSettings(ownerId, settings);
  return toPublic(settings);
}

function envTarget(): ResolvedModelTarget | null {
  if (!serverConfig.llm.enabled) return null;
  const provider: ModelProviderId = /anthropic/i.test(serverConfig.llm.baseUrl)
    ? "anthropic"
    : "custom";
  return {
    accountId: "env-default",
    provider,
    baseUrl: serverConfig.llm.baseUrl,
    apiKey: serverConfig.llm.apiKey ?? "",
    model: serverConfig.llm.model,
    name: `环境变量 · ${serverConfig.llm.model}`,
    modalities: ["text"],
  };
}

export async function resolveModelById(
  ownerId: string,
  id: string,
): Promise<ResolvedModelTarget | null> {
  const settings = await readStored(ownerId);
  if (!settings) return null;
  const model = settings.models.find((item) => item.id === id);
  if (!model) return null;
  const account = settings.accounts.find((item) => item.id === model.accountId);
  if (!account?.apiKey) return null;
  return {
    accountId: account.id,
    provider: account.provider,
    baseUrl: account.baseUrl,
    apiKey: account.apiKey,
    model: model.model,
    name: model.name,
    modalities: model.modalities,
  };
}

export async function resolveAccountCredentials(ownerId: string, accountId: string) {
  const settings = await readStored(ownerId);
  const account = settings?.accounts.find((item) => item.id === accountId);
  if (!account?.apiKey) return null;
  return {
    provider: account.provider,
    baseUrl: account.baseUrl,
    apiKey: account.apiKey,
  };
}

/**
 * 向量模型解析顺序:当前账号设置页绑定 → 环境变量回退。
 *
 * 设置页是主入口:同一个服务商账户既可用于聊天,也可单独绑定向量模型。
 * 环境变量留给纯部署场景,不再要求普通用户改文件。
 */
export async function resolveEmbeddingTarget(ownerId: string): Promise<ResolvedEmbeddingTarget | null> {
  const settings = await readStored(ownerId);
  const binding = settings?.embedding;
  if (settings && binding?.accountId && binding.model.trim()) {
    const account = settings.accounts.find((item) => item.id === binding.accountId);
    if (account?.apiKey) {
      return {
        accountId: account.id,
        provider: account.provider,
        baseUrl: account.baseUrl,
        apiKey: account.apiKey,
        model: binding.model.trim(),
      };
    }
  }

  if (serverConfig.embedding.enabled && serverConfig.embedding.apiKey && serverConfig.embedding.baseUrl && serverConfig.embedding.model) {
    return {
      accountId: "env-embedding",
      provider: /anthropic/i.test(serverConfig.embedding.baseUrl) ? "anthropic" : "custom",
      baseUrl: serverConfig.embedding.baseUrl,
      apiKey: serverConfig.embedding.apiKey,
      model: serverConfig.embedding.model,
    };
  }
  return null;
}

export async function resolveServiceModel(
  ownerId: string,
  service: ModelServiceId,
): Promise<ResolvedModelTarget | null> {
  const settings = await readStored(ownerId);
  const id = settings?.services[service];
  if (id) {
    const resolved = await resolveModelById(ownerId, id);
    if (resolved) return resolved;
  }
  return envTarget();
}

export async function configuredModelSummary(ownerId: string) {
  const [relation, ask, translate] = await Promise.all([
    resolveServiceModel(ownerId, "relation"),
    resolveServiceModel(ownerId, "ask"),
    resolveServiceModel(ownerId, "translate"),
  ]);
  return {
    relation,
    ask,
    translate,
    vision: Boolean(ask?.modalities.includes("vision")),
  };
}

/** 面向界面的能力清单。界面据此区分 AI 结果与启发式降级。 */
export async function capabilityReport(ownerId: string) {
  const summary = await configuredModelSummary(ownerId);
  const embedding = await resolveEmbeddingTarget(ownerId);
  return {
    llm: Boolean(summary.relation || summary.ask),
    embedding: Boolean(embedding),
    llmModel: summary.relation?.model ?? summary.ask?.model ?? null,
    askModel: summary.ask?.model ?? null,
    vision: summary.vision,
    embeddingModel: embedding?.model ?? null,
  };
}
