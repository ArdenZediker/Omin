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
