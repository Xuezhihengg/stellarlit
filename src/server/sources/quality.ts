/**
 * 数据质量闸门 —— 因为真实数据源里真的混着垃圾。
 *
 * 实测:OpenAlex 里存在「2026 年发表、被引 4.5 万次、零参考文献」的记录。
 * 这类自动生成或错误合并的条目会直接污染证据链,让整张星图失去可信度。
 *
 * 所以每一篇进入星图的论文都要过闸,并且**被拦下的原因要统计出来**,
 * 而不是悄悄丢掉 —— 可审计是学术工具的基本素养。
 */

import type { OaWork } from "./openalex";

/**
 * 只排除明确「不是研究论文」的类型,而不是列白名单。
 *
 * 教训:这里最初写的是白名单,结果一次就误杀了 116 篇 conference-paper ——
 * 而实测该邻域的类型分布是 conference-paper 109 / article 48 / preprint 40,
 * 会议论文恰恰是主力。**一个静默删掉 54% 数据的过滤器,比不过滤更危险。**
 */
const EXCLUDED_TYPES = new Set([
  "paratext", // 封面、目录之类的版面文字
  "peer-review", // 同行评审意见本身
  "erratum", // 勘误
  "retraction", // 撤稿
  "libguides", // 图书馆指南
  "supplementary-materials",
  "reference-entry", // 工具书条目
  "dataset", // 数据集不是论文
]);

export interface QualityReport {
  keep: boolean;
  reason?: string;
}

export function assessQuality(w: OaWork, nowYear: number): QualityReport {
  if (!w.id) return { keep: false, reason: "缺少 ID" };
  if (!w.title || w.title.trim().length < 8) return { keep: false, reason: "标题缺失或过短" };
  if (w.year > nowYear + 1) return { keep: false, reason: "年份来自未来" };
  if (w.type && EXCLUDED_TYPES.has(w.type)) return { keep: false, reason: `非研究论文(${w.type})` };
  // 高被引却没有任何参考文献:真实研究不可能这样,判定为异常记录
  if (w.citedByCount >= 500 && w.referencedWorksCount === 0) {
    return { keep: false, reason: "高被引但零参考文献" };
  }
  return { keep: true };
}

export interface QualitySummary {
  kept: number;
  droppedTotal: number;
  droppedByReason: Record<string, number>;
}

export function emptyQualitySummary(): QualitySummary {
  return { kept: 0, droppedTotal: 0, droppedByReason: {} };
}

export function recordQuality(summary: QualitySummary, report: QualityReport): QualitySummary {
  if (report.keep) {
    summary.kept += 1;
    return summary;
  }
  summary.droppedTotal += 1;
  const reason = report.reason ?? "未知";
  summary.droppedByReason[reason] = (summary.droppedByReason[reason] ?? 0) + 1;
  return summary;
}
