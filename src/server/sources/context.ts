/** 一次文献请求使用的账号身份。公共元数据不变,但礼貌池与上游额度按人走。 */
export interface SourceContext {
  /** OpenAlex `mailto` 参数:当前登录账号的注册邮箱。 */
  mailto: string;
  /** Semantic Scholar API Key;未填写时匿名访问。 */
  semanticScholarKey?: string;
}
