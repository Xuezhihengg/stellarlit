/** 界面上重复出现的数字格式。 */

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, Math.round(value)));
}

/** token 用紧凑写法:1234 → 1.2k,1_200_000 → 1.2M。 */
export function formatTokens(value: number): string {
  const n = Math.max(0, Math.round(value));
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" });
}

const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
};

const SUBSCRIPT: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
};

const GREEK: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  omicron: "ο",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
};

const SYMBOLS: Record<string, string> = {
  times: "×",
  cdot: "·",
  pm: "±",
  mp: "∓",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  neq: "≠",
  approx: "≈",
  infty: "∞",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  leftrightarrow: "↔",
  partial: "∂",
  nabla: "∇",
  sum: "∑",
  prod: "∏",
  left: "",
  right: "",
};

function scriptOf(content: string, table: Record<string, string>, marker: "^" | "_"): string {
  const mapped = Array.from(content, (char) => table[char] ?? "").join("");
  return mapped.length === Array.from(content).length ? mapped : `${marker}(${content})`;
}

function formatInlineLatex(input: string): string {
  let text = input.trim();
  if (!text.includes("$") && !text.includes("\\") && !text.includes("^") && !text.includes("_")) {
    return text;
  }

  text = text.replace(/\$([^$]+)\$/g, "$1");
  text = text.replace(/\\\((.*?)\\\)/g, "$1").replace(/\\\[(.*?)\\\]/g, "$1");
  text = text.replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)");
  text = text.replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)");
  text = text.replace(
    /\\(?:text|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|operatorname\*?|textrm|textbf|emph|underline|overline|boxed|widehat|widetilde)\s*\{([^{}]*)\}/g,
    "$1",
  );

  text = text.replace(/\^\{([^{}]+)\}/g, (_, content: string) => scriptOf(content, SUPERSCRIPT, "^"));
  text = text.replace(/\^([A-Za-z0-9+\-=])/g, (_, content: string) =>
    scriptOf(content, SUPERSCRIPT, "^"),
  );
  text = text.replace(/_\{([^{}]+)\}/g, (_, content: string) => scriptOf(content, SUBSCRIPT, "_"));
  text = text.replace(/_([A-Za-z0-9+\-=])/g, (_, content: string) =>
    scriptOf(content, SUBSCRIPT, "_"),
  );

  text = text.replace(/\\([A-Za-z]+)/g, (_, name: string) => GREEK[name] ?? SYMBOLS[name] ?? name);
  text = text.replace(/\\([%&_#$#{}])/g, "$1");
  text = text.replace(/\\[,;:! ]/g, " ");
  text = text.replace(/[{}]/g, "").replace(/\$/g, "");
  return text.replace(/\s+/g, " ").trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[lower] ?? match;
  });
}

/**
 * 论文元数据里的富文本 → 可读纯文本。
 *
 * Semantic Scholar 的摘要可能夹带 `<inline-formula>`、`<tex-math>` 与
 * MathML 备选节点。先提取 LaTeX 公式,丢掉重复的 MathML 备选,再统一
 * 做轻量公式排版,避免标签和两套公式同时出现在界面或检索上下文里。
 */
function normalizeScholarlyText(raw: string): string {
  let text = decodeEntities(raw.trim());
  if (!text) return "";

  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<\?[\s\S]*?\?>/g, " ");
  text = text.replace(/<inline-formula\b[^>]*>([\s\S]*?)<\/inline-formula>/gi, (_, body: string) => {
    const tex = /<tex-math\b[^>]*>([\s\S]*?)<\/tex-math>/i.exec(body);
    return tex?.[1] ?? body;
  });
  text = text.replace(/<alternatives\b[^>]*>[\s\S]*?<\/alternatives>/gi, " ");
  text = text.replace(/<tex-math\b[^>]*>([\s\S]*?)<\/tex-math>/gi, "$1");
  text = text.replace(/<(sup|sub)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag: string, body: string) =>
    tag.toLowerCase() === "sup" ? `^{${body}}` : `_{${body}}`,
  );
  text = text.replace(/<inline-graphic\b[^>]*\/?>/gi, " ");
  text = text.replace(/<\/?(?:p|div|li|h[1-6]|br)\b[^>]*>/gi, " ");
  text = text.replace(/<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s[^<>]*?)?\/?>/g, " ");
  return formatInlineLatex(text);
}

/** 论文标题:富文本标签 + 轻量 LaTeX → 可读文本。 */
export function formatPaperTitle(raw: string): string {
  return normalizeScholarlyText(raw);
}

/** 摘要、关系证据等较长论文文本:与标题共用同一套清洗规则。 */
export function formatPaperText(raw: string): string {
  return normalizeScholarlyText(raw);
}
