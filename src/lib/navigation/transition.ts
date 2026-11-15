export interface PageNavigationOptions {
  replace?: boolean;
  refresh?: boolean;
}

export interface PageNavigationDetail extends PageNavigationOptions {
  href: string;
}

export const PAGE_NAVIGATION_EVENT = "stellarlit:navigate";

/** 回首页的意图。首页与画布同处 `/`,由 Workspace 的状态机换幕。 */
export const HOME_EVENT = "stellarlit:home";

/**
 * 请求一次带页面过渡的跳转。
 *
 * 过渡层挂在根布局里,所以这里只负责发事件;返回 false 表示当前没有过渡层
 * (例如脚本在挂载前运行),调用方可以退回浏览器原生跳转。
 */
export function navigateWithFade(href: string, options: PageNavigationOptions = {}): boolean {
  if (typeof window === "undefined") return false;

  const event = new CustomEvent<PageNavigationDetail>(PAGE_NAVIGATION_EVENT, {
    detail: { href, ...options },
    cancelable: true,
  });
  const handled = !window.dispatchEvent(event);

  if (!handled) {
    if (options.replace) window.location.replace(href);
    else window.location.assign(href);
  }

  return handled;
}

/**
 * 请求回到首页。

 * 首页与画布是同一个路由的两幕(`/` 与 `/?starfield=…`):真正负责换幕的是
 * Workspace 里的状态机。这里只发一个意图事件 —— 直接 push 到 `/` 会复用同一个
 * Workspace 实例,画布不会退出,表现为"点了没反应"。
 *
 * 没有工作区接管时(登录页、设置页、历史页),退回普通的幕布跳转。
 */
export function requestHome(options: PageNavigationOptions = {}): boolean {
  if (typeof window === "undefined") return false;
  const event = new CustomEvent<PageNavigationDetail>(HOME_EVENT, {
    detail: { href: "/", ...options },
    cancelable: true,
  });
  if (!window.dispatchEvent(event)) return true;
  return navigateWithFade("/", options);
}
