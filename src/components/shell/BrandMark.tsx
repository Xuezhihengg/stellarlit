/**
 * 品牌标记。
 *
 * 那颗四角星是整份视觉里唯一"装饰性"的元素 —— 留一个记号,其余全部让给数据。
 */
export function BrandMark() {
  return (
    <div className="flex items-center gap-3">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <path
          d="M7 0.5 L8.1 5.9 L13.5 7 L8.1 8.1 L7 13.5 L5.9 8.1 L0.5 7 L5.9 5.9 Z"
          fill="currentColor"
          opacity="0.95"
        />
      </svg>
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-semibold tracking-[0.24em] text-ink uppercase">
          StellarLit
        </span>
        <span className="text-[11px] tracking-[0.08em] text-ink-4">学术星图</span>
      </div>
    </div>
  );
}
