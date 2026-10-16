"use client";

import { BrandMark } from "@/components/shell/BrandMark";
import { ThemeToggle } from "@/components/shell/ThemeToggle";
import { TopBar } from "@/components/shell/TopBar";
import { StarfieldCanvas } from "@/components/star-map/StarfieldCanvas";
import { useTheme } from "@/hooks/use-theme";

/**
 * 主界面。
 *
 * 这个页面的职责只有一件:**把星空铺满整屏**,其余一切以浮层形式叠上去。
 * 图谱层、助手栏、时间轴都还没有接上,它们在后续提交里各自作为独立组件加入,
 * 而不是往这个文件里堆。
 */
export default function StarfieldPage() {
  const { theme, toggleTheme } = useTheme();

  return (
    <main className="relative h-dvh w-screen overflow-hidden">
      <StarfieldCanvas theme={theme} />

      <TopBar
        brand={<BrandMark />}
        title="还没有星空"
        meta="等待输入种子论文"
        right={<ThemeToggle theme={theme} onToggle={toggleTheme} />}
      />

      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center pb-8">
        <p className="text-[11px] tracking-[0.14em] text-ink-4">
          输入一篇种子论文 · 星空会沿着它的研究脉络长出来
        </p>
      </div>
    </main>
  );
}
