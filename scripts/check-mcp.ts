/**
 * MCP 工具集校验。
 *
 * 不看模型答得好不好,只看「协议通、工具全、读得对、边界稳」:
 * 用内存传输把 Client 和 Server 直接接起来,走真实的 initialize / tools/list /
 * tools/call 握手,并断言:
 *   - 9 个工具都在,且全部声明 readOnly(不会偷偷改图);
 *   - 读本地星空拿到的是真实数字(24 篇 / 164 边);
 *   - 检索能返回带 chunkId 的原文;
 *   - 关系查询双向都能查到,查不到时明确说 found=false,而不是编。
 *
 * 运行:`pnpm check:mcp`(已被 `pnpm check` 调用)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { MCP_TOOLS } from "../src/lib/mcp/catalog";
import { closePool, queryOne } from "../src/server/db";
import { ensureLegacyStarfieldsImported } from "../src/server/db/starfields";
import { createStarfieldMcpServer } from "../src/server/mcp/server";
import { closeRedis } from "../src/server/redis";

const SF = "sf-1483870316-mvaava4o";

const problems: string[] = [];
let checks = 0;

function expect(name: string, ok: boolean, detail = ""): void {
  checks++;
  if (ok) return;
  problems.push(`${name}${detail ? ` —— ${detail}` : ""}`);
}

interface ToolText {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function json<T>(result: ToolText, label: string): T | null {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) {
    problems.push(`${label}: 返回里没有文本内容`);
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    problems.push(`${label}: 返回不是 JSON —— ${text.slice(0, 120)}`);
    return null;
  }
}

async function main(): Promise<void> {
  await ensureLegacyStarfieldsImported();
  // 工具层不再有「第一个账号」兜底:自检也显式指定这片星空的 owner
  const owner = await queryOne<{ owner_id: string }>(
    "SELECT owner_id FROM starfields WHERE id = $1",
    [SF],
  );
  const server = createStarfieldMcpServer(owner?.owner_id ?? "legacy");
  const client = new Client({ name: "stellarlit-check", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // 1. 工具清单
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  const expected = [
    "expand_citations",
    "find_relation_evidence",
    "get_paper",
    "get_paper_context",
    "get_starfield",
    "list_starfields",
    "resolve_seed",
    "search_papers",
    "search_starfield",
  ];
  expect("工具数量为 9", names.length === 9, names.join(", "));
  expect("工具名齐全", expected.every((name) => names.includes(name)), names.join(", "));
  expect(
    "全部工具声明只读",
    tools.every((tool) => tool.annotations?.readOnlyHint === true),
    tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name).join(", "),
  );
  const catalogNames = MCP_TOOLS.map((tool) => tool.name).sort();
  expect(
    "设置页目录与服务端一致",
    catalogNames.join(",") === names.join(","),
    `目录 ${catalogNames.join(",")} / 服务端 ${names.join(",")}`,
  );
  expect(
    "工具都写了描述",
    tools.every((tool) => (tool.description ?? "").length > 30),
  );

  // 2. 列表:能看见本地存档
  const list = json<{ starfields: Array<{ id: string; papers: number; edges: number }> }>(
    (await client.callTool({ name: "list_starfields", arguments: {} })) as ToolText,
    "list_starfields",
  );
  expect("列表非空", Boolean(list && list.starfields.length > 0));
  expect("列表里有 YOLO 星空", Boolean(list?.starfields.some((item) => item.id === SF)));

  // 3. 读结构:数字要对得上存档
  const field = json<{
    stats: { papers: number; edges: number };
    papers: Array<{ id: string }>;
  }>(
    (await client.callTool({ name: "get_starfield", arguments: { starfieldId: SF } })) as ToolText,
    "get_starfield",
  );
  expect("论文数 24", field?.stats.papers === 24, String(field?.stats.papers));
  expect("边数 164", field?.stats.edges === 164, String(field?.stats.edges));
  expect("默认返回 40 条以内的论文", Boolean(field && field.papers.length === 24));

  // 4. 检索:返回 chunkId 才能让模型给出可核对引用
  const hits = json<{
    hits: Array<{ chunkId: string; title: string; quote: string; section: string }>;
  }>(
    (await client.callTool({
      name: "search_starfield",
      arguments: { starfieldId: SF, query: "YOLO 单阶段检测 回归" },
    })) as ToolText,
    "search_starfield",
  );
  expect("检索有结果", Boolean(hits && hits.hits.length > 0));
  expect("每条结果都有 chunkId", Boolean(hits?.hits.every((hit) => hit.chunkId.length > 0)));
  expect(
    "检索到 YOLO",
    Boolean(
      hits?.hits.some((hit) =>
        `${hit.title} ${hit.quote}`.toLowerCase().includes("yolo"),
      ),
    ),
  );
  expect("摘录非空", Boolean(hits?.hits.every((hit) => hit.quote.length > 10)));

  // 5. 关系:双向查、带证据;查不到时明确 false
  const forward = json<{
    found: boolean;
    relations: Array<{
      relationId: string;
      confidence: number;
      evidence: Array<{ kind: string; quote?: string }>;
    }>;
  }>(
    (await client.callTool({
      name: "find_relation_evidence",
      arguments: {
        starfieldId: SF,
        paperA: "paper:W2102605133",
        paperB: "paper:W1932624639",
      },
    })) as ToolText,
    "find_relation_evidence(forward)",
  );
  expect("关系能查到", forward?.found === true);
  expect(
    "同时返回多条语义关系",
    (forward?.relations.length ?? 0) >= 2,
    String(forward?.relations.length),
  );
  expect(
    "按置信度倒序",
    Boolean(
      forward &&
        forward.relations.every(
          (item, index) => index === 0 || (forward.relations[index - 1]?.confidence ?? 0) >= item.confidence,
        ),
    ),
  );
  expect(
    "包含 BASELINE_OF 与 ALTERNATIVE_TO",
    Boolean(
      forward?.relations.some((item) => item.relationId === "BASELINE_OF") &&
        forward.relations.some((item) => item.relationId === "ALTERNATIVE_TO"),
    ),
    forward?.relations.map((item) => item.relationId).join(", "),
  );
  expect(
    "每条关系都带原文证据",
    Boolean(
      forward?.relations.every((relation) =>
        relation.evidence.some((item) => item.kind === "span" && (item.quote ?? "").length > 0),
      ),
    ),
  );

  const backward = json<{ found: boolean }>(
    (await client.callTool({
      name: "find_relation_evidence",
      arguments: {
        starfieldId: SF,
        paperA: "paper:W1932624639",
        paperB: "paper:W2102605133",
      },
    })) as ToolText,
    "find_relation_evidence(backward)",
  );
  expect("反向也能查到", backward?.found === true);

  const missing = json<{ found: boolean; hint?: string }>(
    (await client.callTool({
      name: "find_relation_evidence",
      arguments: { starfieldId: SF, paperA: "paper:W999999999", paperB: "paper:W1483870316" },
    })) as ToolText,
    "find_relation_evidence(missing)",
  );
  expect("查不到时 found=false", missing?.found === false);
  expect("查不到时给出提示", Boolean(missing?.hint && missing.hint.length > 0));

  // 6. 上下文:一条边两头都能解释
  const context = json<{
    paper: { title: string };
    abstract?: string;
    semanticRelations: unknown[];
    structuralCounts: { cites: number; citedBy: number };
  }>(
    (await client.callTool({
      name: "get_paper_context",
      arguments: { starfieldId: SF, paperId: "paper:W2102605133" },
    })) as ToolText,
    "get_paper_context",
  );
  expect("有标题", Boolean(context?.paper.title.includes("Rich Feature Hierarchies")));
  expect("有摘要", Boolean(context?.abstract && context.abstract.length > 50));
  expect("有语义关系", Boolean(context && context.semanticRelations.length > 0));
  expect("有结构关系统计", Boolean(context && context.structuralCounts.cites >= 0));

  // 7. 错误边界:参数非法应报错而不是崩
  const invalid = (await client.callTool({
    name: "get_starfield",
    arguments: { starfieldId: "" },
  })) as ToolText;
  expect("非法参数返回错误", invalid.isError === true);

  await client.close();
  await server.close();

  if (problems.length > 0) {
    console.error("MCP 工具集校验失败:\n" + problems.map((item) => `  x ${item}`).join("\n"));
    await closeRedis();
    await closePool();
    process.exit(1);
  }

  console.log(`MCP 工具集一致(清单 / 读取 / 检索 / 关系 / 上下文 / 边界 共 ${checks} 项)`);
  await closeRedis();
  await closePool();
}

main().catch((error: unknown) => {
  console.error("MCP 工具集校验崩溃:", error);
  process.exit(1);
});
