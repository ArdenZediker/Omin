import type { PluginManifest } from "./types";

/**
 * 内置插件目录。
 * 把原来散落各处的 skill / tool / connector preset / project preset / expert 统一收敛到 manifest，
 * 新增能力只需新增一条 manifest，无需改业务代码。
 */

export const BUILTIN_SKILL_PLUGINS: PluginManifest[] = [
  {
    id: "expert-manager",
    name: "专家管理",
    description:
      "当用户需要创建、修改、审查或更新专家（expert 插件）时使用。触发词：创建专家、转化专家、生成专家包、导入专家、修改专家、编辑专家、审查专家包、专家合规、expert ops。支持交互对话与资料转化两种输入模式。",
    version: "1.0.0",
    author: "Omni",
    kind: "skill",
    category: "AI Agent",
    icon: "UserCog",
    command: "/expert-manager",
    systemPrompt: `你是 Omni 的专家包管理器，帮助用户按 Omni 插件规范创建和维护专家（kind: "expert" 的插件条目）。

【Omni 专家是什么】在 Omni 中，专家不是文件目录，而是一条 PluginManifest(kind: "expert")：内置专家定义在 src/plugins/builtins.ts 的 BUILTIN_EXPERT_PLUGINS，安装的专家由 pluginRegistry 存入本地存储。因此本技能产出的是结构化的专家定义（可 JSON 展示），而不是 WorkBuddy 式 plugin.json + agents/*.md + marketplace.json 文件包。

【字段规范】生成专家时必须严格遵循以下字段：
- id：kebab-case 唯一标识（如 dev-expert），创建后不可改
- name：展示名/职业头衔，中文为主（如 "编程专家"）
- description：一句话描述，30-60 字，突出核心能力与触发场景，便于匹配
- version：如 "1.0.0"
- author：作者（"Omni" 或用户名）
- kind：固定 "expert"，不可改
- category：行业分类，从 Omni 分类中选择（开发编程/内容创作/数据分析/知识管理/商业运营/设计多媒体/AI Agent/教育学习/行业专业 等），须与专家核心能力匹配并说明理由
- icon：lucide 图标名（如 Code2、PenTool、Bot、BarChart3、Store）
- tags：擅长领域标签，固定 3 个（中英文均可）
- templatePrompt：专家系统提示词，写明角色定位 + 工作方式 + 输出偏好，可直接执行、不含占位符
- defaultToolIds：推荐工具 id 列表（从内置工具中选：list_files、read_file、search_files、analyze_files、search_sessions、read_session）
- defaultSkillIds：推荐技能 id 列表，从已安装技能中选；如无可推荐项可留空数组

【类型与分类判定】单角色 = agent 型专家（一条 manifest）；多角色协作团队 Omni 暂不支持单条目表达，应拆分为多个 agent 专家并在 templatePrompt 中注明协作方式。分类判定优先级：①主要输出物属于哪个领域；②服务对象是谁；③跨领域时选最核心的一个。

【场景 A：交互创建】按顺序收集：专家类型 → 领域 → 名字（中英文）→ 职业头衔 → 能力描述 → 行业分类 → 3 个标签 → 推荐提示词（3 条，第一条作开场白）→ 推荐工具/技能。信息不足时先提问补全，不要臆造。

【场景 B：资料转化】用户提供文档/提示词/流程时：①读取并提取角色定义、核心能力、SOP、输出规范、约束、参考材料、角色分工；②推断 expertType 与 category 并向用户说明理由；③确认后按字段规范生成。

【场景 C：修改已有专家】定位目标专家（内置或已安装）→ 确认修改范围 → 仅修改用户要求的部分，保持风格一致 → 重新校验。严禁修改 id（唯一标识，改名需新建）。

【校验自检清单】生成后逐项检查：id 为 kebab-case；tags 恰好 3 个；description 简洁准确；templatePrompt 不含 [TODO]/占位符且可执行；category 与能力匹配；defaultToolIds/defaultSkillIds 引用的 id 真实存在；无同名（id 冲突）专家。

【交付】输出完整专家定义（JSON）供用户核对；用户确认后，调用 install_expert 工具把该定义注册进本地插件库（工具参数为完整专家 manifest JSON）。注册成功后如实告知用户：专家已安装，可在「专家分类 → 我的专家」查看与使用；若用户希望成为所有用户可见的内置专家，才说明需要写入 builtins.ts 的 BUILTIN_EXPERT_PLUGINS（需开发者操作）。注册返回失败（如 id 冲突、字段校验不过）时，按错误提示修正后重试。`,
  },
];

export const BUILTIN_TOOL_PLUGINS: PluginManifest[] = [
  {
    id: "new",
    name: "新对话",
    description: "当用户想开始一个全新空白对话时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "系统",
    icon: "Plus",
    command: "/new",
    promptContribution: "可调用 /new 开始一个全新空白对话，适合切换话题或清理上下文。",
  },
  {
    id: "clear",
    name: "清空消息",
    description: "当用户想清空当前对话中的消息时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "系统",
    icon: "Trash2",
    command: "/clear",
    promptContribution: "可调用 /clear 清空当前对话中的消息，但保留助手与个性化设定。",
  },
  {
    id: "settings",
    name: "打开设置",
    description: "当用户想调整偏好、模型或个性化设置时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "系统",
    icon: "Settings",
    command: "/settings",
    promptContribution: "可调用 /settings 打开设置页面，引导用户调整偏好、模型或个性化。",
  },
  {
    id: "pet",
    name: "宠物",
    description: "当用户想唤醒或收起桌面宠物时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "系统",
    icon: "PawPrint",
    command: "/pet",
    promptContribution: "可调用 /pet 唤醒或收起桌面宠物（桌宠形态），用于轻量陪伴交互。",
  },
  {
    id: "model",
    name: "切换模型",
    description: "当用户想切换当前会话使用的模型时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "系统",
    icon: "Cpu",
    command: "/model",
    promptContribution: "可调用 /model <模型 ID 或名称> 切换当前会话使用的模型。",
  },
  {
    id: "remember",
    name: "记住",
    description: "当用户想把一条长期偏好或约束保存到当前助手记忆库时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "记忆",
    icon: "Bookmark",
    command: "/remember",
    promptContribution: "可调用 /remember <内容> 把一条稳定偏好或约束写入当前助手的长期记忆库。",
  },
  {
    id: "rename",
    name: "重命名对话",
    description: "当用户想重命名当前对话时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "系统",
    icon: "Type",
    command: "/rename",
    promptContribution: "可调用 /rename <标题> 重命名当前对话，便于后续检索。",
  },
  {
    id: "pin",
    name: "置顶对话",
    description: "当用户想置顶或取消置顶当前对话时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "系统",
    icon: "Pin",
    command: "/pin",
    promptContribution: "可调用 /pin 置顶或取消置顶当前对话。",
  },
  {
    id: "search_sessions",
    name: "搜索会话",
    description: "当用户想按标题或内容搜索本地历史会话时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "知识管理",
    icon: "Search",
    command: "/search_sessions",
    promptContribution: "可调用 /search_sessions <关键词> 按标题或内容检索本地历史会话。",
  },
  {
    id: "read_session",
    name: "读取会话",
    description: "当用户想查看指定会话的上下文内容时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "知识管理",
    icon: "MessageSquare",
    command: "/read_session",
    promptContribution: "可调用 /read_session <会话 ID> 读取指定历史会话的完整上下文。",
  },
  {
    id: "list_files",
    name: "列出文件",
    description: "当用户想浏览当前工作区的文件和目录结构时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "开发编程",
    icon: "FolderTree",
    command: "/list_files",
    promptContribution: "可调用 /list_files [路径] 浏览工作区文件和目录结构，用于定位资料。",
  },
  {
    id: "read_file",
    name: "读取文件",
    description: "当用户想读取文件正文用于分析或问答时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "开发编程",
    icon: "FileText",
    command: "/read_file",
    promptContribution: "可调用 /read_file <路径> 读取文件正文，用于分析或问答。",
  },
  {
    id: "search_files",
    name: "搜索文件",
    description: "当用户想按关键字搜索工作区内容时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "开发编程",
    icon: "FileSearch",
    command: "/search_files",
    promptContribution: "可调用 /search_files <关键词> 在工作区范围内按关键字检索文件内容。",
  },
  {
    id: "analyze_files",
    name: "分析文件",
    description: "当用户想结合搜索和读取完成文件分析任务时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "开发编程",
    icon: "FileBarChart",
    command: "/analyze_files",
    promptContribution: "可调用 /analyze_files <任务> 结合搜索与读取完成文件级分析任务。",
  },
  {
    id: "read_persona",
    name: "读取个性化档案",
    description: "当用户想读取本地个性化 md 文件的内容（user_name / assistant_name / persona_description / custom_instruction / long_term_memory / agents_md / style）时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "记忆",
    icon: "UserCircle",
    command: "/read_persona",
    promptContribution:
      "可调用 /read_persona <字段> 读取本地个性化档案（称呼、名字、人设、自定义指令、长期记忆、AGENTS.md、风格），用于贴合用户偏好。",
  },
  {
    id: "update_persona",
    name: "更新个性化档案",
    description: "当用户想把稳定的偏好、称呼或人设写入对应个性化 md 文件时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "记忆",
    icon: "UserCog",
    command: "/update_persona",
    promptContribution:
      "可调用 /update_persona <字段> <内容> 把稳定的偏好、称呼或人设写入对应个性化 md 文件（含 AGENTS.md），用法：/update_persona <字段> <内容>。",
  },
  {
    id: "install_expert",
    name: "安装专家",
    description: "当用户要求把一条符合 Omni 规范的专家定义注册进本地插件库（kind 为 expert 的 PluginManifest）时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "AI Agent",
    icon: "UserPlus",
    command: "/install_expert",
    promptContribution:
      "可调用 /install_expert 把符合 Omni 规范的专家定义（PluginManifest，kind 固定为 expert）注册进本地插件库，注册后立即在「专家分类 → 我的专家」生效；仅在用户要求创建/安装/更新专家时使用，参数为完整专家 manifest JSON。",
  },
];

export const BUILTIN_CONNECTOR_PLUGINS: PluginManifest[] = [
  {
    id: "openai",
    name: "OpenAI",
    description: "连接 OpenAI 官方 API。",
    version: "1.0.0",
    author: "Omni",
    kind: "connector",
    category: "模型",
    icon: "Cloud",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    configFields: [
      { id: "apiKey", label: "API Key", type: "password", required: true, placeholder: "sk-..." },
      { id: "baseUrl", label: "Base URL（可选）", type: "string", placeholder: "https://api.openai.com/v1" },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "连接 DeepSeek 官方 API。",
    version: "1.0.0",
    author: "Omni",
    kind: "connector",
    category: "模型",
    icon: "Zap",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    configFields: [{ id: "apiKey", label: "API Key", type: "password", required: true, placeholder: "..." }],
  },
  {
    id: "claude",
    name: "Claude",
    description: "连接 Anthropic Claude API。",
    version: "1.0.0",
    author: "Omni",
    kind: "connector",
    category: "模型",
    icon: "MessagesSquare",
    provider: "claude",
    baseUrl: "https://api.anthropic.com/v1",
    configFields: [{ id: "apiKey", label: "API Key", type: "password", required: true, placeholder: "sk-ant-..." }],
  },
  {
    id: "gemini",
    name: "Gemini",
    description: "连接 Google Gemini API。",
    version: "1.0.0",
    author: "Omni",
    kind: "connector",
    category: "模型",
    icon: "Sparkles",
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    configFields: [{ id: "apiKey", label: "API Key", type: "password", required: true, placeholder: "..." }],
  },
  {
    id: "ollama",
    name: "Ollama",
    description: "连接本地 Ollama 服务。",
    version: "1.0.0",
    author: "Omni",
    kind: "connector",
    category: "模型",
    icon: "Server",
    provider: "ollama",
    baseUrl: "http://localhost:11434/v1",
    configFields: [{ id: "baseUrl", label: "服务地址", type: "string", required: true, placeholder: "http://localhost:11434/v1" }],
  },
];

export const BUILTIN_EXPERT_PLUGINS: PluginManifest[] = [
  {
    id: "dev-expert",
    name: "编程专家",
    description: "当任务涉及代码审查、架构设计、Bug 诊断、重构或技术选型时使用。",
    version: "1.0.0",
    author: "Omni",
    kind: "expert",
    category: "开发编程",
    icon: "Code2",
    tags: ["coding", "review", "architecture"],
    templatePrompt:
      "你是一名资深工程师。优先给出可运行的代码或清晰的排查步骤，不做空泛描述。需要时主动请求查看相关文件。",
    defaultToolIds: ["list_files", "read_file", "search_files", "analyze_files"],
    defaultSkillIds: [],
  },
  {
    id: "writer-expert",
    name: "写作专家",
    description: "当任务涉及文案润色、文档撰写、PR 描述或提示词优化时使用。",
    version: "1.0.0",
    author: "Omni",
    kind: "expert",
    category: "内容创作",
    icon: "PenTool",
    tags: ["writing", "polish"],
    templatePrompt:
      "你是一名专业文字编辑。保持原意不变，优化结构、语气和可读性，给出可直接使用的版本，并说明修改理由。",
    defaultToolIds: ["read_file"],
    defaultSkillIds: [],
  },
  {
    id: "pm-expert",
    name: "产品方案专家",
    description: "当任务涉及需求拆解、方案梳理、执行规划或决策比较时使用。",
    version: "1.0.0",
    author: "Omni",
    kind: "expert",
    category: "商业运营",
    icon: "LayoutTemplate",
    tags: ["planning", "decision"],
    templatePrompt:
      "你是一名产品经理。先把需求拆成目标、约束、可选方案和下一步行动，再给出推荐并说明依据。",
    defaultToolIds: ["search_sessions", "read_session"],
    defaultSkillIds: [],
  },
];

export const BUILTIN_TEMPLATE_PLUGINS: PluginManifest[] = [
  {
    id: "solution-planner",
    name: "方案梳理助手",
    description: "帮你拆解需求、整理方案并规划执行步骤。",
    version: "1.0.0",
    author: "Omni",
    kind: "template",
    category: "商业运营",
    icon: "Map",
    templatePrompt: "请帮我梳理当前问题的背景、目标、约束、可选方案和下一步执行计划。",
    defaultToolIds: ["search_sessions", "read_session"],
    defaultSkillIds: [],
  },
  {
    id: "code-debugger",
    name: "代码排查助手",
    description: "适合定位报错、梳理链路和修复方向。",
    version: "1.0.0",
    author: "Omni",
    kind: "template",
    category: "开发编程",
    icon: "Bug",
    templatePrompt:
      "请帮我定位问题根因。优先查看报错堆栈和相关代码，给出最小复现步骤和修复方案。",
    defaultToolIds: ["list_files", "read_file", "search_files", "analyze_files"],
    defaultSkillIds: [],
  },
  {
    id: "copy-polisher",
    name: "文案润色助手",
    description: "用于改写说明文档、PR 描述和提示词。",
    version: "1.0.0",
    author: "Omni",
    kind: "template",
    category: "内容创作",
    icon: "Highlighter",
    templatePrompt: "请润色下面这段文字，使其表达清晰、自然、可直接使用，并保持原意不变。",
    defaultToolIds: ["read_file"],
    defaultSkillIds: [],
  },
  {
    id: "command-helper",
    name: "效率命令助手",
    description: "快速生成常用命令、脚本和操作建议。",
    version: "1.0.0",
    author: "Omni",
    kind: "template",
    category: "开发编程",
    icon: "Terminal",
    templatePrompt: "请根据我的需求生成对应的命令或脚本，并说明每个关键参数的含义和风险。",
    defaultToolIds: ["search_sessions"],
    defaultSkillIds: [],
  },
];

export const BUILTIN_PLUGINS: PluginManifest[] = [
  ...BUILTIN_SKILL_PLUGINS,
  ...BUILTIN_TOOL_PLUGINS,
  ...BUILTIN_CONNECTOR_PLUGINS,
  ...BUILTIN_EXPERT_PLUGINS,
  ...BUILTIN_TEMPLATE_PLUGINS,
];

/** SkillHub 风格的分类，用于插件市场筛选与统计。 */
export const PLUGIN_CATEGORIES = [
  "全部",
  "Pay Skill",
  "办公效率",
  "内容创作",
  "开发编程",
  "数据分析",
  "设计多媒体",
  "AI Agent",
  "知识管理",
  "商业运营",
  "教育学习",
  "行业专业",
  "IT 运维与安全",
  "生活服务",
];
