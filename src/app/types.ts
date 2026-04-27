export type ViewMode = "chat" | "settings";
export type MenuOpenMode = "hover" | "click";
export type MinimizeBehavior = "taskbar" | "compact";
export type WindowPositionMode = "center" | "remember";

export type BasicSettings = {
  menuOpenMode: MenuOpenMode;
  autoLaunch: boolean;
  minimizeBehavior: MinimizeBehavior;
  mainWindowWidth: number;
  mainWindowHeight: number;
  settingsWindowWidth: number;
  settingsWindowHeight: number;
  mainWindowPositionMode: WindowPositionMode;
  showCompactBall: boolean;
  followCursorScreen: boolean;
  openMainShortcut: string;
  switchPreviousModelShortcut: string;
};

export type ExternalChatEntry = {
  id: string;
  title: string;
  description: string;
  kind: "main" | "external";
  url?: string;
};

export type CompactReply = {
  question: string;
  answer: string;
};
