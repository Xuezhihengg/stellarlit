"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { AccountMenu } from "@/components/shell/AccountMenu";
import { BrandMark } from "@/components/shell/BrandMark";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { HeroSky } from "@/components/home/HeroSky";
import type { Theme } from "@/hooks/use-theme";
import { useSession } from "@/hooks/use-session";
import { navigateWithFade } from "@/lib/navigation/transition";

interface HomeViewProps {
  theme: Theme;
  onToggleTheme: () => void;
  initialSeed: string;
  /** 登录流程带回来的种子:只续建一次,消费后由 Workspace 清空 */
  autoStartSeed: string;
  onStart: (seed: string) => void;
}

const SEED_EXAMPLES = [
  { label: "Attention", seed: "Attention Is All You Need" },
  { label: "1706.03762", seed: "1706.03762" },
  { label: "RAG", seed: "Retrieval-Augmented Generation" },
  { label: "ViT", seed: "2010.11929" },
  { label: "CLIP", seed: "2103.00020" },
  { label: "LoRA", seed: "2106.09685" },
  { label: "Diffusion", seed: "2006.11239" },
  { label: "BERT", seed: "1810.04805" },
  { label: "ResNet", seed: "1512.03385" },
  { label: "Mamba", seed: "2312.00752" },
  { label: "DPO", seed: "2305.18290" },
  { label: "SAM", seed: "2304.02643" },
  { label: "AlphaFold", seed: "10.1038/s41586-021-03819-2" },
  { label: "GPT-3", seed: "2005.14165" },
  { label: "InstructGPT", seed: "2203.02155" },
  { label: "Whisper", seed: "2212.04356" },
  { label: "NeRF", seed: "2003.08934" },
  { label: "CoT", seed: "2201.11903" },
  { label: "GraphRAG", seed: "2404.16130" },
  { label: "FlashAttn", seed: "2205.14135" },
  { label: "GAN", seed: "1406.2661" },
  { label: "GPT-4", seed: "2303.08774" },
  { label: "LLaMA", seed: "2302.13971" },
  { label: "Flamingo", seed: "2204.14198" },
  { label: "DALL·E 2", seed: "2204.06125" },
  { label: "Qwen", seed: "2309.16609" },
  { label: "DeepSeek-V3", seed: "2412.19437" },
  { label: "Mistral", seed: "2310.06825" },
  { label: "BLIP-2", seed: "2301.12597" },
  { label: "LDM", seed: "2112.10752" },
  { label: "word2vec", seed: "1301.3781" },
  { label: "Adam", seed: "1412.6980" },
] as const;

const SEED_PAGE_SIZE = 3;

/**
 * 首页。
 *
 * 它不是导航页,而是「输入种子」这件事本身:整屏只留一个动作,
 * 星尘、轨道和品牌都退到背景里。历史与设置是登录后的次级入口,
 * 放在输入框下方,像星图边缘的坐标,而不是应用菜单。
 */
export function HomeView({
  theme,
  onToggleTheme,
  initialSeed,
  autoStartSeed,
  onStart,
}: HomeViewProps) {
  const { user, ready } = useSession();
  const [value, setValue] = useState(initialSeed);
  const [focused, setFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoStartedRef = useRef(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * 登录前输入过种子的用户,登录回来后直接续上那次意图。
   * 只做一次:路由参数在真正开始构建后会被清掉,返回首页不会再自动提交。
   */
  useEffect(() => {
    if (!ready || !user || !autoStartSeed || autoStartedRef.current) return;
    const seed = autoStartSeed.trim();
    if (!seed) return;
    autoStartedRef.current = true;
    setSubmitting(true);
    onStart(seed);
  }, [autoStartSeed, onStart, ready, user]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const seed = value.trim();
    if (!seed || !ready || submitting) return;
    setSubmitting(true);

    if (!user) {
      const next = `/?seed=${encodeURIComponent(seed)}&auto=1`;
      navigateWithFade(`/login?next=${encodeURIComponent(next)}`);
      return;
    }

    onStart(seed);
  };

  return (
    <div className="relative flex min-h-dvh flex-col overflow-y-auto bg-bg text-ink">
      <HeroSky theme={theme} />

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[3]"
        style={{
          background:
            "radial-gradient(46% 36% at 50% 43%, color-mix(in oklab, var(--accent) 8%, transparent), transparent 72%), radial-gradient(28% 24% at 70% 24%, color-mix(in oklab, var(--warm) 4%, transparent), transparent 76%)",
        }}
      />

      <header className="relative isolate z-20 flex items-center justify-between gap-4 px-6 py-5 sm:px-9">
        <span aria-hidden="true" className="home-topbar-glass" />
        <div className="relative z-10">
          <BrandMark />
        </div>
        <div className="relative z-10 flex items-center gap-2">
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          {!ready ? (
            <span className="h-8 w-8" aria-hidden="true" />
          ) : user ? (
            <AccountMenu />
          ) : (
            <Link
              href="/login"
              className="rounded-full border border-hair-2 px-3.5 py-1.5 text-[11px] text-ink-3 transition-[color,border-color,background-color] duration-[var(--dur-fast)] hover:border-accent/40 hover:bg-accent/6 hover:text-accent"
            >
              登录
            </Link>
          )}
        </div>
      </header>

      <section className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pt-4 pb-20">
        <div className="relative flex w-full flex-col items-center">
          <p
            className="home-rise font-mono text-[9px] tracking-[0.32em] text-ink-4 uppercase"
            style={{ animationDelay: "40ms" }}
          >
            A research constellation
          </p>
          <h1
            className="home-rise mt-6 max-w-[820px] text-center text-[clamp(26px,6.4vw,58px)] leading-[1.16] font-medium tracking-[-0.025em] text-balance text-ink"
            style={{ animationDelay: "110ms" }}
          >
            把一篇论文，长成一片星空
          </h1>

          <form
            onSubmit={submit}
            className="home-rise mt-10 w-full max-w-[640px]"
            style={{ animationDelay: "250ms" }}
          >
            <div
              className={`relative rounded-2xl border bg-bg/62 backdrop-blur-2xl transition-[border-color,box-shadow,background-color] duration-[var(--dur-base)] ${
                focused
                  ? "border-accent/55 shadow-[0_0_0_4px_color-mix(in_srgb,var(--accent)_8%,transparent),0_28px_90px_-40px_color-mix(in_srgb,var(--accent)_45%,transparent)]"
                  : "border-hair-2 shadow-[0_22px_70px_-46px_rgba(0,0,0,0.9)] hover:border-hair-2/90"
              }`}
              style={{ transitionTimingFunction: "var(--ease-out)" }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-ink-3"
              >
                <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.1" />
                <path d="M10.2 10.2 L14 14" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
              </svg>
              <input
                ref={inputRef}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                aria-label="种子论文"
                spellCheck={false}
                placeholder="输入论文标题 / arXiv ID / DOI"
                className="h-[62px] w-full bg-transparent pr-[68px] pl-12 text-[13.5px] text-ink placeholder:text-ink-4/80"
              />
              <button
                type="submit"
                disabled={!value.trim() || !ready || submitting}
                aria-label={submitting ? "正在进入星空" : "开始构建"}
                className="group absolute top-1/2 right-2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-xl bg-accent text-bg transition-[background-color,opacity,transform] duration-[var(--dur-fast)] hover:bg-accent/90 active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-45"
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 14 14"
                  fill="none"
                  aria-hidden="true"
                  className="transition-transform duration-[var(--dur-fast)] group-hover:translate-x-0.5"
                >
                  <path
                    d="M2.5 7h8.2M7.4 3.7 10.7 7l-3.3 3.3"
                    stroke="currentColor"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>

            <div className="mt-3 flex items-center justify-between gap-4 px-1 font-mono text-[9px] tracking-[0.05em] text-ink-4/80">
              <span>支持标题、arXiv ID、DOI、OpenAlex ID</span>
              <span className="hidden shrink-0 sm:inline">⌘K</span>
            </div>

            <SeedSuggestions
              onPick={(seed) => {
                setValue(seed);
                inputRef.current?.focus();
              }}
            />
          </form>

          <div
            className="home-rise mt-10 w-full max-w-[660px]"
            style={{ animationDelay: "330ms" }}
          >
            {!ready ? (
              <div className="h-[92px]" aria-hidden="true" />
            ) : user ? (
              <div className="grid gap-2.5 sm:grid-cols-3">
                <HomeLink
                  href="/history"
                  title="历史星空"
                  hint="回到保存过的星图"
                  icon={<HistoryIcon />}
                />
                <HomeLink
                  href="/account"
                  title="账户与用量"
                  hint="今日 token 与偏好"
                  icon={<AccountIcon />}
                />
                <HomeLink
                  href="/settings"
                  title="设置"
                  hint="模型、关系与检索"
                  icon={<SettingsIcon />}
                />
              </div>
            ) : (
              <div className="flex items-center justify-center gap-2.5 text-[10.5px] text-ink-4">
                <span>登录后保存星空,继续问答历史</span>
                <Link
                  href="/login"
                  className="text-accent/85 transition-colors duration-[var(--dur-fast)] hover:text-accent"
                >
                  登录 / 注册
                </Link>
              </div>
            )}
          </div>
        </div>
      </section>

      <footer className="relative z-10 hidden items-center justify-center gap-3 pb-6 font-mono text-[8.5px] tracking-[0.14em] text-ink-4/60 uppercase sm:flex">
        <span>Citation field</span>
        <Dot />
        <span>Hybrid retrieval</span>
        <Dot />
        <span>Multimodal evidence</span>
        <Dot />
        <span>MCP tools</span>
      </footer>
    </div>
  );
}

function SeedSuggestions({ onPick }: { onPick: (seed: string) => void }) {
  const [page, setPage] = useState(0);
  const [visible, setVisible] = useState(true);
  const [paused, setPaused] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (reduceMotion || paused) return;

    let swapTimer: number | undefined;
    const interval = window.setInterval(() => {
      setVisible(false);
      swapTimer = window.setTimeout(() => {
        setPage((current) => current + 1);
        setVisible(true);
      }, 280);
    }, 5800);

    return () => {
      window.clearInterval(interval);
      if (swapTimer) window.clearTimeout(swapTimer);
    };
  }, [paused, reduceMotion]);

  const examples = Array.from({ length: SEED_PAGE_SIZE }, (_, index) => {
    return SEED_EXAMPLES[(page * SEED_PAGE_SIZE + index) % SEED_EXAMPLES.length]!;
  });

  return (
    <div
      className="mt-5"
      onPointerEnter={() => {
        setPaused(true);
        setVisible(true);
      }}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <div
        role="group"
        aria-label="种子论文候选"
        data-visible={visible}
        className="home-seed-cloud grid grid-cols-3 gap-2"
      >
        {examples.map((example, index) => (
          <button
            key={`${page}-${index}-${example.label}`}
            type="button"
            onClick={() => onPick(example.seed)}
            className="home-seed-chip w-full min-w-0 truncate rounded-full border border-hair px-2 py-1.5 text-[9.5px] text-ink-3 transition-[color,border-color,background-color] duration-[var(--dur-fast)] hover:border-accent/35 hover:bg-accent/6 hover:text-ink-2 sm:px-3 sm:text-[10px]"
          >
            {example.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function HomeLink({
  href,
  title,
  hint,
  icon,
}: {
  href: string;
  title: string;
  hint: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group relative overflow-hidden rounded-xl border border-hair bg-surface/28 px-4 py-3.5 backdrop-blur-md transition-[border-color,background-color,transform] duration-[var(--dur-base)] hover:-translate-y-0.5 hover:border-accent/25 hover:bg-surface/45"
      style={{ transitionTimingFunction: "var(--ease-out)" }}
    >
      <span className="flex items-center gap-2 text-[11.5px] text-ink-2 transition-colors duration-[var(--dur-fast)] group-hover:text-ink">
        <span className="text-ink-4 transition-colors duration-[var(--dur-fast)] group-hover:text-accent">
          {icon}
        </span>
        {title}
      </span>
      <span className="mt-1.5 block text-[9.5px] text-ink-4">{hint}</span>
      <span
        aria-hidden="true"
        className="absolute top-1/2 right-3.5 -translate-y-1/2 text-[11px] text-ink-4 opacity-0 transition-[opacity,transform] duration-[var(--dur-fast)] group-hover:translate-x-0.5 group-hover:opacity-100"
      >
        →
      </span>
    </Link>
  );
}

function Dot() {
  return <span aria-hidden="true" className="h-0.5 w-0.5 rounded-full bg-ink-4/50" />;
}

function HistoryIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M7 4.2V7l1.9 1.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="4.6" r="2.2" stroke="currentColor" strokeWidth="1.1" />
      <path d="M2.8 12c.4-2.1 2-3.3 4.2-3.3s3.8 1.2 4.2 3.3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M2 4h10M2 7h10M2 10h10" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="5" cy="4" r="1.35" fill="var(--bg)" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="9" cy="7" r="1.35" fill="var(--bg)" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="5.8" cy="10" r="1.35" fill="var(--bg)" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}
