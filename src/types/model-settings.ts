/** 模型设置 —— 设置页与服务端共用的公开契约。API Key 只允许单向写入。 */

/**
 * 服务商清单的唯一来源:新增一家就把 id 加在这里。
 * 服务端 zod 校验、设置页卡片、品牌图标文件名(public/icons/providers/<id>.svg)
 * 全部由它派生 —— 漏掉任何一处都会在 `pnpm check` 里暴露,而不是等用户点了才发现。
 */
export const MODEL_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "deepseek",
  "qwen",
  "kimi",
  "minimax",
  "hunyuan",
  "mimo",
  "nvidia",
  "amux",
  "custom",
] as const;

export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];

export type ModelModality = "text" | "vision";
export type ModelServiceId = "relation" | "ask" | "translate";

export interface ProviderAccountDto {
  id: string;
  provider: ModelProviderId;
  name: string;
  baseUrl: string;
  /** 服务端是否已有密钥;GET 永远不返回密钥原文 */
  hasApiKey: boolean;
  /** 仅用于让用户确认是哪一把 key */
  apiKeyHint?: string;
  /** 只允许从设置页写入;清空表示保留服务端已有的 key */
  apiKey?: string;
}

export interface ModelProfileDto {
  id: string;
  accountId: string;
  name: string;
  model: string;
  modalities: ModelModality[];
}

export interface ModelServiceBindings {
  relation: string | null;
  ask: string | null;
  translate: string | null;
}

/** 向量检索绑定:直接指向一个服务商账户 + 模型 ID,不占聊天模型清单。 */
export interface EmbeddingBinding {
  accountId: string | null;
  model: string;
}

export interface ModelSettingsDto {
  version: 1;
  accounts: ProviderAccountDto[];
  models: ModelProfileDto[];
  services: ModelServiceBindings;
  embedding: EmbeddingBinding;
}

export interface SaveModelSettingsRequest {
  accounts: ProviderAccountDto[];
  models: ModelProfileDto[];
  services: ModelServiceBindings;
  embedding: EmbeddingBinding;
}
