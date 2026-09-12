import type { BasicSettings, ExternalChatEntry } from "./types";
import type { CompactAppearance } from "../hooks/useCompactWindowState";

export const MAIN_WINDOW_LABEL = "main";
export const COMPACT_WINDOW_LABEL = "compact";
export const PET_THOUGHT_WINDOW_LABEL = "pet-thought";
export const SETTINGS_WINDOW_LABEL = "settings";
export const EXPANDED_SIZE = { width: 920, height: 820 };
export const SETTINGS_WINDOW_SIZE = { width: 980, height: 760 };
export const BASIC_SETTINGS_STORAGE_KEY = "omni_basic_settings";
export const CODEX_PET_LIBRARY_STATE_STORAGE_KEY = "omni_codex_pet_library_state";
export const COMPACT_POSITION_STORAGE_KEY = "omni_compact_position";
export const MAIN_POSITION_STORAGE_KEY = "omni_main_position";
export const MAIN_VIEW_STORAGE_KEY = "omni_main_view";
export const CURRENT_MODEL_STORAGE_KEY = "omni_current_model";
export const THEME_MODE_STORAGE_KEY = "omni_theme_mode";
export const CHARACTER_SCALE_BASELINE = 1.4;
export const COMPACT_MENU_CLOSE_DELAY_MS = 160;
export const COMPACT_MENU_PANEL_WIDTH = 360;
export const COMPACT_MENU_PANEL_HEIGHT = 228;
export const UNSET_SHORTCUT = "未设置";
export const DEFAULT_OPEN_MAIN_SHORTCUT = "Ctrl+Shift+Space";
export const omniIconSrc = "/omni-mark.svg";
export const omniSmallIconSrc = "/omni-mark-small.svg";

export const DEFAULT_BASIC_SETTINGS: BasicSettings = {
  autoLaunch: false,
  minimizeBehavior: "compact",
  mainWindowWidth: EXPANDED_SIZE.width,
  mainWindowHeight: EXPANDED_SIZE.height,
  // 启动时默认居中：此前的默认值 "remember" 会把「某一时刻的落点」永久固化下来，
  // 显示器缩放/分辨率变化后那个落点就不再居中，看起来像"窗口跑偏了"。
  mainWindowPositionMode: "center",
  showCompactBall: true,
  followCursorScreen: false,
  openMainShortcut: DEFAULT_OPEN_MAIN_SHORTCUT,
  switchPreviousModelShortcut: UNSET_SHORTCUT,
  defaultWorkspacePath: "",
  shellPath: "",
  sandboxEnabled: false,
  subAgentModel: "",
  subAgentFastModel: "",
  // 默认关闭：专家只在「项目显式绑定」后才可被模型自动委派（技能/MCP 不受此口径约束）。
  allowAnyExpertDelegation: false,
};

export const COMPACT_APPEARANCE_PRESETS: Record<CompactAppearance, { width: number; height: number }> = {
  default: { width: 120, height: 64 },
  compact: { width: 108, height: 56 },
  large: { width: 136, height: 72 },
  pet: { width: 92, height: 90 },
};

export const COMPACT_APPEARANCE_OPTIONS: Array<{
  id: CompactAppearance;
  title: string;
  description: string;
}> = [
  { id: "default", title: "默认外观", description: "标准胶囊尺寸" },
  { id: "compact", title: "紧凑外观", description: "更小更轻巧" },
  { id: "large", title: "大号外观", description: "更醒目的尺寸" },
  { id: "pet", title: "桌宠", description: "桌宠精灵模式" },
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
  { id: "doubao", title: "豆包", description: "打开豆包官方界面", group: "domestic", url: "https://www.doubao.com/", kind: "external", icon: "doubao" },
  { id: "deepseek", title: "DeepSeek", description: "打开 DeepSeek 官方聊天界面", group: "domestic", url: "https://chat.deepseek.com/", kind: "external", icon: "deepseek" },
];

export const CHAT_WINDOW_SIZE = { width: 1200, height: 820 };

/**
 * 空态「推荐起步方式」卡片。
 *
 * 标题 / 说明 / 点击后插入输入框的起手句**必须来自同一条记录**。曾经标题取
 * `RECOMMENDED_PROJECT_PRESETS[index]`、插入文本取 `EMPTY_CHAT_PROMPTS[index]` ——
 * 两个互不相关的数组按下标 join，4 张卡错了 3 张：「代码排查助手」点下去插入的是
 * 「把这个问题拆成可执行步骤」，「效率命令助手」插入「对比两个方案的优缺点」。
 * **跨数组按下标对齐 = 必然分叉**，所以合并成一条记录，从结构上消掉这个 bug 类。
 *
 * 与插件模板（`kind:"template"`）无关，别合并：模板产出的是「新建项目的初始条件」
 * （写进 project.systemPrompt + 工具白名单），这里产出的只是「一句话起手」。
 */
export type EmptyChatStarter = {
  title: string;
  description: string;
  /** 点击后写入输入框的内容（不直接发送，用户仍可编辑）。 */
  prompt: string;
};

export const EMPTY_CHAT_STARTERS: EmptyChatStarter[] = [
  {
    title: "总结要点",
    description: "把长内容压成几句重点",
    prompt: "帮我总结这段内容的重点",
  },
  {
    title: "拆解步骤",
    description: "把问题变成可执行清单",
    prompt: "把这个问题拆成可执行步骤",
  },
  {
    title: "润色表达",
    description: "给出更专业的说法",
    prompt: "给我一个更专业的表达版本",
  },
  {
    title: "方案对比",
    description: "列优缺点并给出建议",
    prompt: "对比两个方案的优缺点",
  },
];
