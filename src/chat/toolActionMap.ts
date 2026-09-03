// 工具名 → 人类可读「动作」映射（WorkBuddy 式深度思考时间线渲染用）
// 把模型发起的工具调用（如 list_files / export_docx / git_commit）映射成
// 中文动作动词 + 英文标题 + 图标 + 是否产出文件，供 ChatMessage 渲染成
// 「运行命令 / 写入 / 导出 / 创建」等可读动作行，并在产出文件时附迷你文件卡片。
import {
  Archive,
  Eye,
  FileDown,
  FilePen,
  FolderTree,
  GitBranch,
  Globe,
  PackagePlus,
  Pencil,
  Plug,
  Search,
  Terminal as TerminalIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface ToolActionMeta {
  /** 中文动作动词，如「导出」「写入」 */
  verb: string;
  /** 英文工具/动作标题，如「Export Word」 */
  title: string;
  icon: LucideIcon;
  /** 该工具是否产出/修改文件（决定是否渲染迷你文件卡片） */
  producesFile: boolean;
}

const VERB_MAP: Record<string, ToolActionMeta> = {
  search_sessions: { verb: "搜索", title: "Search Sessions", icon: Search, producesFile: false },
  read_session: { verb: "读取", title: "Read Session", icon: Eye, producesFile: false },
  list_files: { verb: "列出", title: "List Files", icon: FolderTree, producesFile: false },
  read_file: { verb: "读取", title: "Read File", icon: Eye, producesFile: false },
  search_files: { verb: "搜索", title: "Search Files", icon: Search, producesFile: false },
  read_persona: { verb: "读取", title: "Read Persona", icon: Eye, producesFile: false },
  update_persona: { verb: "更新", title: "Update Persona", icon: Pencil, producesFile: true },
  install_expert: { verb: "安装", title: "Install Expert", icon: PackagePlus, producesFile: false },
  install_skill: { verb: "安装", title: "Install Skill", icon: PackagePlus, producesFile: false },
  web_search: { verb: "搜索", title: "Web Search", icon: Search, producesFile: false },
  web_fetch: { verb: "抓取", title: "Web Fetch", icon: Globe, producesFile: false },
  git_info: { verb: "查看", title: "Git Info", icon: GitBranch, producesFile: false },
  git_commit: { verb: "提交", title: "Git Commit", icon: GitBranch, producesFile: true },
  git_pr: { verb: "创建", title: "Git PR", icon: GitBranch, producesFile: false },
  export_docx: { verb: "导出", title: "Export Word", icon: FileDown, producesFile: true },
  export_xlsx: { verb: "导出", title: "Export Excel", icon: FileDown, producesFile: true },
  export_pptx: { verb: "导出", title: "Export PPT", icon: FileDown, producesFile: true },
  export_md: { verb: "导出", title: "Export Markdown", icon: FileDown, producesFile: true },
  // 本地工具可能以工具名直接作为 step.name 出现
  write_text_file: { verb: "写入", title: "Write File", icon: FilePen, producesFile: true },
  read_text_file: { verb: "读取", title: "Read File", icon: Eye, producesFile: false },
};

/** 未知工具名的回退判定：按名称特征推断是否产出文件 */
function inferProducesFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("export") ||
    lower.includes("write") ||
    lower.includes("commit") ||
    lower.includes("update_persona")
  );
}

/** 获取工具的动作元数据。
 *  MCP 连接器工具（`mcp__{serverId}__{toolName}`）解析出工具名展示「调用 MCP · toolName」；
 *  其余未知工具回退到「调用 + Terminal 图标」。 */
export function getToolActionMeta(name: string): ToolActionMeta {
  const known = VERB_MAP[name];
  if (known) return known;
  if (name.startsWith("mcp__")) {
    const toolName = name.split("__").slice(2).join("__") || name;
    return {
      verb: "调用",
      title: `MCP · ${toolName}`,
      icon: Plug,
      producesFile: inferProducesFile(toolName),
    };
  }
  return {
    verb: "调用",
    title: name,
    icon: TerminalIcon,
    producesFile: inferProducesFile(name),
  };
}

/** 该工具是否产出/修改文件 */
export function isFileProducingTool(name: string): boolean {
  return getToolActionMeta(name).producesFile;
}

/** 文件产出工具的迷你卡片状态标签（如「已导出」「已写入」） */
export function getFileBadgeLabel(name: string): string {
  if (name.startsWith("export_")) return "已导出";
  if (name === "write_text_file") return "已写入";
  if (name === "update_persona") return "已更新";
  if (name === "git_commit") return "已提交";
  return "已生成";
}

/** 从工具参数 JSON 提取首个文件路径（用于迷你文件卡片）；无则返回 undefined */
export function extractToolFilePath(args: string | undefined, name: string): string | undefined {
  if (!isFileProducingTool(name)) return undefined;
  const trimmed = (args ?? "").trim();
  if (!trimmed) return undefined;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const candidate = obj?.path;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  } catch {
    // 非 JSON 参数忽略
  }
  return undefined;
}

/** lucide 图标名 → 图标组件（用于 action step 的 icon 字段回退） */
export function iconByName(name?: string): LucideIcon | undefined {
  if (!name) return undefined;
  const map: Record<string, LucideIcon> = {
    Search,
    Archive,
    Eye,
    FolderTree,
    GitBranch,
    Globe,
    PackagePlus,
    Pencil,
    FileDown,
    FilePen,
    Terminal: TerminalIcon,
  };
  return map[name];
}
