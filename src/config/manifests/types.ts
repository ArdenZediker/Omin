export type ProjectPreset = {
  id: string;
  title: string;
  description: string;
};

/** function calling 参数的 JSON Schema 属性（支持一层嵌套对象数组，如 agent 工具的 tasks 批量派发）。 */
export type ToolParamProperty = {
  type: string;
  description: string;
  enum?: string[];
  items?: {
    type: string;
    description?: string;
    properties?: Record<string, ToolParamProperty>;
    required?: string[];
  };
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
  /**
   * function calling 的参数 JSON Schema（buildChatTools 直接透传给适配器）。
   * 字段名必须与 chatRuntimeHelpers.extractToolCallArgs 的 directKeys 对齐，
   * 否则模型传的对象参数会被兜底拼接成 "key=value" 破坏 execute 解析。
   */
  parameters?: {
    type: "object";
    properties: Record<string, ToolParamProperty>;
    required?: string[];
  };
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
