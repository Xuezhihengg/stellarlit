/**
 * 关系预设的请求校验。
 *
 * 用户可以在设置页改写预设,所以它是一份**来自客户端的输入**,
 * 必须当作不可信数据处理:长度上限、必需字段、id 格式全都要校验。
 * 把 promptVersion 也纳入校验,是因为证据链要靠它回溯「这条判定是哪个版本判的」。
 */

import { z } from "zod";

export const RelationPresetSchema = z.object({
  id: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9-]*$/, "预设 id 只能是小写字母、数字与连字符"),
  label: z.string().min(1).max(24),
  labelEn: z.string().min(1).max(48),
  description: z.string().min(1).max(400),
  definition: z.string().min(1).max(2000),
  negativeExamples: z.string().min(1).max(2000),
  directed: z.boolean(),
  hardConstraints: z
    .object({
      requireCitation: z.boolean().optional(),
      requireMutualNonCitation: z.boolean().optional(),
      maxYearGap: z.number().int().min(0).max(60).optional(),
      requireSharedTask: z.boolean().optional(),
      requireSharedMethod: z.boolean().optional(),
      minSimilarity: z.number().min(0).max(1).optional(),
    })
    .default({}),
  visual: z.object({
    tone: z.string().max(40),
    dash: z.string().max(24).optional(),
  }),
  promptVersion: z.string().min(1).max(64),
  enabled: z.boolean(),
  maxPerSeed: z.number().int().min(0).max(40),
  builtin: z.boolean(),
});
