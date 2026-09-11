import type { ToolManifest, ToolParamProperty } from "../config/manifests/types";

type ToolParameters = NonNullable<ToolManifest["parameters"]>;

/** 值的人类可读类型（用于错误文案）。 */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "数组";
  if (value === null) return "null";
  return typeof value;
}

/**
 * 是否「严重类型不符」。刻意只抓最明显的一类错误——把对象/数组塞进标量字段、
 * 或把文字塞进数值字段。string↔number↔boolean 之间的宽容转换一概放行，
 * 因为工具侧（strArg/numArg/boolArg）本来就会做这层转换，不该在这里拦下。
 */
function isSeverelyMismatched(prop: ToolParamProperty, value: unknown): boolean {
  if (value === null) return false; // null 交给必填判定，不算类型错
  const type = prop.type;
  if (type === "object") return typeof value !== "object" || Array.isArray(value);
  if (type === "array") return !Array.isArray(value);
  if (typeof value === "object") return true; // 标量字段收到对象/数组
  if (type === "integer" || type === "number") {
    if (typeof value === "number") return !Number.isFinite(value);
    if (typeof value === "string") return !Number.isFinite(Number(value.trim()));
    return true; // boolean 传给数值字段
  }
  if (type === "boolean") {
    if (typeof value === "boolean") return false;
    if (typeof value === "string") {
      const text = value.trim();
      return text !== "true" && text !== "false";
    }
    return true;
  }
  if (type === "string") {
    // 模型常把数字/布尔填进字符串字段，工具侧能接住，这里不为难。
    return typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean";
  }
  return false;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

/**
 * 用工具 manifest 的 parameters（与下发给模型的是**同一份**）校验一次调用的参数。
 * 通过返回 null，失败返回给模型看的错误文案。
 *
 * 入参必须是**未经上游变换**的原始对象（`extractToolCallArgsDetailed` 的 `rawObject`），
 * 不能用 `args` 文本：单字段会被拆成裸值、`{manifest:{...}}` 会被拆包，拿它比对必然误判。
 *
 * 三条边界（刻意保守，避免把现在能跑的场景拦下来）：
 * 1. 没有 parameters 声明的工具不校验；
 * 2. `rawObject` 为 null 表示原始入参不是 JSON 对象（模型直接给了字符串，或用户手敲斜杠命令），
 *    此时没有字段名可比对，一律放行——斜杠命令路径因此天然不受影响；
 * 3. 只有「缺必填」与「类型严重不符」判失败，宽容转换（string↔number↔boolean）放行。
 *
 * 失败文案由调用方回填给模型（对齐 codex `parse_arguments` 的 RespondToModel）。
 */
export function validateToolArgs(
  parameters: ToolParameters | undefined,
  rawObject: Record<string, unknown> | null | undefined,
): string | null {
  if (!parameters) return null;
  if (!rawObject) return null;

  // 只校验 schema 里声明过的字段；未知字段放行（模型可能带扩展参数）。
  for (const [key, value] of Object.entries(rawObject)) {
    const prop = parameters.properties[key];
    if (!prop) continue;
    if (isSeverelyMismatched(prop, value)) {
      return `参数 ${key} 类型不符：期望 ${prop.type}，实际收到 ${describeValue(value)}`;
    }
  }

  const required = parameters.required ?? [];
  const missing = required.filter((key) => isEmptyValue(rawObject[key]));
  if (missing.length > 0) {
    return `缺少必填参数：${missing.join("、")}`;
  }

  return null;
}
