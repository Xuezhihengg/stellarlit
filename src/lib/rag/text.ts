/**
 * RAG 的文本层 —— 切块与检索分词。
 *
 * 为什么不按固定字数硬切:摘要里的论证单位是句子。按句切、只在句尾断,
 * 检索命中一段时读到的是完整的一句话;固定字数会在词中间截断,
 * 引用给用户看时像半句话。
 *
 * 纯函数、零依赖:切块结果与检索质量都能在 Node 里验证。
 */

export interface TextChunk {
  /** 文内序号,从 0 开始 */
  index: number;
  text: string;
  /** 在原文中的字符起止位置(用于引用定位) */
  start: number;
  end: number;
}

export interface ChunkOptions {
  /** 目标长度(字符)。中英混排在 400 字左右约等于 250~300 token */
  target?: number;
  /** 相邻块重叠的字符数:避免"答案正好落在两块交界处" */
  overlap?: number;
  /** 最后一块短于此长度时并入上一块 */
  minTail?: number;
}

/** 按句子切开,保留句末标点。 */
function splitSentences(text: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  const re = /[^。！？!?；;\n]+[。！？!?；;]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const piece = m[0];
    if (!piece.trim()) continue;
    out.push({ text: piece, start: m.index });
  }
  return out;
}

/**
 * 把一段长文本切成句子边界对齐的块。
 *
 * 重叠用"上一块的最后一两句"实现,而不是按字符往回退 ——
 * 后者会把一个句子劈成两半,重叠部分反而更难读。
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const { target = 420, overlap = 90, minTail = 120 } = options;
  const clean = text.trim();
  if (!clean) return [];

  const sentences = splitSentences(clean);
  if (!sentences.length) {
    return [{ index: 0, text: clean, start: 0, end: clean.length }];
  }

  const chunks: TextChunk[] = [];
  let current: Array<{ text: string; start: number }> = [];

  const flush = () => {
    if (!current.length) return;
    const start = current[0]!.start;
    const last = current[current.length - 1]!;
    const end = last.start + last.text.length;
    chunks.push({
      index: chunks.length,
      text: clean.slice(start, end).trim(),
      start,
      end,
    });
  };

  for (const sentence of sentences) {
    current.push(sentence);
    const length = current.reduce((n, s) => n + s.text.length, 0);
    if (length < target) continue;

    flush();

    // 重叠:保留最后 1~2 句(不超过 overlap 太多)
    const carry: Array<{ text: string; start: number }> = [];
    let carried = 0;
    for (let i = current.length - 1; i >= 0 && carried < overlap; i--) {
      const s = current[i]!;
      carry.unshift(s);
      carried += s.text.length;
    }
    current = carry;
  }

  if (current.length) {
    const tailLength = current.reduce((n, s) => n + s.text.length, 0);
    const last = chunks[chunks.length - 1];
    if (last && tailLength < minTail) {
      // 尾巴太短:并入上一块,避免出现"只有半句"的检索单元
      last.text = clean.slice(last.start, current[current.length - 1]!.start + current[current.length - 1]!.text.length).trim();
      last.end = current[current.length - 1]!.start + current[current.length - 1]!.text.length;
    } else {
      flush();
    }
  }

  return chunks;
}

/**
 * 检索分词。
 *
 * 英文按词、中文按二字组(bigram):没有分词词典时,bigram 是中文检索
 * 最稳的折中 —— 单字噪声太大,整句又匹配不上。
 */
export function tokenizeForSearch(text: string): string[] {
  const normalized = text.toLowerCase();
  const tokens: string[] = [];

  for (const m of normalized.matchAll(/[a-z0-9][a-z0-9.+#_-]*/g)) {
    const token = m[0];
    if (token.length >= 2) tokens.push(token);
  }

  for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      tokens.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }

  return tokens;
}
