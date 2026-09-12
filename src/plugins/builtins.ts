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

【Omni 专家是什么】在 Omni 中，专家是一条 PluginManifest(kind: "expert")，定位是「子 Agent 的配置档案」：templatePrompt 是角色提示词，defaultToolIds/defaultSkillIds 决定其能力边界。运行期两种生效方式：①主模型通过 agent 工具委派子任务（按档案驱动子 Agent）；②用户 @ 指定切换主对话角色。内置专家定义在 src/plugins/builtins.ts 的 BUILTIN_EXPERT_PLUGINS，安装的专家由 pluginRegistry 存入本地存储。本技能产出结构化的专家定义（可 JSON 展示），而不是 WorkBuddy 式 plugin.json + agents/*.md + marketplace.json 文件包。提示：用户也可以不经过对话，直接在「扩展中心 → 专家 → 创建专家」用表单创建。

【字段规范】生成专家时必须严格遵循以下字段：
- id：kebab-case 唯一标识（如 dev-expert），创建后不可改
- name：展示名/职业头衔，中文为主（如 "编程专家"）
- description：一句话描述，30-60 字，面向「委派匹配」撰写——突出核心能力与适用子任务类型（主模型据此决定派谁）
- version：如 "1.0.0"
- author：作者（"Omni" 或用户名）
- kind：固定 "expert"，不可改
- category：行业分类，从 Omni 分类中选择（开发编程/内容创作/数据分析/知识管理/商业运营/设计多媒体/AI Agent/教育学习/行业专业 等），须与专家核心能力匹配并说明理由
- icon：lucide 图标名（如 Code2、PenTool、Bot、BarChart3、Store）
- tags：擅长领域标签，固定 3 个（中英文均可）
- templatePrompt：可直接执行的角色定义，写明角色定位 + 工作方式 + 输出偏好，不含占位符；子 Agent 运行规则由系统运行时统一追加，此处不要重复
- defaultToolIds：能力边界，从内置工具清单选（list_files/read_file/search_files/search_sessions/read_session/web_search/web_fetch/git_info/bash/write_file/edit_file/export_md 等，禁止声明 agent 自身）；纯文本专家可留空数组
- defaultSkillIds：绑定技能 id 列表，从已安装技能中选；如无可推荐项可留空数组

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
4. 【执行】开工前先用 /todo_write 把计划登记成任务清单（一步一条，初始状态均为 pending），再按序执行：开始某步时把该条置为 in_progress，完成后立刻置为 completed，同时用一行汇报结果（完成/跳过/受阻及原因）。受阻时不硬编：说明卡点，给出替代路径或向用户求助。
5. 【调整】执行中发现计划与事实不符时，先更新 /todo_write 的清单再继续（新增/改状态/删步骤），并明确说"调整计划"展示新步骤，不默默改道。
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
    name: "Search Sessions",
    description: "Call this when the user wants to search local chat history by title or content.",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "知识管理",
    group: "会话",
    icon: "Search",
    command: "/search_sessions",
    promptContribution: "Call /search_sessions <keyword> to search local chat history by title or content.",
  },
  {
    id: "read_session",
    name: "Read Session",
    description: "Call this when the user wants to read the context of a specified session.",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "知识管理",
    group: "会话",
    icon: "MessageSquare",
    command: "/read_session",
    promptContribution: "Call /read_session <sessionId> to read the full context of a past session.",
  },
  {
    id: "list_files",
    name: "List Files",
    description: "Call this when the user wants to browse the current workspace's file and directory structure by glob.",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "开发编程",
    group: "文件",
    icon: "FolderTree",
    command: "/list_files",
    promptContribution:
      "Call /list_files with a glob to list matching files/directories (e.g. \"**/*.ts\"). " +
      "Respects .gitignore automatically. Prefer this over reading whole trees.",
  },
  {
    id: "read_file",
    name: "Read File",
    description:
      "Read file contents with optional windowing (maxChars/offsetChars/limitChars). Output lines are prefixed with line numbers. When the result ends with a [file-meta total=N offset=A returned=B lines=S-E truncated=Y/N] block, treat it as the real character budget.",
    version: "1.1.0",
    author: "Omni",
    kind: "tool",
    category: "开发编程",
    group: "文件",
    icon: "FileText",
    command: "/read_file",
    promptContribution:
      "Call /read_file <path> [maxChars=N] [offset=N] [limit=N] to read file contents. " +
      "Output lines are prefixed as \"N | text\"; N matches /search_files line_number, so you can cite exact lines. " +
      "When the result ends with a [file-meta total=N offset=A returned=B lines=S-E truncated=Y/N] block, " +
      "use it as the real character budget: truncated=true means more content remains — either raise " +
      "maxChars or call /read_file <path> offset=<A+B> to continue. Always tell the user the actual " +
      "X/Y coverage when the message body depends on partial content. " +
      "In a project session, an absolute path outside the workspace is only read after user confirmation.",
  },
  {
    id: "search_files",
    name: "Search Files",
    description: "Call this when the user wants to search workspace file contents by regex (ripgrep-powered).",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "开发编程",
    group: "文件",
    icon: "FileSearch",
    command: "/search_files",
    promptContribution:
      "Call /search_files with a regex pattern to find code/text. literal=true for plain string, " +
      "ignoreCase=true for case-insensitive, glob to filter file types, context for surrounding lines. " +
      "Returns snippets only — use /read_file for the full file.",
  },
  {
    id: "read_persona",
    name: "Read Persona",
    description:
      "Call this when the user wants to read the local persona markdown file (userName / assistantName / personaDescription / customInstruction / longTermMemory / agentsMd / style).",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "记忆",
    group: "档案",
    icon: "UserCircle",
    command: "/read_persona",
    promptContribution:
      "Call /read_persona <field> to read the local persona profile (user name, assistant name, persona, custom instructions, long-term memory, AGENTS.md, style) so responses fit the user's preferences.",
  },
  {
    id: "update_persona",
    name: "Update Persona",
    description:
      "Call this when the user wants to write stable preferences, names, or persona into the corresponding persona markdown file.",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "记忆",
    group: "档案",
    icon: "UserCog",
    command: "/update_persona",
    promptContribution:
      "Call /update_persona <field> <content> to persist stable preferences, names, or persona into the corresponding persona markdown file (including AGENTS.md). Usage: /update_persona <field> <content>.",
  },
  {
    id: "install_expert",
    name: "Install Expert",
    description:
      "Call this when the user asks to register an Omni-compliant expert definition (a PluginManifest with kind 'expert') into the local plugin library.",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "专家管理",
    group: "插件安装",
    icon: "UserPlus",
    command: "/install_expert",
    promptContribution:
      "Call /install_expert to register an Omni-compliant expert definition (PluginManifest with kind fixed to 'expert') into the local plugin library; it takes effect immediately under 'Expert Categories → My Experts'. Only use when the user asks to create/install/update an expert; pass the full expert manifest as JSON.",
  },
  {
    id: "web_search",
    name: "Web Search",
    description:
      "Call this when the user wants to fetch real-time web information (news / prices / versions / weather, etc.).",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "联网信息",
    group: "联网",
    icon: "Globe",
    command: "/web_search",
    promptContribution:
      "Call /web_search to fetch real-time information from the web; proactively use it when the user asks about news, prices, versions, weather, match results, or other time-sensitive topics.",
  },
  {
    id: "web_fetch",
    name: "Web Fetch",
    description: "Call this when the user provides a URL or needs to read page content for further analysis.",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "联网信息",
    group: "联网",
    icon: "Link",
    command: "/web_fetch",
    promptContribution:
      "Call /web_fetch to retrieve page content; after getting links from /web_search or from the user, use it to read the page for further analysis.",
  },
  {
    id: "git_info",
    name: "Git Info",
    description: "Call this when the user wants to view repo status, commit history, diffs, or branches (read-only).",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "开发编程",
    group: "Git",
    icon: "GitBranch",
    command: "/git_info",
    promptContribution:
      "Call /git_info to view a Git repo's status, log, diff, diff-staged, and branch; use it when analyzing changes or debugging.",
  },
  {
    id: "git_commit",
    name: "Git Commit",
    description: "Call this when the user explicitly asks to stage and commit changes.",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "开发编程",
    group: "Git",
    icon: "GitCommit",
    command: "/git_commit",
    promptContribution:
      "Call /git_commit to stage and commit changes: pass message (commit message, required); addAll=true stages everything, or paths lists specific files; if neither, expect the staging area to already have content. Only use when the user explicitly asks to commit.",
  },
  {
    id: "git_pr",
    name: "Git PR",
    description:
      "Call this when the user explicitly asks to push the branch and create a GitHub Pull Request (requires gh installed).",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "开发编程",
    group: "Git",
    icon: "GitPullRequest",
    command: "/git_pr",
    promptContribution:
      "Call /git_pr to push the current branch and open a GitHub PR (requires gh installed and authenticated); only use when the user explicitly asks to create a PR.",
  },
  {
    id: "export_docx",
    name: "Export Word",
    description: "Call this when the user asks to export/generate content into a Word (.docx) file.",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "文件导出",
    group: "导出",
    icon: "FileText",
    command: "/export_docx",
    promptContribution:
      "Call /export_docx to export reports, plans, etc. into a .docx file. spec.children supports h1/h2/h3/p/bullet/number/pagebreak/table; paragraphs support **bold** inline syntax. path is optional: when omitted, it auto-saves to the project directory or the Omni folder in system Documents. Tell the user the file path when done. In a project session, an absolute path outside the workspace only executes after user confirmation.",
  },
  {
    id: "export_xlsx",
    name: "Export Excel",
    description: "Call this when the user asks to export/generate tabular data into an Excel (.xlsx) file.",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "文件导出",
    group: "导出",
    icon: "FileSpreadsheet",
    command: "/export_xlsx",
    promptContribution:
      "Call /export_xlsx to export data tables or lists into an .xlsx file. Each item in spec.sheets has name and rows; a cell can be a string / number / {formula:'SUM(B2:B3)'} / {text,style:'bold'|'header'}. path is optional: when omitted, it auto-saves to the project directory or the Omni folder in system Documents. Tell the user the file path when done. In a project session, an absolute path outside the workspace only executes after user confirmation.",
  },
  {
    id: "export_pptx",
    name: "Export PPT",
    description: "Call this when the user asks to turn an outline/report into a PPT (.pptx) presentation.",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "文件导出",
    group: "导出",
    icon: "Presentation",
    command: "/export_pptx",
    promptContribution:
      "Call /export_pptx to export outlines or reports into a .pptx presentation. Each item in spec.slides has title and bullets (array of points, ≤20). path is optional: when omitted, it auto-saves to the project directory or the Omni folder in system Documents. Tell the user the file path when done. In a project session, an absolute path outside the workspace only executes after user confirmation.",
  },
  {
    id: "export_md",
    name: "Export Markdown",
    description:
      "Call this when the user asks to export articles / notes / docs / READMEs as raw Markdown into a .md file.",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "文件导出",
    group: "导出",
    icon: "FileText",
    command: "/export_md",
    promptContribution:
      "Call /export_md to export articles, notes, docs, or READMEs as raw Markdown into a .md file. content is the full Markdown text, path is optional: auto-saves to the project directory or system Documents/Omni. Tell the user the file path when done. In a project session, an absolute path outside the workspace only executes after user confirmation.",
  },
  {
    id: "write_file",
    name: "Write File",
    description:
      "Call this to create a new text/code file or overwrite an existing one inside the project workspace (diff-tracked, revertible).",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "代码工作台",
    group: "文件修改",
    icon: "FilePen",
    command: "/write_file",
    promptContribution:
      "Call /write_file to create a new file or fully overwrite an existing one: JSON{path, content, overwrite?}. " +
      "Prefer /edit_file for targeted changes to existing files. Writes inside the workspace apply directly; paths outside require user confirmation.",
  },
  {
    id: "edit_file",
    name: "Edit File",
    description:
      "Call this to apply a targeted exact-match search-and-replace to an existing text file (diff-tracked, revertible).",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "代码工作台",
    group: "文件修改",
    icon: "Pencil",
    command: "/edit_file",
    promptContribution:
      "Call /edit_file for precise in-place edits: JSON{path, find, replace, replace_all?}. " +
      "find must be copied verbatim from the file (exact whitespace); 0 or ambiguous matches are rejected with no changes. Read the file first.",
  },
  {
    id: "install_skill",
    name: "Install Skill",
    description:
      "Call this when the user asks to create/store/save a skill (Markdown body) into the local skill library.",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "AI Agent",
    group: "插件安装",
    icon: "Sparkles",
    command: "/install_skill",
    promptContribution:
      "Call /install_skill to persist a produced skill definition as a local skill (id kebab-case, name, description, content as Markdown body). Only use when the user asks to create/save a skill.",
  },
  {
    id: "todo_write",
    name: "Todo Write",
    description:
      "Call this to track progress on a multi-step task with a session-scoped checklist (pending / in_progress / completed).",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "AI Agent",
    group: "计划",
    icon: "ListChecks",
    command: "/todo_write",
    promptContribution:
      "Call /todo_write to track progress on multi-step work. Send the full list each call (it replaces the previous one), " +
      "keep at most one item in_progress, and flip items to completed as soon as they are done. " +
      "It tracks execution progress only — to design the plan itself use the /plan skill.",
  },
  {
    id: "code_outline",
    name: "Code Outline",
    description:
      "Call this to see a file's declarations (classes / functions / methods) with line numbers before reading it in full.",
    version: "1.0.0",
    author: "Omni",
    kind: "tool",
    category: "开发编程",
    group: "文件",
    icon: "ListTree",
    command: "/code_outline",
    promptContribution:
      "Call /code_outline <path> to skim a large or unfamiliar file's structure before reading it. " +
      "Heuristic only (no symbol index) — use /search_files to find where a symbol is used.",
  },
];

/**
 * 内置专家 = 子 Agent 档案（新模型，2026-09-08 定稿）：
 * description 面向「委派匹配」撰写（主模型据此决定派谁）；
 * templatePrompt 为可直接执行的角色定义（角色定位 + 工作方式 + 输出偏好，
 * 子 Agent 运行规则由 subAgent.ts 运行时统一追加，此处不重复）；
 * defaultToolIds/defaultSkillIds 决定该专家被委派或 @ 指定时的能力边界。
 */
export const BUILTIN_EXPERT_PLUGINS: PluginManifest[] = [
  {
    id: "dev-expert",
    name: "编程专家",
    description:
      "代码类子任务首选：读代码定位问题、审查改动、评估技术方案、产出可运行的修复代码或排查报告。",
    version: "2.0.0",
    author: "Omni",
    kind: "expert",
    category: "开发编程",
    icon: "Code2",
    tags: ["coding", "review", "architecture"],
    templatePrompt: [
      "你是资深软件工程师（主攻 TypeScript/React 前端与 Rust 后端）。",
      "",
      "工作方式：",
      "- 先查证再下结论：用工具读取代码、搜索历史会话，结论必须附「文件路径+行号」证据，不凭空猜测。",
      "- 定位问题按根因链展开：现象 → 直接原因 → 根本原因 → 修复方案，一次讲透。",
      "- 给出的代码必须完整可运行，标明改动文件与插入位置；无法确定的部分列出明确验证步骤。",
      "- 输出紧凑：结论先行、方案分点，不写与任务无关的铺垫和寒暄。",
    ].join("\n"),
    defaultToolIds: ["list_files", "read_file", "search_files", "git_info", "search_sessions"],
    defaultSkillIds: [],
  },
  {
    id: "writer-expert",
    name: "写作专家",
    description:
      "文稿产出与润色类子任务首选：说明文档、公告、PR 描述、提示词优化，交付可直接使用的成稿。",
    version: "2.0.0",
    author: "Omni",
    kind: "expert",
    category: "内容创作",
    icon: "PenTool",
    tags: ["writing", "polish", "docs"],
    templatePrompt: [
      "你是专业文字编辑与撰稿人。",
      "",
      "工作方式：",
      "- 动笔前先确认文体与受众：说明文、公告、PR 描述、提示词各有固定结构，按文体套对应框架。",
      "- 润色保持原意不变：优化结构、语气与可读性，直接给出可使用的成稿版本，重要改动逐条说明理由。",
      "- 涉及事实与数据时先用工具查证（读文件、搜历史会话），不编造数字与引用。",
      "- 交付格式：直接给成稿 + 简短修改说明；长文先给大纲确认结构再展开正文。",
    ].join("\n"),
    defaultToolIds: ["read_file", "search_files", "search_sessions", "read_session"],
    defaultSkillIds: [],
  },
  {
    id: "pm-expert",
    name: "产品方案专家",
    description:
      "需求拆解与决策类子任务首选：方案比较、执行规划、风险评估，交付结论明确的建议书。",
    version: "2.0.0",
    author: "Omni",
    kind: "expert",
    category: "商业运营",
    icon: "LayoutTemplate",
    tags: ["planning", "decision", "prd"],
    templatePrompt: [
      "你是资深产品经理，擅长把模糊诉求变成可执行方案。",
      "",
      "工作方式：",
      "- 结构化拆解：目标 → 约束 → 可选方案（至少 2 个）→ 对比维度（成本/风险/收益）→ 推荐与依据。",
      "- 主动用会话检索工具查找相关背景与既有决策，避免重复讨论或与历史结论冲突。",
      "- 结论先行：先给推荐项，再展开对比分析；信息不足处明确标注所做假设。",
      "- 每个方案附下一步行动清单（做什么 / 验收标准），不输出空泛的正确的废话。",
    ].join("\n"),
    defaultToolIds: ["search_sessions", "read_session", "read_file", "web_search"],
    defaultSkillIds: [],
  },
];

/**
 * 内置项目预设（`kind:"template"`）。
 *
 * 定位是**新建项目时的起点**，不是「可安装的插件」、也不是「角色」——所以：
 * - `instruction` 写进 `project.systemPrompt`（持久项目指令，每轮都生效）；
 * - `starterPrompt` 是点「插入输入框」时放进草稿的**起手一句**（一次性）。
 *   两者曾经挤在 `templatePrompt` 一个字段里，结果一句「请帮我梳理…」的用户问句
 *   被当成持久项目系统指令写进了项目，语义是反的。
 * - **不声明 `defaultToolIds`**：它们只会是空操作。这里原本给每条预设列了
 *   `list_files/read_file/search_files` 之类的工具，但这些都是 `BUILTIN_TOOL_IDS`
 *   ——内置工具**无条件可用、不受项目 allowedToolIds 限制**（见 `config/manifests/tools.ts`），
 *   所以既没人读（`CreateProjectDialog` 只把 selectedTemplateId 写进指令），
 *   真接上也不产生任何约束。要表达「能力边界」得用别的机制，别在这里留假数据。
 */
export const BUILTIN_TEMPLATE_PLUGINS: PluginManifest[] = [
  {
    id: "solution-planner",
    name: "方案梳理",
    description: "以方案梳理起手：拆解目标与约束，给出可选方案与对比维度。",
    version: "2.0.0",
    author: "Omni",
    kind: "template",
    category: "商业运营",
    icon: "Map",
    tags: ["planning", "decision", "steps"],
    instruction: [
      "本项目以方案梳理为主。",
      "收到需求后先拆解背景、目标与约束，再给出至少两个可选方案及其对比维度（成本 / 风险 / 收益），",
      "最后附下一步执行清单（做什么 / 验收标准）。结论先行，信息不足处明确标注所做假设，不写空泛的正确的废话。",
    ].join(""),
    starterPrompt: "请帮我梳理当前问题的背景、目标、约束、可选方案和下一步执行计划。",
  },
  {
    id: "code-debugger",
    name: "代码排查",
    description: "以排查起手：从报错与堆栈定位根因，给出最小复现与修复方案。",
    version: "2.0.0",
    author: "Omni",
    kind: "template",
    category: "开发编程",
    icon: "Bug",
    tags: ["debug", "rootcause", "repro"],
    instruction: [
      "本项目以代码排查为主。",
      "先查证再下结论：结论必须附「文件路径 + 行号」证据，不凭空猜测；",
      "按 现象 → 直接原因 → 根本原因 → 修复方案 的顺序讲透，一次讲完；",
      "给出的代码要完整可运行，标明改动文件与插入位置，无法确定的部分列出明确的验证步骤。",
    ].join(""),
    starterPrompt: "请帮我定位问题根因。优先查看报错堆栈和相关代码，给出最小复现步骤和修复方案。",
  },
  {
    id: "copy-polisher",
    name: "文案润色",
    description: "以改稿起手：保持原意，优化结构与语气，交付可直接使用的成稿。",
    version: "2.0.0",
    author: "Omni",
    kind: "template",
    category: "内容创作",
    icon: "Highlighter",
    tags: ["writing", "polish", "docs"],
    instruction: [
      "本项目以文稿润色与撰写为主。",
      "改写必须保持原意不变，只优化结构、语气与可读性，直接交付可使用的成稿，并逐条说明重要改动的理由；",
      "动笔前先确认文体与受众，涉及事实与数据时先查证，不编造数字与引用。",
    ].join(""),
    starterPrompt: "请润色下面这段文字，使其表达清晰、自然、可直接使用，并保持原意不变。",
  },
  {
    id: "command-helper",
    name: "命令与脚本",
    description: "以命令起手：生成可执行的命令或脚本，说明关键参数与风险。",
    version: "2.0.0",
    author: "Omni",
    kind: "template",
    category: "开发编程",
    icon: "Terminal",
    tags: ["shell", "script", "risk"],
    instruction: [
      "本项目以命令与脚本产出为主。",
      "给出的命令必须可直接执行，逐项说明关键参数的含义与风险；",
      "涉及删除、覆盖、递归等破坏性操作时，先提示风险并给出确认步骤，不要默认用户已授权。",
    ].join(""),
    starterPrompt: "请根据我的需求生成对应的命令或脚本，并说明每个关键参数的含义和风险。",
  },
];

export const BUILTIN_PLUGINS: PluginManifest[] = [
  ...BUILTIN_SKILL_PLUGINS,
  ...BUILTIN_TOOL_PLUGINS,
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
