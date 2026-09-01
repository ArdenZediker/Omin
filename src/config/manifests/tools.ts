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
  {
    id: "web_search",
    command: "/web_search",
    title: "联网搜索",
    description: "用 DuckDuckGo 检索互联网，返回标题、链接与摘要",
    promptContribution:
      "可调用 /web_search 检索互联网获取实时信息；当用户询问新闻、价格、版本、天气、赛果等时效性内容时应主动使用。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词（支持中英文）" },
        limit: { type: "number", description: "返回条数 1-15，默认 8" },
      },
      required: ["query"],
    },
  },
  {
    id: "web_fetch",
    command: "/web_fetch",
    title: "网页抓取",
    description: "抓取指定 URL 的网页正文（转为纯文本），附主要链接列表",
    promptContribution:
      "可调用 /web_fetch 抓取网页正文；拿到 /web_search 的链接或用户提供 URL 后，用它读取页面内容做进一步分析。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "完整 http/https 链接" },
        max_chars: { type: "number", description: "返回正文最大字符数，默认 12000，上限 50000" },
      },
      required: ["url"],
    },
  },
  {
    id: "git_info",
    command: "/git_info",
    title: "Git 查看",
    description: "查看 Git 仓库状态 / 提交历史 / 差异 / 分支（只读）",
    promptContribution:
      "可调用 /git_info 查看 Git 仓库的 status、log、diff、diff-staged、branch；分析代码变更或排查问题时使用。",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: "操作：status / log / diff / diff-staged / branch",
          enum: ["status", "log", "diff", "diff-staged", "branch"],
        },
        path: { type: "string", description: "仓库路径，缺省用当前项目工作区" },
        limit: { type: "number", description: "log 的条数上限（1-50，默认 20）" },
      },
      required: ["operation"],
    },
  },
  {
    id: "git_commit",
    command: "/git_commit",
    title: "Git 提交",
    description: "暂存变更并创建 Git 提交",
    promptContribution:
      "可调用 /git_commit 暂存并提交变更：传 message（提交信息，必填）；addAll=true 全量暂存，或 paths 指定文件；未指定时要求暂存区已有内容。仅在用户明确要求提交时使用。",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "提交信息（必填）" },
        path: { type: "string", description: "仓库路径，缺省用当前项目工作区" },
        add_all: { type: "boolean", description: "true 时等价 git add -A" },
        paths: {
          type: "array",
          description: "要暂存的文件路径列表",
          items: { type: "string" },
        },
      },
      required: ["message"],
    },
  },
  {
    id: "git_pr",
    command: "/git_pr",
    title: "Git 创建 PR",
    description: "推送当前分支并用 GitHub CLI 创建 Pull Request",
    promptContribution:
      "可调用 /git_pr 推送当前分支并创建 GitHub PR（需已安装 gh 并登录）；仅在用户明确要求创建 PR 时使用。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "PR 标题（必填）" },
        body: { type: "string", description: "PR 描述（Markdown）" },
        base: { type: "string", description: "目标分支，缺省用仓库默认分支" },
        path: { type: "string", description: "仓库路径，缺省用当前项目工作区" },
      },
      required: ["title"],
    },
  },
  {
    id: "export_docx",
    command: "/export_docx",
    title: "导出 Word 文档",
    description: "把结构化内容导出为真正的 .docx 文件（标题/段落/加粗/列表/表格/分页）",
    promptContribution:
      "可调用 /export_docx 把报告、方案等内容导出为 .docx 文件；spec.children 支持 h1/h2/h3/p/bullet/number/pagebreak/table，段落支持 **加粗** 内联语法；生成后告知用户文件路径。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "输出文件绝对路径（以 .docx 结尾）" },
        spec: {
          type: "object",
          description:
            "文档结构：{ title?, children: [{type:'h1'|'h2'|'h3'|'p'|'bullet'|'number'|'pagebreak', text, align?}, {type:'table', rows:[[cell]], header?}] }",
        },
        overwrite: { type: "boolean", description: "文件已存在时是否覆盖，默认 false" },
      },
      required: ["path", "spec"],
    },
  },
  {
    id: "export_xlsx",
    command: "/export_xlsx",
    title: "导出 Excel 表格",
    description: "把表格数据导出为真正的 .xlsx 文件（多工作表/数字/公式/表头样式）",
    promptContribution:
      "可调用 /export_xlsx 把数据表、清单导出为 .xlsx 文件；spec.sheets 每项含 name 与 rows，单元格可为字符串/数字/{formula:'SUM(B2:B3)'}/{text,style:'bold'|'header'}；生成后告知用户文件路径。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "输出文件绝对路径（以 .xlsx 结尾）" },
        spec: {
          type: "object",
          description:
            "表格结构：{ sheets: [{ name, rows: [[字符串|数字|{formula}|{text,style:'bold'|'header'}]] }] }",
        },
        overwrite: { type: "boolean", description: "文件已存在时是否覆盖，默认 false" },
      },
      required: ["path", "spec"],
    },
  },
  {
    id: "export_pptx",
    command: "/export_pptx",
    title: "导出 PPT 演示",
    description: "把大纲内容导出为真正的 .pptx 演示文稿（16:9，标题+要点页）",
    promptContribution:
      "可调用 /export_pptx 把大纲、汇报内容导出为 .pptx 演示文稿；spec.slides 每页含 title 与 bullets（要点数组，≤20 条）；生成后告知用户文件路径。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "输出文件绝对路径（以 .pptx 结尾）" },
        spec: {
          type: "object",
          description: "演示结构：{ slides: [{ title, bullets: [string] }] }",
        },
        overwrite: { type: "boolean", description: "文件已存在时是否覆盖，默认 false" },
      },
      required: ["path", "spec"],
    },
  },
  {
    id: "install_skill",
    command: "/install_skill",
    title: "安装自造技能",
    description: "把一份技能定义（Markdown 正文，可选 frontmatter）写入本地技能库并注册启用",
    promptContribution:
      "可调用 /install_skill 把产出的技能定义落盘注册为本地技能（id kebab-case、name、description、content 为 Markdown 正文）；仅在用户要求创建/保存技能时使用。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "技能唯一标识（kebab-case，如 weekly-report）" },
        name: { type: "string", description: "技能展示名" },
        description: { type: "string", description: "一句话描述（用于触发匹配）" },
        content: { type: "string", description: "技能正文（Markdown；可带 --- frontmatter）" },
        tags: { type: "array", description: "标签", items: { type: "string" } },
      },
      required: ["id", "content"],
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
  [
    "search_sessions",
    "read_session",
    "list_files",
    "read_file",
    "search_files",
    "web_search",
    "web_fetch",
    "git_info",
    "git_commit",
    "git_pr",
    "export_docx",
    "export_xlsx",
    "export_pptx",
    "install_skill",
  ].includes(tool.id)
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
  "install_skill",
];

export function getToolManifestById(id: string) {
  return TOOL_MANIFESTS.find((tool) => tool.id === id) ?? null;
}
