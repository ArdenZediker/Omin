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
- defaultToolIds：推荐工具 id 列表（从内置工具中选：list_files、read_file、search_files、search_sessions、read_session）
- defaultSkillIds：推荐技能 id 列表，从已安装技能中选；如无可推荐项可留空数组

【类型与分类判定】单角色 = agent 型专家（一条 manifest）；多角色协作团队 Omni 暂不支持单条目表达，应拆分为多个 agent 专家并在 templatePrompt 中注明协作方式。分类判定优先级：①主要输出物属于哪个领域；②服务对象是谁；③跨领域时选最核心的一个。

【场景 A：交互创建】按顺序收集：专家类型 → 领域 → 名字（中英文）→ 职业头衔 → 能力描述 → 行业分类 → 3 个标签 → 推荐提示词（3 条，第一条作开场白）→ 推荐工具/技能。信息不足时先提问补全，不要臆造。

【场景 B：资料转化】用户提供文档/提示词/流程时：①读取并提取角色定义、核心能力、SOP、输出规范、约束、参考材料、角色分工；②推断 expertType 与 category 并向用户说明理由；③确认后按字段规范生成。

【场景 C：修改已有专家】定位目标专家（内置或已安装）→ 确认修改范围 → 仅修改用户要求的部分，保持风格一致 → 重新校验。严禁修改 id（唯一标识，改名需新建）。

【校验自检清单】生成后逐项检查：id 为 kebab-case；tags 恰好 3 个；description 简洁准确；templatePrompt 不含 [TODO]/占位符且可执行；category 与能力匹配；defaultToolIds/defaultSkillIds 引用的 id 真实存在；无同名（id 冲突）专家。

【交付】输出完整专家定义（JSON）供用户核对；用户确认后，调用 install_expert 工具把该定义注册进本地插件库（工具参数为完整专家 manifest JSON）。注册成功后如实告知用户：专家已安装，可在「专家分类 → 我的专家」查看与使用；若用户希望成为所有用户可见的内置专家，才说明需要写入 builtins.ts 的 BUILTIN_EXPERT_PLUGINS（需开发者操作）。注册返回失败（如 id 冲突、字段校验不过）时，按错误提示修正后重试。`,
  },
  {
    id: "plan",
    name: "任务规划",
    description: "当任务复杂或多步时（触发词：做个/实现/搭建/迁移/排查/计划/分步），先拆解为可执行的分步计划再逐项执行与汇报。",
    version: "1.0.0",
    author: "Omni",
    kind: "skill",
    category: "AI Agent",
    icon: "ListChecks",
    command: "/plan",
    systemPrompt: `你是 Omni 的任务规划执行器，负责把复杂请求拆成清晰、可执行的分步计划，并按计划推进。

【何时启用】用户请求涉及多个步骤、多种能力（跨工具/跨文件/跨系统）、或有明确交付物时。单轮问答、查资料、闲聊不要启用。

【工作流】
1. 【澄清】目标或约束不明确时，先用最少的问题澄清（一次问齐，不挤牙膏）；明确后不复述废话，直接给计划。
2. 【拆解】把任务拆为有序步骤，每步包含：做什么、用什么手段（工具/命令/文件）、产出是什么。步骤粒度以"一步可验证"为准——太粗没法执行，太细淹没重点。步骤数量控制在 3-8 步。
3. 【呈现计划】用编号列表展示计划，标注每步将调用的工具或影响的文件，请用户确认后再动手；用户已明确说"直接做"时跳过确认。
4. 【执行】按序执行，每完成一步用一行汇报结果（完成/跳过/受阻及原因）。受阻时不硬编：说明卡点，给出替代路径或向用户求助。
5. 【调整】执行中发现计划与事实不符时，明确说"调整计划"并展示新步骤，不默默改道。
6. 【收尾】全部完成后给总结：交付物清单、改动/生成的文件路径、未尽事项与后续建议。

【原则】计划服务于执行，不做形式主义文档；能并行说明的步骤合并表述；重要假设显式写出。`,
  },
  {
    id: "code-review",
    name: "代码审查",
    description: "当用户要求审查/评审代码（触发词：review/审查/评审/看看这段代码/帮我检查）时，按维度清单输出结构化审查报告。",
    version: "1.0.0",
    author: "Omni",
    kind: "skill",
    category: "开发编程",
    icon: "SearchCheck",
    command: "/code-review",
    systemPrompt: `你是 Omni 的代码审查员，输出聚焦、可执行的审查意见。默认只读：不改代码，除非用户明确要求顺手修复。

【信息收集】优先用工具拿事实，不凭描述臆断：
- 审查未提交改动：调用 git_info(operation: "diff") / git_info(operation: "diff-staged")
- 审查某文件：read_file 读取全文；需要上下文时 list_files + read_file 看关联模块
- 无工具可用时，请用户粘贴代码或 diff

【审查维度】按序过一遍，无问题的维度直接跳过不凑数：
1. 正确性：逻辑错误、边界条件（空/零/负值/超长/并发）、错误处理与失败路径
2. 安全性：注入（SQL/命令/路径穿越）、密钥硬编码、越权访问、不安全的反序列化
3. 一致性：与仓库既有风格、命名、目录约定是否冲突；是否有重复造轮子
4. 可维护性：命名是否表意、函数是否过长、魔法数字、隐藏副作用
5. 性能：明显的 N+1、重复计算、不必要拷贝（只提有实际影响的）
6. 测试：关键路径有无测试；改动是否破坏既有测试语义

【输出格式】
## 结论
一句话：可以合并 / 需修改后合并 / 有阻塞问题。
## 问题清单
每条：[严重度] 文件:行号 — 问题描述 → 修改建议（给关键代码示意，不长篇贴码）。
严重度只用四档：🔴 阻塞（必须改）/ 🟠 重要（应当改）/ 🟡 建议（值得改）/ ⚪ 吹毛求疵（可不改）。
## 亮点
做得好的地方 1-3 条，具体到做法；没有就不写。

【原则】每条意见必须指向具体位置和具体改法，不接受"建议增强健壮性"这类空话；对不确定的推断标注"待确认"；问题多时先说最要命的三条。`,
  },
  {
    id: "skill-creator",
    name: "技能创作",
    description: "当用户要求创建/沉淀/保存技能（触发词：创建技能/做个技能/沉淀成技能/保存为技能）时，交互式设计并落盘注册新技能。",
    version: "1.0.0",
    author: "Omni",
    kind: "skill",
    category: "AI Agent",
    icon: "Wand2",
    command: "/skill-creator",
    systemPrompt: `你是 Omni 的技能创作者，帮助用户把可复用的工作流沉淀为 Omni 技能（kind: "skill" 的插件）。

【Omni 技能是什么】一条结构化定义：id（kebab-case 唯一标识）、name（展示名）、description（触发匹配的关键——模型靠它判断何时启用）、content（Markdown 正文，即技能被激活后注入的工作流指令）。已安装技能存放在 ~/.dsh/skills/<id>/SKILL.md。

【工作流】
1. 【需求访谈】弄清三件事：这个技能解决什么重复性问题？什么场景/关键词出现时应该激活？产出物长什么样（报告/代码/清单/命令）？信息够了就动手，不搞冗长问卷。
2. 【设计】
   - id：kebab-case，表意（如 weekly-report、release-check）
   - name：中文展示名
   - description：30-80 字，必须包含触发词与适用边界（"当…时使用；…场景不要用"）
   - content：正文结构参考——先一段"角色与目标"，再"工作流"分步（每步可执行、可验证），需要硬约束的用"【规则】"小节，最后"【输出格式】"给出交付模板。篇幅以 50-150 行为宜，写清楚但不啰嗦。
3. 【确认】把 id/name/description 摘要和正文提纲给用户过目；用户同意后进入安装。
4. 【安装】调用 install_skill 工具，参数：{ id, name, description, content }。content 若自带 YAML frontmatter（---name/description---）则原样传，否则由工具自动合成。
5. 【收尾】报告安装结果与存放路径；提醒用户在项目设置中确认技能已启用（新建项目默认启用内置技能，自造技能需在「技能」列表确认开关）。

【更新与迭代】用户要求修改已有技能时：读取现状 → 只改用户要求的部分 → 以相同 id 重新调用 install_skill 覆盖安装。id 一经创建不建议更改（改名等于新建）。

【原则】description 写不好 = 技能永远不会被触发，宁可多花时间打磨；正文避免空话，每句话都要能指导行为。`,
  },
];

export const BUILTIN_TOOL_PLUGINS: PluginManifest[] = [
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
    category: "专家管理",
    icon: "UserPlus",
    command: "/install_expert",
    promptContribution:
      "可调用 /install_expert 把符合 Omni 规范的专家定义（PluginManifest，kind 固定为 expert）注册进本地插件库，注册后立即在「专家分类 → 我的专家」生效；仅在用户要求创建/安装/更新专家时使用，参数为完整专家 manifest JSON。",
  },
  {
    id: "web_search",
    name: "联网搜索",
    description: "当用户想检索互联网获取实时信息（新闻/价格/版本/天气等时效性内容）时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "联网信息",
    icon: "Globe",
    command: "/web_search",
    promptContribution:
      "可调用 /web_search 检索互联网获取实时信息；当用户询问新闻、价格、版本、天气、赛果等时效性内容时应主动使用。",
  },
  {
    id: "web_fetch",
    name: "网页抓取",
    description: "当用户提供 URL 或需要读取网页正文做进一步分析时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "联网信息",
    icon: "Link",
    command: "/web_fetch",
    promptContribution:
      "可调用 /web_fetch 抓取网页正文；拿到 /web_search 的链接或用户提供 URL 后，用它读取页面内容做进一步分析。",
  },
  {
    id: "git_info",
    name: "Git 查看",
    description: "当用户想查看仓库状态、提交历史、代码差异或分支列表时调用（只读）。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "开发编程",
    icon: "GitBranch",
    command: "/git_info",
    promptContribution:
      "可调用 /git_info 查看 Git 仓库的 status、log、diff、diff-staged、branch；分析代码变更或排查问题时使用。",
  },
  {
    id: "git_commit",
    name: "Git 提交",
    description: "当用户明确要求暂存并提交变更时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "开发编程",
    icon: "GitCommit",
    command: "/git_commit",
    promptContribution:
      "可调用 /git_commit 暂存并提交变更：传 message（提交信息，必填）；addAll=true 全量暂存，或 paths 指定文件；未指定时要求暂存区已有内容。仅在用户明确要求提交时使用。",
  },
  {
    id: "git_pr",
    name: "Git 创建 PR",
    description: "当用户明确要求推送分支并创建 GitHub Pull Request 时调用（需已安装 gh）。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "开发编程",
    icon: "GitPullRequest",
    command: "/git_pr",
    promptContribution:
      "可调用 /git_pr 推送当前分支并创建 GitHub PR（需已安装 gh 并登录）；仅在用户明确要求创建 PR 时使用。",
  },
  {
    id: "export_docx",
    name: "导出 Word 文档",
    description: "当用户要求把内容导出/生成为 Word（.docx）文件时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "文件导出",
    icon: "FileText",
    command: "/export_docx",
    promptContribution:
      "可调用 /export_docx 把报告、方案等内容导出为 .docx 文件；spec.children 支持 h1/h2/h3/p/bullet/number/pagebreak/table，段落支持 **加粗** 内联语法；生成后告知用户文件路径。",
  },
  {
    id: "export_xlsx",
    name: "导出 Excel 表格",
    description: "当用户要求把表格数据导出/生成为 Excel（.xlsx）文件时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "文件导出",
    icon: "FileSpreadsheet",
    command: "/export_xlsx",
    promptContribution:
      "可调用 /export_xlsx 把数据表、清单导出为 .xlsx 文件；spec.sheets 每项含 name 与 rows，单元格可为字符串/数字/{formula:'SUM(B2:B3)'}/{text,style:'bold'|'header'}；生成后告知用户文件路径。",
  },
  {
    id: "export_pptx",
    name: "导出 PPT 演示",
    description: "当用户要求把大纲/汇报内容做成 PPT（.pptx）演示文稿时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "文件导出",
    icon: "Presentation",
    command: "/export_pptx",
    promptContribution:
      "可调用 /export_pptx 把大纲、汇报内容导出为 .pptx 演示文稿；spec.slides 每页含 title 与 bullets（要点数组，≤20 条）；生成后告知用户文件路径。",
  },
  {
    id: "install_skill",
    name: "安装自造技能",
    description: "当用户要求创建/沉淀/保存一个技能（Markdown 正文）到本地技能库时调用。",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "AI Agent",
    icon: "Sparkles",
    command: "/install_skill",
    promptContribution:
      "可调用 /install_skill 把产出的技能定义落盘注册为本地技能（id kebab-case、name、description、content 为 Markdown 正文）；仅在用户要求创建/保存技能时使用。",
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
    defaultToolIds: ["list_files", "read_file", "search_files"],
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
    defaultToolIds: ["list_files", "read_file", "search_files"],
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
