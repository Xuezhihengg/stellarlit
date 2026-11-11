/**
 * 账号页需要的聚合数据。
 *
 * 这些都是小查询:账号页不是高频页面,不做物化视图;
 * 但把计数放在一条 SQL 里,避免前端为一屏数字发五六个请求。
 */

import { queryOne } from ".";

export interface AccountStats {
  starfields: number;
  papers: number;
  history: number;
  presets: number;
  modelAccounts: number;
}

export async function accountStats(ownerId: string): Promise<AccountStats> {
  const [starfields, history, presets, models] = await Promise.all([
    queryOne<{ n: string; papers: string }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(paper_count), 0) AS papers
       FROM starfields WHERE owner_id = $1`,
      [ownerId],
    ),
    queryOne<{ n: string }>("SELECT COUNT(*) AS n FROM ask_history WHERE owner_id = $1", [ownerId]),
    queryOne<{ n: string }>("SELECT COUNT(*) AS n FROM relation_presets WHERE owner_id = $1", [ownerId]),
    queryOne<{ n: string }>("SELECT COUNT(*) AS n FROM model_accounts WHERE owner_id = $1", [ownerId]),
  ]);
  return {
    starfields: Number(starfields?.n ?? 0),
    papers: Number(starfields?.papers ?? 0),
    history: Number(history?.n ?? 0),
    presets: Number(presets?.n ?? 0),
    modelAccounts: Number(models?.n ?? 0),
  };
}
