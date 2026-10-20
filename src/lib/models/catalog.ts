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
    note: "支持文本与图像理解",
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
    note: "Messages API,支持图像输入",
    baseUrl: "https://api.anthropic.com/v1",
    models: [
      {
        model: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        modalities: ["text", "vision"],
      },
      {
        model: "claude-3-7-sonnet-latest",
        name: "Claude 3.7 Sonnet",
        modalities: ["text", "vision"],
      },
      {
        model: "claude-3-5-haiku-latest",
        name: "Claude 3.5 Haiku",
        modalities: ["text", "vision"],
      },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    note: "OpenAI 兼容接口",
    baseUrl: "https://api.deepseek.com/v1",
    models: [
      { model: "deepseek-chat", name: "DeepSeek Chat", modalities: ["text"] },
      { model: "deepseek-reasoner", name: "DeepSeek Reasoner", modalities: ["text"] },
    ],
  },
  {
    id: "qwen",
    label: "通义千问 / Qwen",
    note: "阿里云 DashScope OpenAI 兼容接口",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [
      { model: "qwen-vl-max", name: "Qwen VL Max", modalities: ["text", "vision"] },
      { model: "qwen-vl-plus", name: "Qwen VL Plus", modalities: ["text", "vision"] },
      { model: "qwen-max", name: "Qwen Max", modalities: ["text"] },
      { model: "qwen-plus", name: "Qwen Plus", modalities: ["text"] },
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
