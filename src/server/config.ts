/**
 * 服务端配置 —— 所有环境变量的唯一读取点。
 *
 * 为什么集中在一处:密钥绝不能散落在各个模块里被 `process.env.X` 随手取用 ——
 * 那样既无法确认"到底哪里在用密钥",也无法在缺少密钥时统一降级。
 *
 * 降级策略:没有密钥不是错误,而是「能力不可用」。
 * 结构层(引用、作者、发表)来自免费数据源,不需要任何密钥;
 * 只有语义层(关系判定、检索问答)需要大模型。缺密钥时该能力降级为
 * 启发式判定,并在界面上如实标注 —— 而不是假装有结果。
 */

import path from "node:path";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export interface LlmConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  /** 是否具备调用条件。false 时语义层降级,不报错。 */
  enabled: boolean;
}

export interface EmbeddingConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  enabled: boolean;
}

export interface ServerConfig {
  llm: LlmConfig;
  embedding: EmbeddingConfig;
  /** OpenAlex 的礼貌池邮箱。带上它请求优先级更高,也便于对方联系。 */
  openalexMailto: string;
  semanticScholarKey?: string;
  dataDir: string;
  /** 联系方式的展示名,写进 User-Agent。 */
  userAgent: string;
}

const LLM_BASE_URL = env("LLM_BASE_URL") ?? "https://api.deepseek.com/v1";
const LLM_MODEL = env("LLM_MODEL") ?? "deepseek-chat";
const LLM_API_KEY = env("LLM_API_KEY");

const EMBEDDING_API_KEY = env("EMBEDDING_API_KEY");
const EMBEDDING_BASE_URL = env("EMBEDDING_BASE_URL");
const EMBEDDING_MODEL = env("EMBEDDING_MODEL");

const MAILTO = env("OPENALEX_MAILTO") ?? "stellarlit@example.com";

export const serverConfig: ServerConfig = {
  llm: {
    apiKey: LLM_API_KEY,
    baseUrl: LLM_BASE_URL.replace(/\/+$/, ""),
    model: LLM_MODEL,
    enabled: Boolean(LLM_API_KEY),
  },
  embedding: {
    apiKey: EMBEDDING_API_KEY ?? LLM_API_KEY,
    baseUrl: EMBEDDING_BASE_URL ?? LLM_BASE_URL,
    model: EMBEDDING_MODEL,
    enabled: Boolean((EMBEDDING_API_KEY ?? LLM_API_KEY) && EMBEDDING_MODEL),
  },
  openalexMailto: MAILTO,
  semanticScholarKey: env("SEMANTIC_SCHOLAR_API_KEY"),
  dataDir: env("STELLARLIT_DATA_DIR") ?? path.join(process.cwd(), "data"),
  userAgent: `StellarLit/0.1 (academic star map; mailto:${MAILTO})`,
};

/** 面向界面的能力清单。前端据此决定显示"AI 判定"还是"启发式判定"。 */
export function capabilityReport() {
  return {
    llm: serverConfig.llm.enabled,
    embedding: serverConfig.embedding.enabled,
    llmModel: serverConfig.llm.enabled ? serverConfig.llm.model : null,
  };
}
