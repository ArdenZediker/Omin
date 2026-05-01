export type AssistantPreset = {
  id: string;
  title: string;
  description: string;
};

export type ToolManifest = {
  id: string;
  command?: string;
  title: string;
  description: string;
};

export type SkillManifest = {
  id: string;
  command: string;
  title: string;
  description: string;
  promptPrefix?: string;
  systemPrompt?: string;
  parameterSchema?: Array<{
    id: string;
    label: string;
    required?: boolean;
    placeholder?: string;
  }>;
  supportedAssistantKinds?: Array<"basic" | "custom">;
};

export type AvatarCategoryManifest = {
  id: string;
  label: string;
  icon: "history" | "sparkles" | "cpu" | "paw";
};

export type AvatarPreset = {
  code: string;
  label: string;
  category: string;
  tone: "blue" | "violet" | "amber" | "cyan" | "green" | "pink" | "slate" | "red" | "orange";
  hint: string;
  prompt: string;
  allowedToolIds?: string[];
  allowedSkillIds?: string[];
  defaultModelId?: string | null;
};
