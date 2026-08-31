export type ProjectPreset = {
  id: string;
  title: string;
  description: string;
};

export type ToolManifest = {
  id: string;
  command?: string;
  title: string;
  description: string;
  /**
   * 该工具对系统提示词的“声明式贡献”（仿 deepseek-harness 的「一切皆插件」：
   * 每个插件自带指令，注入时自动拼接，新增工具无需手动维护列表）。
   * 注入到工具协议分片时优先使用此字段，缺省回退到 description。
   */
  promptContribution?: string;
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
  supportedProjectKinds?: Array<"basic" | "custom">;
};
