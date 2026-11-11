"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { BrandMark } from "@/components/shell/BrandMark";
import { invalidateSession } from "@/hooks/use-session";
import { loginAccount, registerAccount } from "@/lib/api/client";
import { navigateWithFade } from "@/lib/navigation/transition";

type Mode = "login" | "register";

interface LoginFormProps {
  next: string;
}

/**
 * 登录 / 注册。
 *
 * 两件事刻意做得克制:
 *   - 不区分「邮箱不存在」与「密码错误」,避免账号枚举;
 *   - 注册成功若接管了旧数据,明确说出接管了多少片星空,而不是悄悄发生。
 */
export function LoginForm({ next }: LoginFormProps) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      if (mode === "register") {
        const { claimed } = await registerAccount({
          email,
          password,
          name: name.trim() || undefined,
        });
        if (claimed.starfields > 0) {
          setNotice(`已接管本机已有的 ${claimed.starfields} 片星空`);
          await new Promise((resolve) => window.setTimeout(resolve, 900));
        }
      } else {
        await loginAccount(email, password);
      }
      invalidateSession();
      if (!navigateWithFade(next, { replace: true, refresh: true })) {
        router.replace(next);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败,请重试");
      setBusy(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-hair-2 bg-bg/40 px-3 py-2.5 text-[13px] text-ink outline-none transition-colors duration-[var(--dur-fast)] placeholder:text-ink-4/70 focus:border-accent/50";

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden px-6 py-10">
      {/* 一层极淡的星云:只是让空白有纵深,不抢表单的注意力 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          background:
            "radial-gradient(600px 420px at 78% 18%, color-mix(in oklab, var(--accent) 8%, transparent), transparent 70%), radial-gradient(720px 520px at 18% 88%, color-mix(in oklab, var(--warm) 6%, transparent), transparent 72%)",
        }}
      />

      <div className="relative w-full max-w-[372px]">
        <BrandMark />

        <h1 className="mt-9 text-[19px] leading-snug font-medium text-ink">
          {mode === "login" ? "回到你的星空" : "建一个属于你的星空"}
        </h1>
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-4">
          {mode === "login"
            ? "登录后继续上次的研究脉络与问答历史。"
            : "账号只存在这台机器上,密码以 scrypt 哈希保存,不会外传。"}
        </p>

        <div className="mt-6 flex gap-1 rounded-lg border border-hair p-1">
          {(["login", "register"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => {
                setMode(item);
                setError(null);
              }}
              className={`flex-1 rounded-md py-1.5 text-[11.5px] transition-colors duration-[var(--dur-fast)] ${
                mode === item ? "bg-hair/70 text-ink" : "text-ink-4 hover:text-ink-2"
              }`}
            >
              {item === "login" ? "登录" : "注册"}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="mt-4 flex flex-col gap-2.5">
          {mode === "register" ? (
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[9.5px] tracking-[0.12em] text-ink-4">昵称</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={40}
                placeholder="怎么称呼你(可留空)"
                className={inputClass}
                autoComplete="nickname"
              />
            </label>
          ) : null}

          <label className="flex flex-col gap-1">
            <span className="font-mono text-[9.5px] tracking-[0.12em] text-ink-4">邮箱</span>
            <input
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              className={inputClass}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-mono text-[9.5px] tracking-[0.12em] text-ink-4">密码</span>
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              required
              minLength={mode === "register" ? 8 : 1}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              placeholder={mode === "register" ? "至少 8 位" : "输入密码"}
              className={inputClass}
            />
          </label>

          {error ? <p className="mt-1 text-[11px] leading-relaxed text-alert">{error}</p> : null}
          {notice ? <p className="mt-1 text-[11px] leading-relaxed text-accent">{notice}</p> : null}

          <button
            type="submit"
            disabled={busy}
            className="mt-2 rounded-lg border border-accent/35 bg-accent/12 py-2.5 text-[12.5px] text-ink transition-colors duration-[var(--dur-fast)] hover:bg-accent/18 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "稍候…" : mode === "login" ? "登录" : "创建账号"}
          </button>
        </form>

        <p className="mt-6 font-mono text-[9px] leading-relaxed tracking-[0.06em] text-ink-4/80">
          数据保存在本地数据库 · 论文标题与 ID 会发往 OpenAlex / arXiv
        </p>
      </div>
    </main>
  );
}
