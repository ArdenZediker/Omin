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
