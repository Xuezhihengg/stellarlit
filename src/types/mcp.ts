export interface McpTokenSummary {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface McpTokenCreateResult {
  token: string;
  summary: McpTokenSummary;
}
