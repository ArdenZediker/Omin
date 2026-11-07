import { invoke } from "@tauri-apps/api/core";
import type { ChatExecutionResult } from "./types";

const FILE_EXPORT_TOOLS = new Set(["export_docx", "export_xlsx", "export_pptx", "export_md"]);

/** 只确认可验证的交付事实；不把模型文字当作文件存在的证据。 */
export async function validateTaskOutput(result: ChatExecutionResult | undefined) {
  if (!result) throw new Error("任务没有返回结果");
  const calls = result.steps?.filter((step) => step.type === "tool_call") ?? result.toolCallResults ?? [];
  const failed = calls.filter((call) => call.isError);
  if (failed.length) throw new Error(`部分工具执行失败：${[...new Set(failed.map((call) => call.name))].join("、")}。已返回的内容已保留。`);
  if (calls.some((call) => "status" in call && (call.status === "running" || call.status === "interrupted"))) {
    throw new Error("仍有工具未完成，已返回的内容已保留");
  }
  const hasDelivery = calls.some((call) => call.result?.trim()) || result.steps?.some((step) => step.type === "artifact" && step.artifactId);
  if (!result.content?.trim() && !hasDelivery) throw new Error("模型返回空结果，请检查模型配置或重试");
  for (const call of calls) {
    if (!FILE_EXPORT_TOOLS.has(call.name)) continue;
    if (!call.path) throw new Error(`未能确认 ${call.name} 的产物路径，不能标记交付成功`);
    if (!(await invoke<boolean>("path_exists", { path: call.path }))) {
      throw new Error(`生成的文件不存在：${call.path}`);
    }
  }
}
