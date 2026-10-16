"use client";

import { useEffect, useState } from "react";

interface BuildStatusProps {
  /** 正在做什么,例如「正在展开引文邻域」 */
  label: string;
  /** 步骤序号(从 1 开始),用于让等待有进度感 */
  step?: number;
  total?: number;
}

/**
 * 构建状态。
 *
 * 一次构建要跑几秒到几十秒。这段时间里最糟的处理是一个转圈 ——
 * 用户不知道系统在做什么,就会怀疑它卡住了。
 * 所以这里既说明**当前在做什么**,也用秒表让对方知道它确实在动。
 */
export function BuildStatus({ label, step = 1, total = 4 }: BuildStatusProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 0.1), 100);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex flex-col gap-3 py-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[12px] text-ink-2">{label}</span>
        <span className="font-mono text-[10px] text-ink-4">{elapsed.toFixed(1)}s</span>
      </div>

      {/* 进度条只是一条极细的线,与整份视觉保持一致 */}
      <div className="flex gap-1">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className={`h-px flex-1 transition-colors duration-[--dur-slow] ${
              i < step ? "bg-accent/70" : "bg-hair-2"
            }`}
          />
        ))}
      </div>

      <p className="text-[10.5px] leading-relaxed text-ink-4">
        正在抓取引文邻域、聚类研究前沿、计算布局。结果会缓存,同一片星空再次打开是瞬时的。
      </p>
    </div>
  );
}
