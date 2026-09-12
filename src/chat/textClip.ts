/**
 * 长文本的 head + tail 截断（TS 侧唯一实现）。
 *
 * 为什么不是「只留开头」：工具输出里真正要命的信息常常在**尾部** —— 报错栈的最后一行、
 * 测试汇总的 `N failed`、diff 的收尾 hunk、命令的退出提示。只留 head 等于把结论砍掉，
 * 模型会拿着半截日志编原因，或者干脆原样重跑来「再试一次」。
 *
 * 形态刻意与 Rust 侧 `tool_output_spill::head_tail_preview` 保持一致（head 60% / tail 40%，
 * 中间标注省略字符数），这样同一份输出无论在哪一层被截，模型看到的形状都一样。
 */

/** 默认 head 占比（与 Rust 侧一致）。 */
const HEAD_RATIO = 0.6;

/** 截断标记：`…[中间省略 N 字符…]…`，与 Rust 预览同款。 */
export function headTailMarker(omitted: number): string {
  return `…[中间省略 ${omitted} 字符…]`;
}

export interface HeadTailResult {
  /** 截断后的文本；未超限时原样返回。 */
  text: string;
  /** 被省略的字符数（未超限为 0）。 */
  omitted: number;
  /** 是否发生了截断。 */
  clipped: boolean;
}

/**
 * 保留开头约 60% 与结尾约 40%，中间插省略标记。
 *
 * 按**字符**而非 UTF-16 code unit 计数：中文/emoji 下 `String.length` 会把一个字符算成
 * 1～2，直接用 slice 既可能截出半个代理对（渲染成乱码），也让「字符数」在提示里失真。
 */
export function headTailClip(text: string, maxChars: number): HeadTailResult {
  if (maxChars <= 0) return { text: "", omitted: text.length, clipped: text.length > 0 };
  const chars = Array.from(text);
  const total = chars.length;
  if (total <= maxChars) return { text, omitted: 0, clipped: false };

  const headChars = Math.floor(maxChars * HEAD_RATIO);
  const tailChars = Math.max(maxChars - headChars, 0);
  const head = chars.slice(0, headChars).join("");
  const tail = tailChars > 0 ? chars.slice(total - tailChars).join("") : "";
  const omitted = Math.max(total - headChars - tailChars, 0);
  const joined = tail ? `${head}\n${headTailMarker(omitted)}\n${tail}` : `${head}\n${headTailMarker(omitted)}`;
  return { text: joined, omitted, clipped: true };
}
