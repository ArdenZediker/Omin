import type { BasicSettings, ExternalChatEntry } from "./types";
import type { CharacterModel, CompactAppearance } from "../hooks/useCompactWindowState";

export const MAIN_WINDOW_LABEL = "main";
export const COMPACT_WINDOW_LABEL = "compact";
export const EXPANDED_SIZE = { width: 920, height: 820 };
export const SETTINGS_SIZE = EXPANDED_SIZE;
export const BASIC_SETTINGS_STORAGE_KEY = "omni_basic_settings";
export const COMPACT_POSITION_STORAGE_KEY = "omni_compact_position";
export const MAIN_POSITION_STORAGE_KEY = "omni_main_position";
export const MAIN_VIEW_STORAGE_KEY = "omni_main_view";
export const CURRENT_MODEL_STORAGE_KEY = "omni_current_model";
export const THEME_MODE_STORAGE_KEY = "omni_theme_mode";
export const CHARACTER_SCALE_BASELINE = 2;
export const COMPACT_MENU_CLOSE_DELAY_MS = 160;
export const COMPACT_MENU_PANEL_WIDTH = 360;
export const COMPACT_MENU_PANEL_HEIGHT = 228;
export const UNSET_SHORTCUT = "未设置";
export const omniIconSrc = "/omni-mark.svg";
export const omniSmallIconSrc = "/omni-mark-small.svg";

export const DEFAULT_BASIC_SETTINGS: BasicSettings = {
  menuOpenMode: "hover",
  autoLaunch: false,
  minimizeBehavior: "compact",
  mainWindowWidth: EXPANDED_SIZE.width,
  mainWindowHeight: EXPANDED_SIZE.height,
  settingsWindowWidth: SETTINGS_SIZE.width,
  settingsWindowHeight: SETTINGS_SIZE.height,
  mainWindowPositionMode: "remember",
  showCompactBall: true,
  followCursorScreen: false,
  openMainShortcut: UNSET_SHORTCUT,
  switchPreviousModelShortcut: UNSET_SHORTCUT,
};

export const COMPACT_APPEARANCE_PRESETS: Record<CompactAppearance, { width: number; height: number }> = {
  default: { width: 120, height: 64 },
  compact: { width: 104, height: 56 },
  large: { width: 136, height: 72 },
  character: { width: 86, height: 108 },
};

export const COMPACT_APPEARANCE_OPTIONS: Array<{
  id: CompactAppearance;
  title: string;
  description: string;
}> = [
  { id: "default", title: "默认外观", description: "标准胶囊尺寸" },
  { id: "compact", title: "紧凑外观", description: "更小更轻量" },
  { id: "large", title: "大号外观", description: "更醒目的尺寸" },
  { id: "character", title: "2D 角色", description: "角色形象模式" },
];

export const CHARACTER_MODEL_OPTIONS: Array<{ id: CharacterModel; title: string; description: string }> = [
  { id: "hiyori", title: "Hiyori", description: "春日风格" },
];

export const EXTERNAL_CHAT_ENTRIES: ExternalChatEntry[] = [
  { id: "omni", title: "Omni", description: "打开 Omni 主界面", group: "common", kind: "main", icon: "omni" },
  { id: "openai", title: "ChatGPT", description: "打开 OpenAI 官方聊天界面", group: "common", url: "https://chatgpt.com/", kind: "external", icon: "chatgpt" },
  { id: "poe", title: "PoeChat", description: "打开 Poe 聊天界面", group: "common", url: "https://poe.com/", kind: "external", icon: "poe" },
  { id: "gemini", title: "Gemini", description: "打开 Google 官方聊天界面", group: "common", url: "https://gemini.google.com/app", kind: "external", icon: "gemini" },
  { id: "copilot", title: "Copilot", description: "打开 Microsoft Copilot 聊天界面", group: "common", url: "https://copilot.microsoft.com/", kind: "external", icon: "copilot" },
  { id: "claude", title: "Claude", description: "打开 Anthropic 官方聊天界面", group: "common", url: "https://claude.ai/", kind: "external", icon: "claude" },
  { id: "iflytekcloud", title: "讯飞星火", description: "打开讯飞星火官方聊天界面", group: "domestic", url: "https://xinghuo.xfyun.cn/", kind: "external", icon: "iflytekcloud" },
  { id: "zhipu", title: "智谱清言", description: "打开智谱清言官方聊天界面", group: "domestic", url: "https://chatglm.cn/", kind: "external", icon: "zhipu" },
  { id: "metaso", title: "秘塔搜索", description: "打开秘塔 AI 搜索", group: "domestic", url: "https://metaso.cn/", kind: "external", icon: "metaso" },
  { id: "baichuan", title: "百川大模型", description: "打开百川大模型官网界面", group: "domestic", url: "https://platform.baichuan-ai.com/", kind: "external", icon: "baichuan" },
  { id: "qwen", title: "通义千问", description: "打开 Qwen Chat", group: "domestic", url: "https://chat.qwen.ai/", kind: "external", icon: "qwen" },
  { id: "yuanbao", title: "腾讯元宝", description: "打开腾讯元宝官方界面", group: "domestic", url: "https://yuanbao.tencent.com/AI", kind: "external", icon: "yuanbao" },
  { id: "doubao", title: "抖音豆包", description: "打开豆包官方界面", group: "domestic", url: "https://www.doubao.com/", kind: "external", icon: "doubao" },
  { id: "deepseek", title: "DeepSeek", description: "打开 DeepSeek 官方聊天界面", group: "domestic", url: "https://chat.deepseek.com/", kind: "external", icon: "deepseek" },
];

export const CHAT_WINDOW_SIZE = { width: 1200, height: 820 };

export const EMPTY_CHAT_PROMPTS = [
  "帮我总结这段内容的重点",
  "把这个问题拆成可执行步骤",
  "给我一个更专业的表达版本",
  "对比两个方案的优缺点",
];
