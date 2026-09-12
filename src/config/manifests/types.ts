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
   * 并行安全声明（对齐 harness 的 isConcurrencySafe 契约）：
   * 仅显式声明 true 的只读工具可与同轮其他安全工具并行执行；
   * 未声明或 false 的工具（写入/安装/shell/导出/子 Agent）独占执行，
   * 与任何其他调用串行，避免同轮读写竞态。缺省视为不安全（保守默认）。
   */
  concurrencySafe?: boolean;
  /**
   * function calling 的参数 JSON Schema（buildChatTools 直接透传给适配器）。
   * 单参数字段与多参数字段都安全：单个字段由 chatRuntimeHelpers.extractToolCallArgs
   * 直接取该字段的值作为 args；多字段则原样透传 JSON，由 execute 侧自行解析。
   */
  parameters?: {
    type: "object";
    properties: Record<string, ToolParamProperty>;
    required?: string[];
  };
};

