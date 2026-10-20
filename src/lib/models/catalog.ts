import type {
  ModelModality,
  ModelProviderId,
  ModelServiceId,
} from "@/types/model-settings";

export interface ProviderPreset {
  id: ModelProviderId;
  label: string;
  note: string;
  baseUrl: string;
  models: Array<{
    model: string;
    name: string;
    modalities: ModelModality[];
  }>;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI / GPT",
    note: "OpenAI 当前模型目录",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { model: "gpt-4.1", name: "GPT-4.1", modalities: ["text", "vision"] },
      { model: "gpt-4o", name: "GPT-4o", modalities: ["text", "vision"] },
      { model: "gpt-4o-mini", name: "GPT-4o mini", modalities: ["text", "vision"] },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic / Claude",
    note: "Anthropic 当前模型目录",
    baseUrl: "https://api.anthropic.com/v1",
    models: [
      {
        model: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        modalities: ["text", "vision"],
      },
      {
        model: "claude-3-5-haiku-latest",
        name: "Claude 3.5 Haiku",
        modalities: ["text", "vision"],
      },
      {
        model: "claude-3-7-sonnet-latest",
        name: "Claude 3.7 Sonnet",
        modalities: ["text", "vision"],
      },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    note: "DeepSeek 当前模型目录",
    baseUrl: "https://api.deepseek.com/v1",
    models: [
      { model: "deepseek-flash", name: "DeepSeek Flash", modalities: ["text", "vision"] },
      { model: "deepseek-v4-pro", name: "DeepSeek V4 Pro", modalities: ["text"] },
    ],
  },
  {
    id: "qwen",
    label: "通义千问 / Qwen",
    note: "阿里云百炼当前模型目录",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [
      { model: "qwen3.8-max", name: "Qwen3.8 Max", modalities: ["text", "vision"] },
      { model: "qwen3.8-flash", name: "Qwen3.8 Flash", modalities: ["text", "vision"] },
      {
        model: "qwen3.8-omni-flash",
        name: "Qwen3.8 Omni Flash",
        modalities: ["text", "vision"],
      },
    ],
  },
  {
    id: "custom",
    label: "其他兼容接口",
    note: "手动填写 OpenAI 兼容地址与模型 ID",
    baseUrl: "",
    models: [],
  },
];

export const MODEL_SERVICES: Array<{
  id: ModelServiceId;
  label: string;
  note: string;
  requiresVision?: boolean;
}> = [
  {
    id: "relation",
    label: "关系判定",
    note: "判断论文之间的语义关系,建议使用稳定的文本模型。",
  },
  {
    id: "ask",
    label: "多模态文献问答",
    note: "必须选择支持图像理解的模型,才能分析论文图表与截图。",
    requiresVision: true,
  },
  {
    id: "translate",
    label: "摘要翻译",
    note: "把摘要译成另一种语言,不需要图像能力。",
  },
];

export function providerPreset(id: ModelProviderId): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS.at(-1)!;
}

/** 模态从已核对的模型目录和命名规则推导,不要求用户手动勾选。 */
export function inferModelModalities(
  provider: ModelProviderId,
  modelId: string,
): ModelModality[] {
  const preset = providerPreset(provider).models.find((model) => model.model === modelId);
  if (preset) return [...preset.modalities];

  const name = modelId.toLowerCase();
  const multimodal =
    /(vl|vision|omni|multimodal|image|gpt-4o|gpt-4\.1|gpt-5|gpt-6|^o[34])/.test(name) ||
    (provider === "anthropic" && name.startsWith("claude-")) ||
    (provider === "deepseek" && /flash/.test(name));
  return multimodal ? ["text", "vision"] : ["text"];
}
