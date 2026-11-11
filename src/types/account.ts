/** 账号页与顶栏共用的数据类型。 */

export interface AccountUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface AccountStatsDto {
  starfields: number;
  papers: number;
  history: number;
  presets: number;
  modelAccounts: number;
}

export interface UsageDayDto {
  day: string;
  tokens: number;
  calls: number;
}

export interface UsageSnapshotDto extends UsageDayDto {
  budget: number;
  remaining: number;
  percent: number;
}

export interface AccountOverviewDto {
  user: AccountUser;
  stats: AccountStatsDto;
  usage: UsageSnapshotDto;
  history: UsageDayDto[];
  sessions: number;
}
