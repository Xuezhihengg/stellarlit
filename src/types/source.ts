/** 文献数据源设置:只返回邮箱与密钥提示,永远不返回完整 Key。 */
export interface SourceSettingsDto {
  openalexMailto: string;
  hasSemanticScholarKey: boolean;
  semanticScholarKeyHint?: string;
}
