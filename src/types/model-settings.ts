/** 模型设置 —— 设置页与服务端共用的公开契约。API Key 只允许单向写入。 */

export type ModelProviderId =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "qwen"
  | "custom";

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

export interface ModelSettingsDto {
  version: 1;
  accounts: ProviderAccountDto[];
  models: ModelProfileDto[];
  services: ModelServiceBindings;
}

export interface SaveModelSettingsRequest {
  accounts: ProviderAccountDto[];
  models: ModelProfileDto[];
  services: ModelServiceBindings;
}
