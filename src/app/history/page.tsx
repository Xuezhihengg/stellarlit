"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { SecondaryPage } from "@/components/shell/SecondaryPage";
import { GhostButton } from "@/components/ui/GhostButton";
import { deleteStarfield, listStarfields } from "@/lib/api/client";
import type { StarfieldSummary } from "@/types/starfield";

/**
 * 历史星空。
 *
 * 它存在的理由是产品形态本身:一片星空会随着不断并入种子而长期存在,
 * 那就必须能找回来。列表按更新时间倒序 —— 用户最近关心的排在最前。
 */
export default function HistoryPage() {
  const [items, setItems] = useState<StarfieldSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await listStarfields();
      setItems(res.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onDelete = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        await deleteStarfield(id);
        setItems((prev) => (prev ? prev.filter((x) => x.id !== id) : prev));
      } catch (e) {
        setError(e instanceof Error ? e.message : "删除失败");
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  return (
    <SecondaryPage
      title="历史星空"
      subtitle="每一片星空都是一次调研的存档:保留了你当时输入的所有种子、论文坐标与关系判定结果。打开它会回到你上次离开时的样子。"
      actions={
        <GhostButton size="sm" onClick={() => void refresh()}>
          刷新
        </GhostButton>
      }
    >
      {error ? (
        <p className="mb-5 rounded-lg border border-alert/30 px-3 py-2 text-[12px] text-alert">
          {error}
        </p>
      ) : null}

      {items === null ? (
        <p className="text-[12.5px] text-ink-4">正在读取…</p>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-hair px-6 py-10 text-center">
          <p className="text-[13px] text-ink-2">还没有任何星空</p>
          <p className="mt-2 text-[12px] text-ink-4">
            回到星图,在右侧输入一篇种子论文试试。
          </p>
          <Link
            href="/"
            className="mt-5 inline-block text-[12px] text-accent/85 transition-colors hover:text-accent"
          >
            去建第一片星空 →
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((s) => (
            <li
              key={s.id}
              className="group flex items-center justify-between gap-6 rounded-xl border border-hair px-5 py-4 transition-colors duration-[--dur-fast] hover:border-hair-2"
            >
              <div className="min-w-0">
                <Link
                  href={`/?starfield=${encodeURIComponent(s.id)}`}
                  className="block truncate text-[13.5px] text-ink transition-colors hover:text-accent"
                >
                  {s.name}
                </Link>
                <p className="mt-1.5 truncate font-mono text-[10.5px] text-ink-4">
                  {s.seedTitles.join(" · ") || "（无种子记录）"}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-5">
                <div className="hidden items-center gap-4 font-mono text-[10.5px] text-ink-4 sm:flex">
                  <span>{s.stats.papers} 篇</span>
                  <span>{s.stats.edges} 边</span>
                  <span>{s.stats.communities} 前沿</span>
                </div>
                <time className="hidden font-mono text-[10.5px] text-ink-4 md:block">
                  {formatTime(s.updatedAt)}
                </time>
                <button
                  type="button"
                  disabled={busyId === s.id}
                  onClick={() => void onDelete(s.id)}
                  className="text-[10.5px] text-ink-4 opacity-0 transition-opacity group-hover:opacity-100 hover:text-alert disabled:opacity-40"
                >
                  {busyId === s.id ? "删除中…" : "删除"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SecondaryPage>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
