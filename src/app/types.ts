export type ViewMode = "chat" | "knowledge";
export type MinimizeBehavior = "taskbar" | "compact";
export type WindowPositionMode = "center" | "remember";

export type BasicSettings = {
  autoLaunch: boolean;
  minimizeBehavior: MinimizeBehavior;
  mainWindowWidth: number;
  mainWindowHeight: number;
  mainWindowPositionMode: WindowPositionMode;
  showCompactBall: boolean;
  followCursorScreen: boolean;
  openMainShortcut: string;
  switchPreviousModelShortcut: string;
  /** 全局「默认工作空间」：未单独配置工作目录的项目/任务会话自动共用此目录 */
  defaultWorkspacePath: string;
  /** 自定义 Shell 可执行文件路径（/bash 工具）。留空时 Windows 自动探测 Git-Bash，未命中回落 cmd /C；macOS/Linux 用系统 sh */
  shellPath: string;
  /** 沙箱模式（实验）：命令在 Windows 受限 token 下执行（剥离全部特权防提权）。默认关闭；非 Windows 自动回落普通执行 */
  sandboxEnabled: boolean;
  /**
   * 子 Agent「能力强」模型（capable 档）：专家委派与显式 tier=capable 时选用。
   * 留空则回落到本轮主运行模型。对应 atomcode SubagentProvider 的 capable 层。
   */
  subAgentModel: string;
  /**
   * 子 Agent「轻量」模型（fast 档）：通用只读调研默认选用，追求低延迟低成本。
   * 留空则回落到 subAgentModel（再回落主运行模型）。对应 atomcode SubagentProvider 的 fast 层。
   */
  subAgentFastModel: string;
  /**
   * 是否允许模型把任务委派给「任意」已启用专家。
   *
   * 默认关闭 —— 专家的口径与技能/MCP 不同：技能与 MCP「安装 + 开启」即对模型直接可用，
   * 而专家代表「本项目可指派的工作角色」，只有项目显式绑定的专家（`boundExpertIds`）
   * 才允许被模型自动委派。打开此开关则放宽为任意已启用专家都可委派。
   * 注：用户在输入框手动 `@专家` 属本人显式选择，始终放行，不受本开关影响。
   */
  allowAnyExpertDelegation: boolean;
};

export type ExternalChatEntry = {
  id: string;
  title: string;
  description: string;
  group: "common" | "domestic";
  kind: "main" | "external";
  url?: string;
  icon:
    | "omni"
    | "chatgpt"
    | "claude"
    | "gemini"
    | "deepseek"
    | "copilot"
    | "poe"
    | "spark"
    | "zhipu"
    | "metaso"
    | "baichuan"
    | "qwen"
    | "yuanbao"
    | "doubao"
    | "iflytekcloud";
};

export type CompactReply = {
  question: string;
  answer: string;
  isError?: boolean;
};

export type PetThoughtStatus = "thinking" | "complete" | "error" | "cleared";

export type PetThoughtState = {
  thoughtId?: string;
  sessionId: string | null;
  sessionTitle: string;
  previewText: string;
  responseCount: number;
  status: PetThoughtStatus;
  updatedAt: number;
};
