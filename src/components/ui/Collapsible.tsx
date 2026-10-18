"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

interface CollapsibleProps {
  open: boolean;
  children: ReactNode;
  /** 收起时保留的高度(px)。摘要预览用 64,纯折叠用默认 0 */
  collapsedHeight?: number;
  className?: string;
}

/**
 * 高度可动画的折叠容器。
 *
 * 为什么不能直接 `max-height: 0 → 9999px`:内容只有 200px 时,过渡前 2%
 * 就已经"展开完了",剩下 98% 的时间在等一个看不见的数值 —— 观感是瞬间弹开。
 * 所以这里量出**真实内容高度**,从固定值过渡到真实值,速度才和内容量匹配。
 *
 * 测量挂在内容元素上、而不是被裁剪的外层:外层是 overflow-hidden,
 * 它的高度是被切过的;内容元素本身仍然是完整高度,`scrollHeight` 才是真值。
 *
 * 纯展示组件:只认 props,不认业务。
 */
export function Collapsible({
  open,
  children,
  collapsedHeight = 0,
  className = "",
}: CollapsibleProps) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [contentHeight, setContentHeight] = useState(0);

  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;

    const measure = () => setContentHeight(el.scrollHeight);
    measure();

    // 内容换了一篇论文、外层宽度变了、字体加载完 —— 高度都可能变
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children]);

  return (
    <div
      className={`overflow-hidden transition-[max-height,opacity] duration-[var(--dur-base)] ${className}`}
      style={{
        maxHeight: open ? contentHeight : collapsedHeight,
        // 完全收起时顺带淡出;保留预览高度时不淡(预览本来就要看得见)
        opacity: open || collapsedHeight > 0 ? 1 : 0,
        transitionTimingFunction: "var(--ease-out)",
      }}
      aria-hidden={!open && collapsedHeight === 0}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
}
