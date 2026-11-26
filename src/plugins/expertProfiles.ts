import type { ExpertProfile, PluginManifest } from "./types";

/** 将 DSH 专家的结构化资料编译为 Omni 运行时使用的角色提示词。 */
export function compileExpertTemplatePrompt(name: string, profile: ExpertProfile): string {
  const examples = profile.examples.length > 0
    ? ["", "## 使用示例", ...profile.examples.map((example) => `- ${example.title}：${example.prompt}`)]
    : [];
  return [
    `你是「${name}」。`,
    "",
    "## 角色定位",
    profile.role,
    "",
    "## 工作方法",
    profile.methodology,
    "",
    "## 行为边界",
    profile.boundaries,
    "",
    "## 交付物",
    profile.deliverables,
    ...examples,
  ].join("\n");
}

/** 从旧版只有 templatePrompt 的专家补齐统一资料形状，避免历史档案失效。 */
export function legacyExpertProfile(manifest: Pick<PluginManifest, "templatePrompt">): ExpertProfile {
  return {
    role: manifest.templatePrompt?.trim() || "按用户要求完成被分配的专家任务。",
    methodology: "先确认目标、事实和约束，再按步骤完成任务，并区分事实、判断与待确认项。",
    boundaries: "不臆造用户未提供的事实、数据或结论；信息不足时明确说明并提出需要确认的问题。",
    deliverables: "按用户要求交付结构化、可核验的结果，并说明仍需确认的事项。",
    examples: [
      { id: "example-direct", title: "直接委派任务", prompt: "请根据我的目标和已有材料完成这项专家任务，并先列出关键假设。" },
      { id: "example-review", title: "检查交付结果", prompt: "请检查刚才的结果是否满足目标、约束和交付要求，并列出仍需确认的事项。" },
    ],
  };
}

/** 将任意来源的专家 manifest 收敛为统一 DSH 档案。 */
export function canonicalizeExpertManifest(manifest: PluginManifest): PluginManifest {
  if (manifest.kind !== "expert") return manifest;
  const expertProfile = manifest.expertProfile ?? legacyExpertProfile(manifest);
  return {
    ...manifest,
    expertProfile,
    templatePrompt: compileExpertTemplatePrompt(manifest.name, expertProfile),
  };
}
