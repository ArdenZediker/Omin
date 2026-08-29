import type { AssistantPreset } from "./types";

export const RECOMMENDED_ASSISTANT_PRESETS: AssistantPreset[] = [
  {
    id: "solution-planner",
    title: "方案梳理助手",
    description: "帮你拆解需求、整理方案并规划执行步骤。",
  },
  {
    id: "code-debugger",
    title: "代码排查助手",
    description: "适合定位报错、梳理链路和修复方向。",
  },
  {
    id: "copy-polisher",
    title: "文案润色助手",
    description: "用于改写说明文档、PR 描述和提示词。",
  },
  {
    id: "command-helper",
    title: "效率命令助手",
    description: "快速生成常用命令、脚本和操作建议。",
  },
];
