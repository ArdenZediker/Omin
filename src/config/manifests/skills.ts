import type { SkillManifest } from "./types";

export const SKILL_MANIFESTS: SkillManifest[] = [
  {
    id: "summarize",
    command: "/summarize",
    title: "总结",
    description: "提炼重点，输出简洁摘要",
    promptPrefix: "请总结下面的内容，输出重点、结论和后续行动建议：\n\n",
    parameterSchema: [{ id: "content", label: "待总结内容", required: true, placeholder: "输入需要总结的文本" }],
    supportedAssistantKinds: ["basic", "custom"],
  },
  {
    id: "translate",
    command: "/translate",
    title: "翻译",
    description: "在多语言之间转换内容",
    promptPrefix: "请把下面的内容翻译成自然、准确的中文：\n\n",
    parameterSchema: [{ id: "content", label: "待翻译内容", required: true, placeholder: "输入需要翻译的文本" }],
    supportedAssistantKinds: ["basic", "custom"],
  },
  {
    id: "rewrite",
    command: "/rewrite",
    title: "改写",
    description: "按语气或风格重写表达",
    promptPrefix: "请在不改变原意的前提下，重写下面的内容，让它更专业、清晰、简洁：\n\n",
    parameterSchema: [{ id: "content", label: "待改写内容", required: true, placeholder: "输入需要改写的文本" }],
    supportedAssistantKinds: ["basic", "custom"],
  },
  {
    id: "explain",
    command: "/explain",
    title: "解释",
    description: "解释概念、代码或流程",
    promptPrefix: "请解释下面的内容，并补充关键背景与注意事项：\n\n",
    parameterSchema: [{ id: "content", label: "待解释内容", required: true, placeholder: "输入需要解释的内容" }],
    supportedAssistantKinds: ["basic", "custom"],
  },
  {
    id: "compare",
    command: "/compare",
    title: "对比",
    description: "比较方案差异与优缺点",
    promptPrefix: "请对比下面提到的方案，输出优点、缺点、适用场景和建议：\n\n",
    parameterSchema: [{ id: "content", label: "待对比内容", required: true, placeholder: "输入需要对比的方案" }],
    supportedAssistantKinds: ["basic", "custom"],
  },
];

export const ASSISTANT_SKILL_OPTIONS = SKILL_MANIFESTS.map((skill) => ({
  id: skill.id,
  label: skill.title,
  description: skill.description,
}));
