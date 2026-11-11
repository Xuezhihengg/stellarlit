"use client";

import { useCallback, useEffect, useState } from "react";

import { fetchMe, logoutAccount, type AuthUser } from "@/lib/api/client";
import { navigateWithFade } from "@/lib/navigation/transition";

/**
 * 当前账号。
 *
 * 模块级缓存 Promise:顶栏、设置页、历史页同时挂载时只发一次 /api/auth/me,
 * 而不是各自请求一遍。刷新页面会重新取,保证登出后状态不会残留。
 */
let inflight: Promise<AuthUser | null> | null = null;

function load(): Promise<AuthUser | null> {
  inflight ??= fetchMe().catch(() => null);
  return inflight;
}

/** 登录 / 注册成功后清掉游客态缓存,下一次 useSession 会重新取当前账号。 */
export function invalidateSession(): void {
  inflight = null;
}

export function useSession() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void load().then((next) => {
      if (cancelled) return;
      setUser(next);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(async () => {
    await logoutAccount().catch(() => undefined);
    inflight = null;
    navigateWithFade("/login", { replace: true });
  }, []);

  return { user, ready, signOut };
}
