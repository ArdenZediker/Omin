/**
 * 代码大纲（/code_outline）：正则 + 缩进启发式，零新增依赖。
 *
 * 为什么不做成 LSP：四个参考项目里只有 atomcode 做了符号级工具（8 个，
 * 代价是要维护 LSP/索引）；codex 与 deepseek-harness 都没有 —— codex 靠
 * 「提示词引导用 rg 探索 + AGENTS.md 外化结构」，dsh 连这层引导都没有。
 * 本工具走中间路线：**不建索引**，只在「读全文之前先看结构」这一件事上
 * 省下大量上下文，代价是启发式可能漏（工具描述里必须写明）。
 *
 * 纯函数模块：不依赖 Tauri 与注册表，可脱离 mock 单测。
 */

export type OutlineSymbol = {
  /** 1 基行号（与 /read_file 显示的编号同一坐标系） */
  line: number;
  /** 嵌套层级，0 为顶层 */
  depth: number;
  /** class / interface / fn / method / const / enum / struct / trait / impl / mod / type */
  kind: string;
  name: string;
  /** 声明行去掉前导空白后的内容（截断），用于看签名 */
  signature: string;
};

export const DEFAULT_MAX_DEPTH = 4;
export const DEFAULT_MAX_SYMBOLS = 150;
const MAX_SIGNATURE_CHARS = 80;

/** 控制流/调用语句：形如 `name(` 但不是声明，必须排除，否则误报成方法。 */
const NOT_A_METHOD =
  /^(?:if|else|for|while|switch|case|catch|try|do|return|throw|yield|await|new|delete|typeof|instanceof|and|or|not|in|of|when|match|print|echo|require|import|from|export)\b/;

type DeclPattern = {
  /** "@container" / "@function" 表示取匹配到的关键字本身作为 kind */
  kind: string;
  re: RegExp;
  /** 名称所在的捕获组下标 */
  nameGroup: number;
  /** 缩进所在的捕获组下标；缺省表示用整行的前导空白 */
  indentGroup?: number;
};

const DECL_PATTERNS: DeclPattern[] = [
  {
    kind: "@container",
    re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:(?:pub|crate|public|private|protected|internal|static|final|open|sealed|data|readonly|unsafe|extern|mut)\s+)*(class|interface|enum|struct|trait|impl|union|namespace|module|record)\s+([A-Za-z_$][\w$]*)/,
    nameGroup: 2,
  },
  {
    kind: "@function",
    re: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:(?:pub|public|private|protected|internal|static|final|async|open|override|virtual|inline|unsafe|extern)\s+)*(function|fn|func|def|sub)\s+([A-Za-z_$][\w$]*)/,
    nameGroup: 2,
  },
  // TS/JS 箭头函数常量：`const render = (…)` / `const run = async (…)`
  {
    kind: "const",
    re: /^[ \t]*(?:export\s+)?(?:const|let|var|final|val)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/,
    nameGroup: 1,
  },
  // Go 方法带接收者：`func (r *Repo) Load(…)` —— 常规 fn 规则匹配不到
  {
    kind: "method",
    re: /^func\s+\([^)]*\)\s+([A-Za-z_]\w*)\s*\(/,
    nameGroup: 1,
  },
  // 缩进的方法：`  async load(id: string)` / `    def handle(self)` / `    fn run(&self)`
  {
    kind: "method",
    re: /^([ \t]+)(?:(?:public|private|protected|internal|static|final|async|open|override|virtual|mut|pub|get|set)\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\(/,
    nameGroup: 2,
    indentGroup: 1,
  },
];

function indentWidthOf(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4;
    else break;
  }
  return width;
}

function isCommentLine(trimmed: string): boolean {
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith('"""') ||
    trimmed.startsWith("'''") ||
    trimmed.startsWith("--") ||
    trimmed.startsWith(";")
  );
}

/**
 * 推断缩进单位：取全文最小正缩进（夹到 2–8）。
 * 用相对单位而不是写死 2 或 4，才能同时适配 TS（2 空格）与 Python/Java（4 空格）。
 */
function inferIndentUnit(lines: string[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (!line.trim()) continue;
    const width = indentWidthOf(line);
    if (width > 0 && width < min) min = width;
  }
  if (!Number.isFinite(min)) return 4;
  return Math.min(8, Math.max(2, min));
}

export type BuildOutlineOptions = {
  /** 内容对应的起始行号（/read_file 分页时 >1），默认 1 */
  startLine?: number;
  maxDepth?: number;
  maxSymbols?: number;
};

export type BuildOutlineResult = {
  symbols: OutlineSymbol[];
  /** 因 depth 超限被折叠的数量 */
  folded: number;
  /** 因超 maxSymbols 被截断的数量 */
  dropped: number;
  totalLines: number;
};

export function buildOutline(
  content: string,
  options: BuildOutlineOptions = {},
): BuildOutlineResult {
  const startLine = options.startLine ?? 1;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxSymbols = options.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const lines = content.split(/\r?\n/);
  const unit = inferIndentUnit(lines);

  const symbols: OutlineSymbol[] = [];
  let folded = 0;
  let stoppedAt = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || isCommentLine(trimmed)) continue;

    for (const pattern of DECL_PATTERNS) {
      const match = pattern.re.exec(raw);
      if (!match) continue;

      const name = match[pattern.nameGroup];
      if (!name) continue;
      if (pattern.kind === "method" && NOT_A_METHOD.test(name)) break;

      const indentSource =
        pattern.indentGroup !== undefined ? match[pattern.indentGroup] ?? "" : raw;
      const rawDepth = Math.round(indentWidthOf(indentSource) / unit);
      if (rawDepth > maxDepth) {
        folded += 1;
        break;
      }

      // 容器保留关键字本身（class/interface/enum/struct/trait/impl/…），函数类统一叫 fn
      let kind = pattern.kind;
      if (kind === "@container") kind = match[1];
      else if (kind === "@function") kind = "fn";

      const signature =
        trimmed.length > MAX_SIGNATURE_CHARS
          ? `${trimmed.slice(0, MAX_SIGNATURE_CHARS - 1)}…`
          : trimmed;

      symbols.push({ line: startLine + i, depth: rawDepth, kind, name, signature });
      break;
    }

    if (symbols.length >= maxSymbols) {
      stoppedAt = i + 1;
      break;
    }
  }

  const dropped = stoppedAt >= 0 ? countRemaining(lines, stoppedAt) : 0;

  return { symbols, folded, dropped, totalLines: lines.length };
}

/** 命中上限后不再逐行扫描，用一个保守的估计值说明「还有多少个没列」。 */
function countRemaining(lines: string[], fromLine: number): number {
  let rest = 0;
  for (let i = fromLine; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed || isCommentLine(trimmed)) continue;
    for (const pattern of DECL_PATTERNS) {
      if (pattern.re.test(lines[i])) {
        rest += 1;
        break;
      }
    }
  }
  return rest;
}

export function renderOutline(
  path: string,
  result: BuildOutlineResult,
): string {
  const { symbols, folded, dropped, totalLines } = result;
  if (symbols.length === 0) {
    return [
      `文件：${path}（共 ${totalLines} 行）`,
      "未识别出任何声明。大纲基于正则与缩进推断，对非常规写法或生僻语言可能为空 —— 请改用 /read_file 直接阅读。",
    ].join("\n");
  }

  const body = symbols.map((item) => {
    const pad = "  ".repeat(item.depth);
    const line = String(item.line).padStart(5, " ");
    return `${line}  ${pad}${item.kind} ${item.name}`;
  });

  const notes: string[] = [];
  if (folded > 0) notes.push(`${folded} 个更深层级的声明已折叠`);
  if (dropped > 0) notes.push(`另有约 ${dropped} 个声明未列出（超出上限）`);

  return [
    `文件：${path}（共 ${totalLines} 行 · 列出 ${symbols.length} 个声明）`,
    ...body,
    ...(notes.length ? ["", `注：${notes.join("；")}。`] : []),
  ].join("\n");
}
