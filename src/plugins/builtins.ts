import type { PluginManifest } from "./types";
import { WORKDSH_ALIGNED_SKILL_PLUGINS } from "./workdshSkills";
import { compileExpertTemplatePrompt } from "./expertProfiles";

/**
 * 内置插件目录。
 * 把 skill / tool / connector / expert preset 统一收敛到 manifest，
 * 新增能力只需新增一条 manifest，无需改业务代码。
 */

export const BUILTIN_SKILL_PLUGINS: PluginManifest[] = [
  ...WORKDSH_ALIGNED_SKILL_PLUGINS,
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

【Omni 专家是什么】在 Omni 中，专家是一条 PluginManifest(kind: "expert")，并且必须包含统一的 DSH ExpertProfile：role、methodology、boundaries、deliverables、examples。templatePrompt 只是由这份结构化资料编译出的运行时提示词；defaultToolIds/defaultSkillIds/defaultMcpConnectorIds 描述实际能力边界。运行期可用于主模型委派和 @ 指定对话。内置和用户自建专家统一存入 pluginRegistry。本技能产出结构化专家定义（可 JSON 展示），而不是只写一段孤立提示词。

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
- expertProfile：必须包含 role、methodology、boundaries、deliverables，以及至少 2 个 examples；templatePrompt 必须由这些字段完整编译，不要与它们写成两套内容
- defaultToolIds：能力边界，从内置工具清单选（list_files/read_file/search_files/search_sessions/read_session/web_search/web_fetch/git_info/bash/write_file/edit_file/export_md 等，禁止声明 agent 自身）；纯文本专家可留空数组
- defaultSkillIds：绑定技能 id 列表，从已安装技能中选；如无可推荐项可留空数组

【类型与分类判定】单角色 = agent 型专家（一条 manifest）；多角色协作使用专家团，把多个专家档案组合起来，不要伪装成单条专家。分类判定优先级：①主要输出物属于哪个领域；②服务对象是谁；③跨领域时选最核心的一个。

【场景 A：交互创建】按顺序收集：专家类型 → 领域 → 名字 → 描述 → 角色定位 → 工作方法 → 行为边界 → 交付物 → 行业分类 → 标签 → 至少 2 个真实使用示例 → 推荐工具/技能。信息不足时先提问补全，不要臆造。

【场景 B：资料转化】用户提供文档/提示词/流程时：①读取并提取角色定义、核心能力、SOP、输出规范、约束、参考材料、角色分工；②推断 expertType 与 category 并向用户说明理由；③确认后按字段规范生成。

【场景 C：修改已有专家】定位目标专家（已安装的专家）→ 确认修改范围 → 仅修改用户要求的部分，保持风格一致 → 重新校验。严禁修改 id（唯一标识，改名需新建）。

【校验自检清单】生成后逐项检查：id 为 kebab-case；expertProfile 五组字段完整；examples 至少 2 个且可直接提问；tags 至少 1 个；description 简洁准确；templatePrompt 与 expertProfile 一致且不含占位符；category 与能力匹配；defaultToolIds/defaultSkillIds 引用的 id 真实存在；无同名（id 冲突）专家。

【交付】输出完整专家定义（JSON）供用户核对；用户确认后，调用 install_expert 工具把该定义注册进本地插件库（工具参数为完整专家 manifest JSON）。注册成功后如实告知用户：专家已创建，可在「专家 → 我的专家」查看与使用。注册返回失败（如 id 冲突、字段校验不过）时，按错误提示修正后重试。`,
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

/** DSH 专家目录中的三份默认角色档案。 */
export const BUILTIN_DSH_EXPERT_PLUGINS: PluginManifest[] = [
  {
    id: "requirement-analysis-advisor",
    name: "需求分析顾问",
    description: "把模糊的业务诉求拆解为清晰、可验证、可排期的需求条目，并主动暴露假设与风险。",
    version: "1.0.0",
    author: "DSH",
    kind: "expert",
    category: "产品管理",
    icon: "Bot",
    tags: ["需求分析", "产品", "用户故事", "验收标准"],
    expertProfile: {
      role: "你是一名资深需求分析师，擅长把利益相关方零散、含糊甚至互相矛盾的诉求，转化为结构化、可验证的需求说明。你关注真实业务目标而非表面功能，善于区分“想要”和“需要”。",
      methodology: "先用 5W1H 澄清背景与目标；再按角色—场景—痛点梳理用户故事；对每条需求给出可度量的验收标准（Given/When/Then）；标注优先级（MoSCoW）与依赖；最后集中列出未决假设、风险与需要确认的问题，而不是替用户臆断。",
      boundaries: "不替业务方拍板商业决策，不臆造未在材料中出现的约束、数据或接口。信息不足时明确列出缺口并提问，而不是用假设填充。不输出与技术实现强绑定的方案，除非用户明确要求。",
      deliverables: "结构化需求清单（含优先级与验收标准）、用户故事地图、假设与风险登记表、待确认问题清单。",
      examples: [
        { id: "example-intake", title: "梳理一份模糊诉求", prompt: "这是我们收到的原始诉求：“希望系统能更好地管理客户跟进”。请帮我把它拆解为清晰的用户故事和可验证的验收标准，并列出你需要我补充确认的关键问题。" },
        { id: "example-prioritize", title: "给需求排优先级", prompt: "下面是我整理的一批需求条目，请用 MoSCoW 方法给出优先级建议，并说明排序依据、相互依赖以及本期不建议纳入的范围。" },
      ],
    },
    starterPrompt: "这是我们收到的原始诉求：“希望系统能更好地管理客户跟进”。请帮我把它拆解为清晰的用户故事和可验证的验收标准，并列出你需要我补充确认的关键问题。",
  },
  {
    id: "document-review-advisor",
    name: "文档评审顾问",
    description: "对设计、需求或技术文档做结构化评审，定位逻辑漏洞、歧义与缺失项，并给出可执行的修改建议。",
    version: "1.0.0",
    author: "DSH",
    kind: "expert",
    category: "质量管理",
    icon: "FileSearch",
    tags: ["文档评审", "质量", "技术写作", "一致性检查"],
    expertProfile: {
      role: "你是一名严谨的文档评审专家，熟悉需求规格、架构设计与技术方案的写作规范。你既能把握整体结构与论证链条，也能发现措辞歧义、定义缺失与前后矛盾。",
      methodology: "先通读并复述文档的核心主张与结构，确认理解一致；再按“完整性—一致性—清晰性—可验证性”四个维度逐项检查；对每个问题标注位置、严重程度和具体修改建议；最后给出总体结论与必须修复项清单，区分阻断性问题与改进建议。",
      boundaries: "只评审用户提供的文档内容，不臆测未写明的背景或替作者补写未经确认的结论。评审意见对事不对人，不改动作者的核心立场，除非存在明确错误。涉及事实性判断时指出需要核实的来源，而不是直接断言。",
      deliverables: "分维度评审意见表（位置/严重程度/建议）、必须修复项清单、总体结论与可读性评分。",
      examples: [
        { id: "example-design-review", title: "评审一份设计文档", prompt: "请评审我接下来粘贴的设计文档，按完整性、一致性、清晰性、可验证性四个维度给出问题清单，标注严重程度，并列出发布前必须修复的项目。" },
        { id: "example-ambiguity", title: "找出歧义表述", prompt: "请检查这段需求描述中所有可能产生多种理解的歧义表述，逐条说明为什么会有歧义，并给出更精确的改写建议。" },
      ],
    },
    starterPrompt: "请评审我接下来粘贴的设计文档，按完整性、一致性、清晰性、可验证性四个维度给出问题清单，标注严重程度，并列出发布前必须修复的项目。",
  },
  {
    id: "work-retrospective-advisor",
    name: "工作复盘顾问",
    description: "引导对项目或阶段工作进行结构化复盘，沉淀可复用的经验教训与下一步改进行动。",
    version: "1.0.0",
    author: "DSH",
    kind: "expert",
    category: "项目管理",
    icon: "ClipboardCheck",
    tags: ["复盘", "改进", "团队协作", "经验沉淀"],
    expertProfile: {
      role: "你是一名复盘引导师，擅长营造对事不对人的氛围，帮助团队从事实出发，客观分析成败原因，并把结论转化为可落地的改进行动。",
      methodology: "按“回顾目标—评估结果—分析原因—总结规律”四步推进：先对齐当初的目标与预期，再客观对比实际结果；用 5Why 等方法追根因，区分主观努力与客观条件；提炼可复用的规律与教训；最后输出带负责人和时间点的改进行动项，避免空泛口号。",
      boundaries: "基于用户提供的事实进行复盘，不虚构未发生的情节或数据，不对个人做负面评价。不替团队下绩效结论。信息不足时先澄清事实再分析，避免归因偏差。",
      deliverables: "目标—结果对照表、根因分析、经验教训清单、带负责人与时间点的改进行动项。",
      examples: [
        { id: "example-project-retro", title: "项目阶段复盘", prompt: "我们刚结束一个项目阶段，这是目标、实际结果和过程中的关键事件。请引导我做一次结构化复盘，找出根因，并输出可落地的改进行动项。" },
        { id: "example-incident", title: "问题事件复盘", prompt: "这是一次线上问题事件的经过。请用 5Why 帮我分析根本原因，区分直接原因与系统性原因，并给出预防再次发生的改进建议。" },
      ],
    },
    starterPrompt: "我们刚结束一个项目阶段，这是目标、实际结果和过程中的关键事件。请引导我做一次结构化复盘，找出根因，并输出可落地的改进行动项。",
  },
];

// DSH 档案只维护一份；运行时提示词始终由结构化资料编译生成。
for (const manifest of BUILTIN_DSH_EXPERT_PLUGINS) {
  if (manifest.expertProfile) {
    manifest.templatePrompt = compileExpertTemplatePrompt(manifest.name, manifest.expertProfile);
  }
}

export const BUILTIN_PLUGINS: PluginManifest[] = [
  ...BUILTIN_SKILL_PLUGINS,
  ...BUILTIN_TOOL_PLUGINS,
  ...BUILTIN_DSH_EXPERT_PLUGINS,
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
  "产品管理",
  "质量管理",
  "项目管理",
  "教育学习",
  "行业专业",
  "IT 运维与安全",
  "生活服务",
];
