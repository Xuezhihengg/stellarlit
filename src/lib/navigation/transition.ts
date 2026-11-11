export interface PageNavigationOptions {
  replace?: boolean;
  refresh?: boolean;
}

export interface PageNavigationDetail extends PageNavigationOptions {
  href: string;
}

export const PAGE_NAVIGATION_EVENT = "stellarlit:navigate";

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
