interface MetricProps {
  label: string;
  value: string | number;
  /** 强调色只用于需要用户注意的那一个指标 */
  accent?: boolean;
}

/** 指标。数字用等宽字体,位数变化时不会左右抖动。 */
export function Metric({ label, value, accent = false }: MetricProps) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`font-mono text-[12px] ${accent ? "text-accent" : "text-ink-2"}`}>
        {value}
      </span>
      <span className="text-[10px] tracking-[0.1em] text-ink-4">{label}</span>
    </div>
  );
}
