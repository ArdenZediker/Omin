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
    title: "Search Sessions",
    description: "Search local sessions by title or content",
    promptContribution: "Call /search_sessions <keyword> to search local chat history by title or content.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword; matches session title or content" },
      },
      required: ["query"],
    },
  },
  {
    id: "read_session",
    command: "/read_session",
    title: "Read Session",
    description: "Read the context of a specified session",
    promptContribution: "Call /read_session <sessionId> to read the full context of a past session.",
    parameters: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Target session ID (obtain it via /search_sessions first)",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    id: "list_files",
    command: "/list_files",
    title: "List Files",
    description: "List workspace files/directories by glob (gitignore-aware).",
    promptContribution:
      "Call /list_files with a glob to list matching files/directories. " +
      "Supports glob wildcards like **/*.ts and src/**/test_*.rs (leave empty or pass \"*\" to list everything). " +
      "Automatically respects .gitignore and skips hidden/build artifacts. Prefer this over reading whole trees.",
    parameters: {
      type: "object",
      properties: {
        glob: { type: "string", description: "Glob pattern to filter filenames, e.g. \"**/*.ts\". Empty/omitted = list everything." },
      },
    },
  },
  {
    id: "read_file",
    command: "/read_file",
    title: "Read File",
    description: "Read file contents with optional windowing (maxChars/offsetChars/limitChars).",
    promptContribution:
      "Call /read_file <path> [maxChars=N] [offset=N] [limit=N] to read file contents. " +
      "When the result ends with a [file-meta total=N offset=A returned=B truncated=Y/N] block, " +
      "use it as the real character budget: truncated=true means more content remains — either raise " +
      "maxChars or call /read_file <path> offset=<A+B> to continue. Always tell the user the actual " +
      "X/Y coverage when the message body depends on partial content. " +
      "Path is relative to the workspace; an absolute path outside the workspace is only read after user confirmation.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to read (relative to the workspace, or absolute)." },
        maxChars: {
          type: "integer",
          description:
            "Single-call soft limit on returned characters. Default 16000, hard maximum 80000. Pass a larger value to read more in one call.",
        },
        offsetChars: {
          type: "integer",
          description: "Skip the first N characters before slicing (0-based). Default 0. Use to continue reading after a previous call returned truncated=true.",
        },
        limitChars: {
          type: "integer",
          description:
            "Cap the returned window in characters; default = min(maxChars, remaining). Pass a smaller value for a quick peek without changing maxChars.",
        },
      },
      required: ["path"],
    },
  },
  {
    id: "search_files",
    command: "/search_files",
    title: "Search Files",
    description: "Search file contents across the workspace with regex (ripgrep-powered, gitignore-aware).",
    promptContribution:
      "Call /search_files to find code/text by pattern. " +
      "pattern is a regex; set literal=true to match a plain string; ignoreCase=true for case-insensitive. " +
      "Use glob to restrict file types (e.g. \"**/*.ts\"), path to scope a subdir, context for N lines before/after. " +
      "Results are snippets only — call /read_file to read the full file or a line range.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search in file contents (required)." },
        path: { type: "string", description: "Optional subdir (relative to workspace root) to scope the search." },
        glob: { type: "string", description: "Optional glob to filter which files are searched, e.g. \"**/*.ts\"." },
        literal: { type: "boolean", description: "true = treat pattern as a literal string (no regex). Default false." },
        ignoreCase: { type: "boolean", description: "true = case-insensitive match. Default false." },
        context: { type: "integer", description: "Number of context lines to include before/after each match. Default 0, max 20." },
        limit: { type: "integer", description: "Max number of matches to return. Default 50, max 200." },
      },
      required: ["pattern"],
    },
  },
  {
    id: "read_persona",
    command: "/read_persona",
    title: "Read Persona",
    description:
      "Read the local persona markdown file; fields: userName / assistantName / personaDescription / customInstruction / longTermMemory / agentsMd / style",
    promptContribution:
      "Call /read_persona <field> to read the local persona profile (user name, assistant name, persona, custom instructions, long-term memory, AGENTS.md, style) so responses fit the user's preferences.",
    parameters: {
      type: "object",
      properties: {
        field: {
          type: "string",
          description:
            "Profile field name: style / userName / assistantName / personaDescription / customInstruction / longTermMemory / agentsMd",
        },
      },
      required: ["field"],
    },
  },
  {
    id: "update_persona",
    command: "/update_persona",
    title: "Update Persona",
    description:
      "Write a long-term preference, name, or persona into the corresponding persona markdown file (same fields as above). Usage: /update_persona <field> <content>",
    promptContribution:
      "Call /update_persona <field> <content> to persist stable preferences, names, or persona into the corresponding persona markdown file (including AGENTS.md). Usage: /update_persona <field> <content>.",
  },
  {
    id: "install_expert",
    command: "/install_expert",
    title: "Install Expert",
    description:
      "Register an Omni-compliant expert definition (a PluginManifest with kind 'expert') into the local plugin library; afterwards it appears under 'Expert Categories → My Experts'.",
    promptContribution:
      "Call /install_expert to register an Omni-compliant expert definition (PluginManifest with kind fixed to 'expert') into the local plugin library; it takes effect immediately under 'Expert Categories → My Experts'. Only use when the user asks to create/install/update an expert; pass the full expert manifest as JSON.",
    parameters: {
      type: "object",
      properties: {
        manifest: {
          type: "object",
          description:
            "Omni-compliant expert PluginManifest: id (kebab-case unique id), name (display name), description (one-line description), version, kind (fixed 'expert'), category (industry), icon (lucide icon name), tags (3 domain tags), templatePrompt (expert system prompt, runnable, no placeholders), defaultToolIds (recommended tool ids), defaultSkillIds (recommended skill ids)",
        },
      },
      required: ["manifest"],
    },
  },
  {
    id: "web_search",
    command: "/web_search",
    title: "Web Search",
    description: "Search the web via DuckDuckGo; returns titles, links, and snippets",
    promptContribution:
      "Call /web_search to fetch real-time information from the web; proactively use it when the user asks about news, prices, versions, weather, match results, or other time-sensitive topics.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (Chinese or English supported)" },
        limit: { type: "number", description: "Number of results (1-15, default 8)" },
      },
      required: ["query"],
    },
  },
  {
    id: "web_fetch",
    command: "/web_fetch",
    title: "Web Fetch",
    description: "Fetch the main text of a URL (converted to plain text) with a list of key links",
    promptContribution:
      "Call /web_fetch to retrieve page content; after getting links from /web_search or from the user, use it to read the page for further analysis.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full http/https URL" },
        max_chars: { type: "number", description: "Max characters of returned text (default 12000, max 50000)" },
      },
      required: ["url"],
    },
  },
  {
    id: "git_info",
    command: "/git_info",
    title: "Git Info",
    description: "Inspect a Git repo's status / commit history / diff / branches (read-only)",
    promptContribution:
      "Call /git_info to view a Git repo's status, log, diff, diff-staged, and branch; use it when analyzing changes or debugging.",
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description: "Operation: status / log / diff / diff-staged / branch",
          enum: ["status", "log", "diff", "diff-staged", "branch"],
        },
        path: { type: "string", description: "Repo path; defaults to the current project workspace" },
        limit: { type: "number", description: "Max log entries (1-50, default 20)" },
      },
      required: ["operation"],
    },
  },
  {
    id: "git_commit",
    command: "/git_commit",
    title: "Git Commit",
    description: "Stage changes and create a Git commit",
    promptContribution:
      "Call /git_commit to stage and commit changes: pass message (commit message, required); addAll=true stages everything, or paths lists specific files; if neither, expect the staging area to already have content. Only use when the user explicitly asks to commit.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "Commit message (required)" },
        path: { type: "string", description: "Repo path; defaults to the current project workspace" },
        add_all: { type: "boolean", description: "When true, equivalent to git add -A" },
        paths: {
          type: "array",
          description: "List of file paths to stage",
          items: { type: "string" },
        },
      },
      required: ["message"],
    },
  },
  {
    id: "git_pr",
    command: "/git_pr",
    title: "Git PR",
    description: "Push the current branch and create a Pull Request via GitHub CLI",
    promptContribution:
      "Call /git_pr to push the current branch and open a GitHub PR (requires gh installed and authenticated); only use when the user explicitly asks to create a PR.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "PR title (required)" },
        body: { type: "string", description: "PR description (Markdown)" },
        base: { type: "string", description: "Base branch; defaults to the repo's default branch" },
        path: { type: "string", description: "Repo path; defaults to the current project workspace" },
      },
      required: ["title"],
    },
  },
  {
    id: "export_docx",
    command: "/export_docx",
    title: "Export Word",
    description:
      "Export structured content into a real .docx file (headings / paragraphs / bold / lists / tables / page breaks)",
    promptContribution:
      "Call /export_docx to export reports, plans, etc. into a .docx file. spec.children supports h1/h2/h3/p/bullet/number/pagebreak/table; paragraphs support **bold** inline syntax. path is optional: when omitted, it auto-saves to the project directory for a project session, otherwise to the Omni folder in the system Documents directory (a bare filename also works). If path is given it MUST be a real absolute local path (e.g. C:/Users/<user>/Documents/report.docx); never invent virtual paths like sandbox:/. In a project session, an absolute path outside the workspace only executes after user confirmation. Tell the user the file path when done.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Output file path (optional): when omitted or a bare filename, auto-saves to the default directory (project session → project dir; otherwise → system Documents/Omni), filename derived from the title; a full path MUST be a real absolute local path (e.g. C:/Users/<user>/Documents/report.docx); virtual paths like sandbox:/ are forbidden",
        },
        spec: {
          type: "object",
          description:
            "Document structure: { title?, children: [{type:'h1'|'h2'|'h3'|'p'|'bullet'|'number'|'pagebreak', text, align?}, {type:'table', rows:[[cell]], header?}] }",
        },
        overwrite: { type: "boolean", description: "Overwrite if the file exists (default false)" },
      },
      required: ["spec"],
    },
  },
  {
    id: "export_xlsx",
    command: "/export_xlsx",
    title: "Export Excel",
    description:
      "Export tabular data into a real .xlsx file (multiple sheets / numbers / formulas / header styling)",
    promptContribution:
      "Call /export_xlsx to export data tables or lists into an .xlsx file. Each item in spec.sheets has name and rows; a cell can be a string / number / {formula:'SUM(B2:B3)'} / {text,style:'bold'|'header'}. path is optional: when omitted, auto-saves to the project directory for a project session, otherwise to the Omni folder in system Documents (a bare filename also works). If path is given it MUST be a real absolute local path (e.g. C:/Users/<user>/Documents/data.xlsx); never invent virtual paths like sandbox:/. In a project session, an absolute path outside the workspace only executes after user confirmation. Tell the user the file path when done.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Output file path (optional): when omitted or a bare filename, auto-saves to the default directory (project session → project dir; otherwise → system Documents/Omni), filename from the first sheet name or title; a full path MUST be a real absolute local path (e.g. C:/Users/<user>/Documents/data.xlsx); virtual paths like sandbox:/ are forbidden",
        },
        spec: {
          type: "object",
          description:
            "Table structure: { sheets: [{ name, rows: [[string|number|{formula}|{text,style:'bold'|'header'}]] }] }",
        },
        overwrite: { type: "boolean", description: "Overwrite if the file exists (default false)" },
      },
      required: ["spec"],
    },
  },
  {
    id: "export_pptx",
    command: "/export_pptx",
    title: "Export PPT",
    description: "Export an outline into a real .pptx presentation (16:9, title + bullet slides)",
    promptContribution:
      "Call /export_pptx to export outlines or reports into a .pptx presentation. Each item in spec.slides has title and bullets (array of points, ≤20). path is optional: when omitted, auto-saves to the project directory for a project session, otherwise to the Omni folder in system Documents (a bare filename also works). If path is given it MUST be a real absolute local path (e.g. C:/Users/<user>/Documents/report.pptx); never invent virtual paths like sandbox:/. In a project session, an absolute path outside the workspace only executes after user confirmation. Tell the user the file path when done.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Output file path (optional): when omitted or a bare filename, auto-saves to the default directory (project session → project dir; otherwise → system Documents/Omni), filename from the title; a full path MUST be a real absolute local path (e.g. C:/Users/<user>/Documents/report.pptx); virtual paths like sandbox:/ are forbidden",
        },
        spec: {
          type: "object",
          description: "Presentation structure: { slides: [{ title, bullets: [string] }] }",
        },
        overwrite: { type: "boolean", description: "Overwrite if the file exists (default false)" },
      },
      required: ["spec"],
    },
  },
  {
    id: "export_md",
    command: "/export_md",
    title: "Export Markdown",
    description:
      "Export Markdown content directly into a .md file (keeps the original text, not rendered to Office formats)",
    promptContribution:
      "Call /export_md to export articles, notes, docs, or READMEs as raw Markdown into a .md file. content is the full Markdown text (may include headings/lists/tables/code blocks). path is optional: auto-saves to the project directory or system Documents/Omni, filename from title or the first line of content. Tell the user the file path when done. In a project session, an absolute path outside the workspace only executes after user confirmation.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Output file path (optional): when omitted or a bare filename, auto-saves to the default directory (project session → project dir; otherwise → system Documents/Omni), filename from the title or first line of content; a full path MUST be a real absolute local path (e.g. C:/Users/<user>/Documents/doc.md); virtual paths like sandbox:/ are forbidden",
        },
        content: { type: "string", description: "Full Markdown content to write to the file" },
        title: { type: "string", description: "Optional; used as the default filename (without extension)" },
        overwrite: { type: "boolean", description: "Overwrite if the file exists (default false)" },
      },
      required: ["content"],
    },
  },
  {
    id: "install_skill",
    command: "/install_skill",
    title: "Install Skill",
    description:
      "Write a skill definition (Markdown body, optional frontmatter) into the local skill library and register it as enabled",
    promptContribution:
      "Call /install_skill to persist a produced skill definition as a local skill (id kebab-case, name, description, content as Markdown body). Only use when the user asks to create/save a skill.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Unique skill id (kebab-case, e.g. weekly-report)" },
        name: { type: "string", description: "Skill display name" },
        description: { type: "string", description: "One-line description (used for trigger matching)" },
        content: { type: "string", description: "Skill body (Markdown; may include --- frontmatter)" },
        tags: { type: "array", description: "Tags", items: { type: "string" } },
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
    "export_md",
    "install_skill",
  ].includes(tool.id)
);

export const PROJECT_TOOL_OPTIONS = PROJECT_TOOL_MANIFESTS.map((tool) => ({
  id: tool.id,
  label: tool.title,
  description: tool.description,
}));

/** 内置工具：所有模型/会话的公用工具，无条件可用（不受项目 allowedToolIds 限制）。 */
export const BUILTIN_TOOL_IDS = [
  "search_sessions",
  "read_session",
  "list_files",
  "read_file",
  "search_files",
  "read_persona",
  "update_persona",
  "install_expert",
  "install_skill",
  "web_search",
  "web_fetch",
  "git_info",
  "git_commit",
  "git_pr",
  "export_docx",
  "export_xlsx",
  "export_pptx",
  "export_md",
];

export const ALWAYS_ALLOWED_LOCAL_TOOL_IDS = [...BUILTIN_TOOL_IDS];

export function getToolManifestById(id: string) {
  return TOOL_MANIFESTS.find((tool) => tool.id === id) ?? null;
}
