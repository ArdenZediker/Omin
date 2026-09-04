// /search_files 工具输出的文本解析：把「path:line 内容」匹配行抽出来，
// 供 ExecutionTimeline 渲染可点击的命中行（点击 → 产物面板打开该文件并定位行号）。
// 解析文本而非结构化 data 的原因：ChatStep 只持久化 result 字符串，
// 解析文本对历史会话的旧消息同样生效（向后兼容）。
//
// 输出格式（localTools search_files）：
//   找到 N 个相关匹配：
//   1.
//     上下文行（前）      ← 以两个空格缩进
//   src/app.ts:42 const x = 1   ← 命中行（无缩进）
//     上下文行（后）

export interface ParsedSearchMatch {
  /** 匹配文件路径（相对工作区根，或绝对路径） */
  path: string;
  /** 匹配行号（1-based） */
  line: number;
  /** 匹配行内容 */
  text: string;
}

/**
 * 从 search_files 结果文本中解析命中行。
 * 规则：只认「非缩进行」里的 `路径:行号 内容`；路径 token 不含空白
 * （含空格的路径会被跳过——显示不受影响，只是不可点击）。
 * 行号限定 1..=1_000_000，避免把普通文本里的「时间 12:30」之类误判成命中。
 */
export function parseSearchMatches(result: string): ParsedSearchMatch[] {
  const matches: ParsedSearchMatch[] = [];
  const lines = (result ?? "").split(/\r?\n/);
  // 跳过首行统计头（「找到 N 个相关匹配：」/「没有文件内容匹配…」）
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || /^\s/.test(line)) continue;
    const matched = /^(\S+):(\d{1,7})\s(.*)$/.exec(line);
    if (!matched) continue;
    const line_number = Number(matched[2]);
    if (!Number.isFinite(line_number) || line_number < 1) continue;
    matches.push({ path: matched[1], line: line_number, text: matched[3] });
  }
  return matches;
}
