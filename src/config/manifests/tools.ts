import type { ToolManifest } from "./types";

export type ToolsetManifest = {
  id: string;
  title: string;
  description: string;
  toolIds: string[];
};

export const TOOL_MANIFESTS: ToolManifest[] = [
  { id: "new", command: "/new", title: "新对话", description: "创建一个新的空白对话" },
  { id: "clear", command: "/clear", title: "清空消息", description: "清空当前对话中的消息" },
  { id: "settings", command: "/settings", title: "打开设置", description: "打开设置页面" },
  { id: "model", command: "/model", title: "切换模型", description: "输入模型 ID 或名称后切换模型" },
  { id: "rename", command: "/rename", title: "重命名对话", description: "重命名当前对话" },
  { id: "pin", command: "/pin", title: "置顶对话", description: "置顶或取消置顶当前对话" },
  { id: "search_sessions", command: "/search_sessions", title: "搜索会话", description: "按标题或内容搜索本地会话" },
  { id: "read_session", command: "/read_session", title: "读取会话", description: "查看指定会话的上下文内容" },
  { id: "list_files", command: "/list_files", title: "列出文件", description: "浏览当前工作区的文件和目录" },
  { id: "read_file", command: "/read_file", title: "读取文件", description: "读取文件正文用于分析或问答" },
  { id: "search_files", command: "/search_files", title: "搜索文件", description: "按关键字搜索工作区内容" },
  { id: "analyze_files", command: "/analyze_files", title: "分析文件", description: "结合搜索和读取完成文件分析" },
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

export const ASSISTANT_TOOL_MANIFESTS = TOOL_MANIFESTS.filter((tool) =>
  ["search_sessions", "read_session", "list_files", "read_file", "search_files", "analyze_files"].includes(tool.id)
);

export const ASSISTANT_TOOL_OPTIONS = ASSISTANT_TOOL_MANIFESTS.map((tool) => ({
  id: tool.id,
  label: tool.title,
  description: tool.description,
}));

export function getToolManifestById(id: string) {
  return TOOL_MANIFESTS.find((tool) => tool.id === id) ?? null;
}
