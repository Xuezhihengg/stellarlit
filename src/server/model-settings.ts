import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { serverConfig } from "./config";
import type {
  ModelModality,
  ModelProviderId,
  ModelServiceId,
  ModelSettingsDto,
  ProviderAccountDto,
  SaveModelSettingsRequest,
} from "@/types/model-settings";

interface StoredAccount {
  id: string;
  provider: ModelProviderId;
  name: string;
  baseUrl: string;
  apiKey: string;
}

interface StoredSettings {
  version: 1;
  accounts: StoredAccount[];
  models: Array<{
    id: string;
    accountId: string;
    name: string;
    model: string;
    modalities: ModelModality[];
  }>;
  services: Record<ModelServiceId, string | null>;
}

export interface ResolvedModelTarget {
  accountId: string;
  provider: ModelProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  name: string;
  modalities: ModelModality[];
}

const SETTINGS_PATH = path.join(serverConfig.dataDir, "model-settings.json");
let cachedSettings: StoredSettings | null | undefined;

const providerSchema = z.enum(["openai", "anthropic", "deepseek", "qwen", "custom"]);
const modalitySchema = z.enum(["text", "vision"]);

const storedSchema = z.object({
  version: z.literal(1),
  accounts: z.array(
    z.object({
      id: z.string(),
      provider: providerSchema,
      name: z.string(),
      baseUrl: z.string(),
      apiKey: z.string(),
    }),
  ),
  models: z.array(
    z.object({
      id: z.string(),
      accountId: z.string(),
      name: z.string(),
      model: z.string(),
      modalities: z.array(modalitySchema),
    }),
  ),
  services: z.object({
    relation: z.string().nullable(),
    ask: z.string().nullable(),
    translate: z.string().nullable(),
  }),
});

async function readStored(): Promise<StoredSettings | null> {
  if (cachedSettings !== undefined) return cachedSettings;
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const parsed = storedSchema.safeParse(JSON.parse(raw));
    cachedSettings = parsed.success ? parsed.data : null;
    return cachedSettings;
  } catch {
    cachedSettings = null;
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
  };
}

export async function getModelSettings(): Promise<ModelSettingsDto> {
  return toPublic(await readStored());
}

export async function saveModelSettings(
  input: SaveModelSettingsRequest,
): Promise<ModelSettingsDto> {
  const previous = await readStored();
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
  };

  await mkdir(serverConfig.dataDir, { recursive: true });
  const temp = `${SETTINGS_PATH}.tmp`;
  await writeFile(temp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await rename(temp, SETTINGS_PATH);
  await chmod(SETTINGS_PATH, 0o600);
  cachedSettings = settings;
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

export async function resolveModelById(id: string): Promise<ResolvedModelTarget | null> {
  const settings = await readStored();
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

export async function resolveAccountCredentials(accountId: string) {
  const settings = await readStored();
  const account = settings?.accounts.find((item) => item.id === accountId);
  if (!account?.apiKey) return null;
  return {
    provider: account.provider,
    baseUrl: account.baseUrl,
    apiKey: account.apiKey,
  };
}

export async function resolveServiceModel(
  service: ModelServiceId,
): Promise<ResolvedModelTarget | null> {
  const settings = await readStored();
  const id = settings?.services[service];
  if (id) {
    const resolved = await resolveModelById(id);
    if (resolved) return resolved;
  }
  return envTarget();
}

export async function configuredModelSummary() {
  const [relation, ask, translate] = await Promise.all([
    resolveServiceModel("relation"),
    resolveServiceModel("ask"),
    resolveServiceModel("translate"),
  ]);
  return {
    relation,
    ask,
    translate,
    vision: Boolean(ask?.modalities.includes("vision")),
  };
}

/** 面向界面的能力清单。界面据此区分 AI 结果与启发式降级。 */
export async function capabilityReport() {
  const summary = await configuredModelSummary();
  return {
    llm: Boolean(summary.relation || summary.ask),
    embedding: serverConfig.embedding.enabled,
    llmModel: summary.relation?.model ?? summary.ask?.model ?? null,
    askModel: summary.ask?.model ?? null,
    vision: summary.vision,
  };
}
