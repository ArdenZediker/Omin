// 展示卡视图推导（对齐 harness presentationMeta 五类展示卡的思路）：
// 工具结果在 UI 侧不再统一降级成「首行文本预览」，而是按工具名 + ChatStep
// 已持久化的 result 文本 / fileDiff 推导出类型化视图，由 ExecutionTimeline 分发渲染。
// 关键取舍：只从 ChatStep 现有字段推导（不新增持久化字段），解析文本而非结构化 data
// ——与 searchResultText.ts 同理，历史会话的旧消息无需迁移即可获得展示卡。
//
// 支持的视图：
//   terminal — /bash：命令 + 退出码/超时 + 可滚动输出（含重置/截断注记）
//   diff     — 带返回 fileDiff 的写文件类工具：增删统计 + 可展开 unified-diff
//   read     — /read_file：路径 + 行区间 + 阅读进度 + 可展开内容
//   web      — /web_search（结果列表）/ /web_fetch（单页标题+地址）

export interface WebResultItem {
  title: string;
  url: string;
  snippet: string;
}

export type ToolPresentView =
  | {
      kind: "terminal";
      command: string;
      exitCode: number | null;
      timedOut: boolean;
      shellReset: boolean;
      clipped: boolean;
      output: string;
    }
  | {
      kind: "diff";
      filename: string;
      insertions: number;
      deletions: number;
      diffContent: string;
    }
  | {
      kind: "read";
      path: string;
      lineFrom: number | null;
      lineTo: number | null;
      returned: number;
      total: number;
      truncated: boolean;
      clipped: boolean;
      content: string;
    }
  | {
      kind: "web";
      mode: "search" | "fetch";
      source: string;
      items: WebResultItem[];
      clipped: boolean;
    };

/**
 * 拆掉末尾的 [clipped-note] 块（buildClippedNote 追加，可能跨多行）。
 * 返回剥离后的正文与是否截断标记。
 */
export function stripClippedNote(text: string): { text: string; clipped: boolean } {
  const idx = text.indexOf("[clipped-note]");
  if (idx < 0) return { text, clipped: false };
  return { text: text.slice(0, idx).trimEnd(), clipped: true };
}

/** 从工具参数 JSON 提取字符串字段（parseToolJsonArgs 前端的轻量对应物） */
function extractStringArg(args: string, ...keys: string[]): string {
  try {
    const obj = JSON.parse((args ?? "{}").trim() || "{}") as Record<string, unknown>;
    for (const key of keys) {
      const value = obj?.[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  } catch {
    // 参数非 JSON（旧数据 / 纯文本参数）——忽略，返回空串
  }
  return "";
}

/** /bash：解析状态前缀（重置 / 超时 / 退出码）与输出正文 */
function parseTerminalView(
  args: string,
  result: string,
): Extract<ToolPresentView, { kind: "terminal" }> {
  let text = result ?? "";
  const { text: afterNote, clipped } = stripClippedNote(text);
  text = afterNote;

  let shellReset = false;
  if (text.startsWith("（持久 shell 已自动重置")) {
    shellReset = true;
    const nl = text.indexOf("\n");
    text = nl >= 0 ? text.slice(nl + 1) : "";
  }

  let timedOut = false;
  if (text.startsWith("（命令超时，")) {
    timedOut = true;
    const nl = text.indexOf("\n");
    text = nl >= 0 ? text.slice(nl + 1) : "";
  }

  let exitCode: number | null = null;
  const exitMatch = /^（退出码 (\d+)）\n?/.exec(text);
  if (exitMatch) {
    exitCode = Number(exitMatch[1]);
    text = text.slice(exitMatch[0].length);
  }
  if (timedOut) exitCode = null;
  if (text === "（命令执行成功，无输出）") text = "";

  return {
    kind: "terminal",
    command: extractStringArg(args, "command"),
    exitCode,
    timedOut,
    shellReset,
    clipped,
    output: text,
  };
}

/** /read_file：解析「文件：path」头与 [file-meta …] 尾块 */
function parseReadView(result: string): Extract<ToolPresentView, { kind: "read" }> | null {
  const { text: body, clipped } = stripClippedNote(result ?? "");
  const lines = body.split(/\r?\n/);
  const pathMatch = /^文件：(.+)$/.exec(lines[0] ?? "");
  if (!pathMatch) return null;

  const metaLine = lines.find((line) => line.startsWith("[file-meta"));
  if (!metaLine) return null;
  const num = (key: string): number | null => {
    const m = new RegExp(`\\b${key}=(\\d+)`).exec(metaLine);
    return m ? Number(m[1]) : null;
  };
  const lineRange = /\blines=(\d+)-(\d+)\b/.exec(metaLine);

  const metaIndex = lines.indexOf(metaLine);
  const content = lines
    .slice(0, metaIndex > 0 ? metaIndex : lines.length)
    .join("\n")
    // 去掉「文件：path」头与其后的空行
    .replace(/^文件：.+\n+/, "")
    .trimEnd();

  return {
    kind: "read",
    path: pathMatch[1].trim(),
    lineFrom: lineRange ? Number(lineRange[1]) : null,
    lineTo: lineRange ? Number(lineRange[2]) : null,
    returned: num("returned") ?? 0,
    total: num("total") ?? 0,
    truncated: /\btruncated=true\b/.test(metaLine),
    clipped,
    content,
  };
}

/** /web_search：解析「N. 标题 + 缩进 url + 缩进 snippet」结果列表 */
function parseWebSearchView(args: string, result: string): Extract<ToolPresentView, { kind: "web" }> {
  const { text: body } = stripClippedNote(result ?? "");
  const lines = body.split(/\r?\n/);
  const head = /^「(.*)」搜索结果（\d+ 条）：$/.exec(lines[0] ?? "");
  const source = head?.[1] ?? extractStringArg(args, "query", "keyword", "q");

  const items: WebResultItem[] = [];
  let current: WebResultItem | null = null;
  for (const line of lines.slice(1)) {
    const entry = /^(\d+)\.\s(.+)$/.exec(line);
    if (entry) {
      current = { title: entry[2], url: "", snippet: "" };
      items.push(current);
      continue;
    }
    const indented = /^\s{2,}(\S.*)$/.exec(line);
    if (indented && current) {
      if (!current.url && /^https?:\/\//.test(indented[1])) {
        current.url = indented[1].trim();
      } else if (!current.snippet) {
        current.snippet = indented[1].trim();
      }
    }
  }
  return { kind: "web", mode: "search", source, items, clipped: false };
}

/** /web_fetch：解析「标题：」「地址：」头 */
function parseWebFetchView(result: string): Extract<ToolPresentView, { kind: "web" }> {
  const { text: body } = stripClippedNote(result ?? "");
  const title = /^标题：(.*)$/m.exec(body)?.[1]?.trim() ?? "";
  const url = /^地址：(.*)$/m.exec(body)?.[1]?.trim() ?? "";
  return {
    kind: "web",
    mode: "fetch",
    source: url,
    items: [{ title: title || url, url, snippet: "" }],
    clipped: false,
  };
}

/**
 * 从 ChatStep 字段推导展示视图；无匹配类型（或执行失败）返回 null，
 * 调用方回落到普通文本预览。
 */
export function inferPresentView(
  name: string,
  args: string,
  result: string,
  fileDiff?: { filename: string; insertions: number; deletions: number; diffContent: string } | null,
): ToolPresentView | null {
  if (name === "bash") return parseTerminalView(args, result);
  if (name === "read_file") return parseReadView(result);
  if (name === "web_search") return parseWebSearchView(args, result);
  if (name === "web_fetch") return parseWebFetchView(result);
  if (fileDiff?.diffContent?.trim()) {
    return {
      kind: "diff",
      filename: fileDiff.filename,
      insertions: fileDiff.insertions,
      deletions: fileDiff.deletions,
      diffContent: fileDiff.diffContent,
    };
  }
  return null;
}

/** diff 渲染上限：超出截断（卡片场景够用；完整 diff 在变更面板查看） */
const MAX_DIFF_LINES = 400;

/** 把 unified-diff 文本按行分类；超出 MAX_DIFF_LINES 截断并提示 */
export function parseDiffLines(diffContent: string): {
  lines: Array<{ text: string; type: "add" | "del" | "hunk" | "ctx" }>;
  omitted: number;
} {
  const all = (diffContent ?? "").split("\n");
  const visible = all.slice(0, MAX_DIFF_LINES);
  const lines = visible.map((line) => {
    if (line.startsWith("@@")) return { text: line, type: "hunk" as const };
    if (line.startsWith("+") && !line.startsWith("+++")) return { text: line, type: "add" as const };
    if (line.startsWith("-") && !line.startsWith("---")) return { text: line, type: "del" as const };
    return { text: line, type: "ctx" as const };
  });
  return { lines, omitted: Math.max(0, all.length - MAX_DIFF_LINES) };
}

/** read 卡内容渲染上限（超长文件在产物面板/编辑器打开，不在卡片里铺满 DOM） */
export const MAX_READ_PREVIEW_CHARS = 6_000;
