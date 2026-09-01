import type { ToolManifest } from "./types";

export type ToolsetManifest = {
  id: string;
  title: string;
  description: string;
  toolIds: string[];
};

export const TOOL_MANIFESTS: ToolManifest[] = [
  {
    id: "search_sessions",
    command: "/search_sessions",
    title: "搜索会话",
    description: "按标题或内容搜索本地会话",
    promptContribution: "可调用 /search_sessions <关键词> 按标题或内容检索本地历史会话。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词，匹配会话标题或内容" },
      },
      required: ["query"],
    },
  },
  {
    id: "read_session",
    command: "/read_session",
    title: "读取会话",
    description: "查看指定会话的上下文内容",
    promptContribution: "可调用 /read_session <会话 ID> 读取指定历史会话的完整上下文。",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "目标会话 ID（可先经 search_sessions 获取）" },
      },
      required: ["sessionId"],
    },
  },
  {
    id: "list_files",
    command: "/list_files",
    title: "列出文件",
    description: "浏览当前工作区的文件和目录",
    promptContribution: "可调用 /list_files [路径] 浏览工作区文件和目录结构，用于定位资料。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "可选的文件名过滤关键字，留空列出全部" },
      },
    },
  },
  {
    id: "read_file",
    command: "/read_file",
    title: "读取文件",
    description: "读取文件正文用于分析或问答",
    promptContribution: "可调用 /read_file <路径> 读取文件正文，用于分析或问答。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件在工作区内的相对路径" },
      },
      required: ["path"],
    },
  },
  {
    id: "search_files",
    command: "/search_files",
    title: "搜索文件",
    description: "按关键字搜索工作区内容",
    promptContribution: "可调用 /search_files <关键词> 在工作区范围内按关键字检索文件内容。",
    parameters: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "要在文件内容中检索的关键词" },
      },
      required: ["keyword"],
    },
  },
  {
    id: "read_persona",
    command: "/read_persona",
    title: "读取个性化档案",
    description: "读取本地个性化 md 文件的内容，字段：user_name / assistant_name / persona_description / custom_instruction / long_term_memory / agents_md / style",
    promptContribution:
      "可调用 /read_persona <字段> 读取本地个性化档案（称呼、名字、人设、自定义指令、长期记忆、AGENTS.md、风格），用于贴合用户偏好。",
    parameters: {
      type: "object",
      properties: {
        field: {
          type: "string",
          description: "档案字段名：style / userName / assistantName / personaDescription / customInstruction / longTermMemory / agentsMd",
        },
      },
      required: ["field"],
    },
  },
  {
    id: "update_persona",
    command: "/update_persona",
    title: "更新个性化档案",
    description: "把一条长期偏好、称呼或人设写入对应的个性化 md 文件，字段同上；用法：/update_persona <字段> <内容>",
    promptContribution:
      "可调用 /update_persona <字段> <内容> 把稳定的偏好、称呼或人设写入对应个性化 md 文件（含 AGENTS.md），用法：/update_persona <字段> <内容>。",
  },
  {
    id: "install_expert",
    command: "/install_expert",
    title: "安装专家",
    description: "把一条符合 Omni 规范的专家定义（kind 为 expert 的 PluginManifest）注册进本地插件库，注册后可在「专家分类 → 我的专家」查看使用",
    promptContribution:
      "可调用 /install_expert 把符合 Omni 规范的专家定义（PluginManifest，kind 固定为 expert）注册进本地插件库，注册后立即在「专家分类 → 我的专家」生效；仅在用户要求创建/安装/更新专家时使用，参数为完整专家 manifest JSON。",
    parameters: {
      type: "object",
      properties: {
        manifest: {
          type: "object",
          description:
            "符合 Omni 规范的专家 PluginManifest 定义：id（kebab-case 唯一标识）、name（展示名）、description（一句话描述）、version、kind（固定 expert）、category（行业分类）、icon（lucide 图标名）、tags（3 个擅长领域标签）、templatePrompt（专家系统提示词，可直接执行、不含占位符）、defaultToolIds（推荐工具 id）、defaultSkillIds（推荐技能 id）",
        },
      },
      required: ["manifest"],
    },
  },
];

export const TOOLSET_MANIFESTS: ToolsetManifest[] = [
  {
    id: "basic-chat",
    title: "Omni",
    description: "适合日常问答和话题管理",
    toolIds: ["search_sessions", "read_session"],
  },
  {
    id: "content-creation",
    title: "内容创作",
    description: "适合写作、改写和内容整理",
    toolIds: ["search_sessions", "read_session", "read_file"],
  },
  {
    id: "code-analysis",
    title: "代码分析",
    description: "适合搜索、阅读和分析工作区文件",
    toolIds: ["search_sessions", "read_session", "list_files", "read_file", "search_files"],
  },
  {
    id: "file-processing",
    title: "文件处理",
    description: "适合浏览目录、读取文件和定位内容",
    toolIds: ["list_files", "read_file", "search_files"],
  },
];

export const PROJECT_TOOL_MANIFESTS = TOOL_MANIFESTS.filter((tool) =>
  ["search_sessions", "read_session", "list_files", "read_file", "search_files"].includes(tool.id)
);

export const PROJECT_TOOL_OPTIONS = PROJECT_TOOL_MANIFESTS.map((tool) => ({
  id: tool.id,
  label: tool.title,
  description: tool.description,
}));

export const ALWAYS_ALLOWED_LOCAL_TOOL_IDS = [
  "read_persona",
  "update_persona",
  "install_expert",
];

export function getToolManifestById(id: string) {
  return TOOL_MANIFESTS.find((tool) => tool.id === id) ?? null;
}
