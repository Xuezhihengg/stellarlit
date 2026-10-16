/**
 * 星空的持久化。
 *
 * 刻意用文件而不是数据库:图谱产物是**可重建的派生数据**,
 * 真正需要长期保存的只有「哪片星空由哪些种子构成」这一点点信息。
 * 为它引入一个数据库,只会让答辩时要解释的东西变多。
 *
 * 部署到只读文件系统时,写入会失败 —— 那时它退化成「单次会话内可用的内存存储」,
 * 功能不受影响,只是历史记录不再跨重启保留。
 */

import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { StarfieldPayload } from "@/types/api";
import type { StarfieldSummary } from "@/types/starfield";

import { serverConfig } from "../config";

const DIR = path.join(serverConfig.dataDir, "starfields");

/** 进程内缓存:演示时同一个星空会被反复读取,没必要反复读盘解析。 */
const memo = new Map<string, StarfieldPayload>();

function fileOf(id: string): string {
  // id 由服务端生成,这里再挡一层,防止路径穿越
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "");
  return path.join(DIR, `${safe}.json`);
}

export async function saveStarfield(payload: StarfieldPayload): Promise<boolean> {
  const id = payload.starfield.id;
  memo.set(id, payload);
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(fileOf(id), JSON.stringify(payload), "utf8");
    return true;
  } catch {
    // 只读文件系统:内存里仍然可用
    return false;
  }
}

export async function loadStarfield(id: string): Promise<StarfieldPayload | null> {
  const hit = memo.get(id);
  if (hit) return hit;
  try {
    const payload = JSON.parse(await readFile(fileOf(id), "utf8")) as StarfieldPayload;
    memo.set(id, payload);
    return payload;
  } catch {
    return null;
  }
}

export async function listStarfields(): Promise<StarfieldSummary[]> {
  const fromDisk: StarfieldPayload[] = [];
  try {
    const files = await readdir(DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      const payload = await loadStarfield(id);
      if (payload) fromDisk.push(payload);
    }
  } catch {
    // 目录不存在:退回内存里已有的
    fromDisk.push(...memo.values());
  }

  const byId = new Map<string, StarfieldPayload>();
  for (const p of [...memo.values(), ...fromDisk]) byId.set(p.starfield.id, p);

  return [...byId.values()]
    .map((p) => {
      const paperById = new Map(
        p.graph.nodes.filter((n) => n.kind === "paper").map((n) => [n.id, n]),
      );
      return {
        id: p.starfield.id,
        name: p.starfield.name,
        seedTitles: p.starfield.seeds
          .map((s) => {
            const node = paperById.get(s.paperId);
            return node && node.kind === "paper" ? node.title : s.query;
          })
          .slice(0, 4),
        updatedAt: p.starfield.updatedAt,
        stats: p.starfield.stats,
      } satisfies StarfieldSummary;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteStarfield(id: string): Promise<void> {
  memo.delete(id);
  try {
    await unlink(fileOf(id));
  } catch {
    /* 文件不存在也无所谓,内存里已经删掉了 */
  }
}
