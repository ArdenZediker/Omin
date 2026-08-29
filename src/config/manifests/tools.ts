import type { ToolManifest } from "./types";

export type ToolsetManifest = {
  id: string;
  title: string;
  description: string;
  toolIds: string[];
};

export const TOOL_MANIFESTS: ToolManifest[] = [
  {
    id: "new",
    command: "/new",
    title: "新对话",
    description: "创建一个新的空白对话",
    promptContribution: "可调用 /new 开始一个全新空白对话，适合切换话题或清理上下文。",
  },
  {
    id: "clear",
    command: "/clear",
    title: "清空消息",
    description: "清空当前对话中的消息",
    promptContribution: "可调用 /clear 清空当前对话中的消息，但保留助手与个性化设定。",
  },
  {
    id: "settings",
    command: "/settings",
    title: "打开设置",
    description: "打开设置页面",
    promptContribution: "可调用 /settings 打开设置页面，引导用户调整偏好、模型或个性化。",
  },
  {
    id: "pet",
    command: "/pet",
    title: "宠物",
    description: "唤醒或收起桌面宠物",
    promptContribution: "可调用 /pet 唤醒或收起桌面宠物（桌宠形态），用于轻量陪伴交互。",
  },
  {
    id: "model",
    command: "/model",
    title: "切换模型",
    description: "输入模型 ID 或名称后切换模型",
    promptContribution: "可调用 /model <模型 ID 或名称> 切换当前会话使用的模型。",
  },
  {
    id: "remember",
    command: "/remember",
    title: "记住",
    description: "把一条长期偏好或约束保存到当前助手记忆库",
    promptContribution: "可调用 /remember <内容> 把一条稳定偏好或约束写入当前助手的长期记忆库。",
  },
  {
    id: "rename",
    command: "/rename",
    title: "重命名对话",
    description: "重命名当前对话",
    promptContribution: "可调用 /rename <标题> 重命名当前对话，便于后续检索。",
  },
  {
    id: "pin",
    command: "/pin",
    title: "置顶对话",
    description: "置顶或取消置顶当前对话",
    promptContribution: "可调用 /pin 置顶或取消置顶当前对话。",
  },
  {
    id: "search_sessions",
    command: "/search_sessions",
    title: "搜索会话",
    description: "按标题或内容搜索本地会话",
    promptContribution: "可调用 /search_sessions <关键词> 按标题或内容检索本地历史会话。",
  },
  {
    id: "read_session",
    command: "/read_session",
    title: "读取会话",
    description: "查看指定会话的上下文内容",
    promptContribution: "可调用 /read_session <会话 ID> 读取指定历史会话的完整上下文。",
  },
  {
    id: "list_files",
    command: "/list_files",
    title: "列出文件",
    description: "浏览当前工作区的文件和目录",
    promptContribution: "可调用 /list_files [路径] 浏览工作区文件和目录结构，用于定位资料。",
  },
  {
    id: "read_file",
    command: "/read_file",
    title: "读取文件",
    description: "读取文件正文用于分析或问答",
    promptContribution: "可调用 /read_file <路径> 读取文件正文，用于分析或问答。",
  },
  {
    id: "search_files",
    command: "/search_files",
    title: "搜索文件",
    description: "按关键字搜索工作区内容",
    promptContribution: "可调用 /search_files <关键词> 在工区范围内按关键字检索文件内容。",
  },
  {
    id: "analyze_files",
    command: "/analyze_files",
    title: "分析文件",
    description: "结合搜索和读取完成文件分析",
    promptContribution: "可调用 /analyze_files <任务> 结合搜索与读取完成文件级分析任务。",
  },
  {
    id: "read_persona",
    command: "/read_persona",
    title: "读取个性化档案",
    description: "读取本地个性化 md 文件的内容，字段：user_name / assistant_name / persona_description / custom_instruction / long_term_memory / agents_md / style",
    promptContribution:
      "可调用 /read_persona <字段> 读取本地个性化档案（称呼、名字、人设、自定义指令、长期记忆、AGENTS.md、风格），用于贴合用户偏好。",
  },
  {
    id: "update_persona",
    command: "/update_persona",
    title: "更新个性化档案",
    description: "把一条长期偏好、称呼或人设写入对应的个性化 md 文件，字段同上；用法：/update_persona <字段> <内容>",
    promptContribution:
      "可调用 /update_persona <字段> <内容> 把稳定的偏好、称呼或人设写入对应个性化 md 文件（含 AGENTS.md），用法：/update_persona <字段> <内容>。",
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
    toolIds: ["search_sessions", "read_session", "list_files", "read_file", "search_files", "analyze_files"],
  },
  {
    id: "file-processing",
    title: "文件处理",
    description: "适合浏览目录、读取文件和定位内容",
    toolIds: ["list_files", "read_file", "search_files"],
  },
];

export const PROJECT_TOOL_MANIFESTS = TOOL_MANIFESTS.filter((tool) =>
  ["search_sessions", "read_session", "list_files", "read_file", "search_files", "analyze_files"].includes(tool.id)
);

export const PROJECT_TOOL_OPTIONS = PROJECT_TOOL_MANIFESTS.map((tool) => ({
  id: tool.id,
  label: tool.title,
  description: tool.description,
}));

export const ALWAYS_ALLOWED_LOCAL_TOOL_IDS = [
  "new",
  "clear",
  "settings",
  "pet",
  "model",
  "remember",
  "rename",
  "pin",
  "read_persona",
  "update_persona",
];

export function getToolManifestById(id: string) {
  return TOOL_MANIFESTS.find((tool) => tool.id === id) ?? null;
}
