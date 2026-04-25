import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import type { Message } from "./adapters/types";
import { loadProviderConfigs, modelRegistry } from "./adapters/registry";
import { executeChatTurn } from "./chat/engine";
import { resolveLocalSlashCommand, resolveSlashSkillPrompt } from "./chat/skills";
import {
  CHAT_SESSIONS_STORAGE_KEY,
  createChatSession as createStoredChatSession,
  formatUsageLabel,
  getInitialChatSessions as getStoredInitialChatSessions,
} from "./chat/storage";
import type { ChatExecutionResult, ChatSession } from "./chat/types";
import TitleBar from "./components/TitleBar";
import ModelSelector from "./components/ModelSelector";
import ChatMessage from "./components/ChatMessage";
import ChatInput from "./components/ChatInput";
import SettingsPanel from "./components/SettingsPanel";
import Live2DCharacter from "./components/Live2DCharacter";
import "./App.css";

type ViewMode = "chat" | "settings";
type CompactAppearance = "default" | "compact" | "large" | "character";
type CharacterModel = "hiyori" | "natori";
type MenuOpenMode = "hover" | "click";
type MinimizeBehavior = "taskbar" | "compact";
type WindowPositionMode = "center" | "remember";
type BasicSettings = {
  menuOpenMode: MenuOpenMode;
  autoLaunch: boolean;
  minimizeBehavior: MinimizeBehavior;
  mainWindowWidth: number;
  mainWindowHeight: number;
  settingsWindowWidth: number;
  settingsWindowHeight: number;
  mainWindowPositionMode: WindowPositionMode;
  showCompactBall: boolean;
  openMainShortcut: string;
  switchPreviousModelShortcut: string;
};

const MAIN_WINDOW_LABEL = "main";
const COMPACT_WINDOW_LABEL = "compact";
const appWindow = getCurrentWindow();
const isCompactWindow = appWindow.label === COMPACT_WINDOW_LABEL;

const EXPANDED_SIZE = { width: 920, height: 820 };
const SETTINGS_SIZE = EXPANDED_SIZE;
const BASIC_SETTINGS_STORAGE_KEY = "omni_basic_settings";
const DEFAULT_BASIC_SETTINGS: BasicSettings = {
  menuOpenMode: "hover",
  autoLaunch: false,
  minimizeBehavior: "compact",
  mainWindowWidth: EXPANDED_SIZE.width,
  mainWindowHeight: EXPANDED_SIZE.height,
  settingsWindowWidth: SETTINGS_SIZE.width,
  settingsWindowHeight: SETTINGS_SIZE.height,
  mainWindowPositionMode: "remember",
  showCompactBall: true,
  openMainShortcut: "未设置",
  switchPreviousModelShortcut: "未设置",
};
const omniIconSrc = "/omni-mark.svg";
const omniSmallIconSrc = "/omni-mark-small.svg";
const COMPACT_APPEARANCE_STORAGE_KEY = "omni_compact_appearance";
const CHARACTER_SCALE_STORAGE_KEY = "omni_character_scale";
const CHARACTER_MODEL_STORAGE_KEY = "omni_character_model";
const CHARACTER_SCALE_BASELINE = 2;
const COMPACT_POSITION_STORAGE_KEY = "omni_compact_position";
const MAIN_POSITION_STORAGE_KEY = "omni_main_position";
const MAIN_VIEW_STORAGE_KEY = "omni_main_view";
const CURRENT_MODEL_STORAGE_KEY = "omni_current_model";
const THEME_MODE_STORAGE_KEY = "omni_theme_mode";
const MIN_CHARACTER_SCALE = 0.45;
const MAX_CHARACTER_SCALE = 4.2;
const COMPACT_MENU_CLOSE_DELAY_MS = 160;
const COMPACT_MENU_PANEL_WIDTH = 360;
const COMPACT_MENU_PANEL_HEIGHT = 228;
const COMPACT_APPEARANCE_PRESETS: Record<CompactAppearance, { width: number; height: number }> = {
  default: { width: 120, height: 64 },
  compact: { width: 104, height: 56 },
  large: { width: 136, height: 72 },
  character: { width: 86, height: 108 },
};
const COMPACT_APPEARANCE_OPTIONS: Array<{
  id: CompactAppearance;
  title: string;
  description: string;
}> = [
  { id: "default", title: "默认外观", description: "当前胶囊尺寸" },
  { id: "compact", title: "紧凑外观", description: "更小一档" },
  { id: "large", title: "大号外观", description: "更大一档" },
  { id: "character", title: "2D角色", description: "角色形象模式" },
];
const CHARACTER_MODEL_OPTIONS: Array<{ id: CharacterModel; title: string; description: string }> = [
  { id: "hiyori", title: "Hiyori", description: "春日风格" },
  { id: "natori", title: "Natori", description: "名取风格" },
];
const EXTERNAL_CHAT_ENTRIES = [
  { id: "omni", title: "Omni", description: "打开 Omni 主界面", kind: "main" },
  { id: "openai", title: "ChatGPT", description: "打开 OpenAI 官方聊天界面", url: "https://chatgpt.com/", kind: "external" },
  { id: "claude", title: "Claude", description: "打开 Anthropic 官方聊天界面", url: "https://claude.ai/", kind: "external" },
  { id: "gemini", title: "Gemini", description: "打开 Google 官方聊天界面", url: "https://gemini.google.com/app", kind: "external" },
  { id: "deepseek", title: "DeepSeek", description: "打开 DeepSeek 官方聊天界面", url: "https://chat.deepseek.com/", kind: "external" },
  { id: "copilot", title: "Copilot", description: "打开 Microsoft Copilot 聊天界面", url: "https://copilot.microsoft.com/", kind: "external" },
  { id: "poe", title: "Poe", description: "打开 Poe 聊天界面", url: "https://poe.com/", kind: "external" },
] as const;
const CHAT_WINDOW_SIZE = { width: 1200, height: 820 };
const EMPTY_CHAT_PROMPTS = [
  "帮我总结这段内容的重点",
  "把这个问题拆成可执行步骤",
  "给我一个更专业的表达方式",
  "对比两个方案的优缺点",
];

function isCharacterPointerInHitArea(element: HTMLElement, clientX: number, clientY: number) {
  const rect = element.getBoundingClientRect();
  const relativeX = (clientX - rect.left) / rect.width;
  const relativeY = (clientY - rect.top) / rect.height;
  return relativeX >= 0.38 && relativeX <= 0.66 && relativeY >= 0.04 && relativeY <= 0.98;
}

function createChatSession(messages: Message[] = []): ChatSession {
  return createStoredChatSession(messages);
}

function getChatSessionTitle(messages: Message[]) {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const content = firstUserMessage?.content?.trim();
  if (!content) return "新聊天";
  return content.length > 18 ? `${content.slice(0, 18)}...` : content;
}

function getInitialChatSessions(): ChatSession[] {
  return getStoredInitialChatSessions();
}

function getChatSessionGroupLabel(updatedAt: number) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(updatedAt);
  const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const dayDiff = Math.floor((today - targetDay) / 86400000);

  if (dayDiff <= 0) return "今天";
  if (dayDiff === 1) return "昨天";
  if (dayDiff <= 7) return "7 天内";
  if (dayDiff <= 30) return "30 天内";
  return "更早";
}

function getBasicSettings(): BasicSettings {
  if (typeof window === "undefined") return DEFAULT_BASIC_SETTINGS;
  try {
    return { ...DEFAULT_BASIC_SETTINGS, ...JSON.parse(localStorage.getItem(BASIC_SETTINGS_STORAGE_KEY) || "{}") };
  } catch {
    return DEFAULT_BASIC_SETTINGS;
  }
}

function clampWindowSize(value: number, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function normalizeShortcutKey(event: KeyboardEvent) {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return "";
  return [
    event.ctrlKey ? "Ctrl" : "",
    event.shiftKey ? "Shift" : "",
    event.altKey ? "Alt" : "",
    event.metaKey ? "Meta" : "",
    event.key.length === 1 ? event.key.toUpperCase() : event.key,
  ].filter(Boolean).join("+");
}

function applyThemeFromStorage() {
  if (typeof window === "undefined") return;
  const saved = localStorage.getItem(THEME_MODE_STORAGE_KEY);
  const mode = saved === "dark" || saved === "light" ? saved : "auto";
  const resolved = mode === "auto" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : mode;
  document.documentElement.dataset.omniThemeMode = mode;
  document.documentElement.dataset.omniTheme = resolved;
}

function clampCharacterScale(value: number) {
  return Math.min(MAX_CHARACTER_SCALE, Math.max(MIN_CHARACTER_SCALE, Number(value.toFixed(2))));
}

function getInitialCompactAppearance(): CompactAppearance {
  if (typeof window === "undefined") return "default";
  const saved = localStorage.getItem(COMPACT_APPEARANCE_STORAGE_KEY);
  return saved === "compact" || saved === "large" || saved === "character" ? saved : "default";
}

function getInitialCharacterScale(): number {
  if (typeof window === "undefined") return 1;
  const saved = Number(localStorage.getItem(CHARACTER_SCALE_STORAGE_KEY) || "1");
  return Number.isFinite(saved) ? clampCharacterScale(saved) : 1;
}

function getInitialCharacterModel(): CharacterModel {
  if (typeof window === "undefined") return "hiyori";
  const saved = localStorage.getItem(CHARACTER_MODEL_STORAGE_KEY);
  return saved === "natori" ? "natori" : "hiyori";
}

function getStoredCompactPosition() {
  if (typeof window === "undefined") return null;
  try {
    const saved = localStorage.getItem(COMPACT_POSITION_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as { x?: number; y?: number };
    const { x, y } = parsed;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return { x: Math.round(x as number), y: Math.round(y as number) };
  } catch {
    return null;
  }
}

function persistCompactPosition(position: { x: number; y: number }) {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    COMPACT_POSITION_STORAGE_KEY,
    JSON.stringify({
      x: Math.round(position.x),
      y: Math.round(position.y),
    })
  );
}


function getStoredMainPosition() {
  if (typeof window === "undefined") return null;
  try {
    const saved = localStorage.getItem(MAIN_POSITION_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as { x?: number; y?: number };
    const { x, y } = parsed;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return { x: Math.round(x as number), y: Math.round(y as number) };
  } catch {
    return null;
  }
}

function persistMainPosition(position: { x: number; y: number }) {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    MAIN_POSITION_STORAGE_KEY,
    JSON.stringify({
      x: Math.round(position.x),
      y: Math.round(position.y),
    })
  );
}

function getStoredMainView(): ViewMode {
  if (typeof window === "undefined") return "chat";
  return localStorage.getItem(MAIN_VIEW_STORAGE_KEY) === "settings" ? "settings" : "chat";
}

function getMainWindowSizeForView(viewMode: ViewMode) {
  const settings = getBasicSettings();
  if (viewMode === "settings") {
    return {
      width: clampWindowSize(settings.settingsWindowWidth, SETTINGS_SIZE.width, 640, 1800),
      height: clampWindowSize(settings.settingsWindowHeight, SETTINGS_SIZE.height, 480, 1400),
    };
  }
  return {
    width: clampWindowSize(settings.mainWindowWidth, EXPANDED_SIZE.width, 640, 1800),
    height: clampWindowSize(settings.mainWindowHeight, EXPANDED_SIZE.height, 480, 1400),
  };
}

function isMainPositionVisible(position: { x: number; y: number }) {
  if (typeof window === "undefined") return false;

  const screenInfo = window.screen as Screen & { availLeft?: number; availTop?: number };
  const left = Number(screenInfo.availLeft ?? 0);
  const top = Number(screenInfo.availTop ?? 0);
  const width = Number(screenInfo.availWidth || screenInfo.width);
  const height = Number(screenInfo.availHeight || screenInfo.height);

  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return false;
  }

  const right = left + width;
  const bottom = top + height;
  const visibleMargin = 80;

  const restoredSize = getMainWindowSizeForView(getStoredMainView());

  return (
    position.x < right - visibleMargin &&
    position.x + restoredSize.width > left + visibleMargin &&
    position.y < bottom - visibleMargin &&
    position.y + restoredSize.height > top + visibleMargin
  );
}
function getCompactWindowSize(appearance: CompactAppearance, scale: number) {
  const preset = COMPACT_APPEARANCE_PRESETS[appearance];
  return {
    width: Math.round(preset.width * scale),
    height: Math.round(preset.height * scale),
  };
}

function getExpandedCompactViewportSize(includeReply = false) {
  const maxPresetHeight = Math.max(...Object.values(COMPACT_APPEARANCE_PRESETS).map((preset) => preset.height));

  return {
    width: Math.max(
      Math.round(COMPACT_APPEARANCE_PRESETS.character.width * MAX_CHARACTER_SCALE * CHARACTER_SCALE_BASELINE) +
        (includeReply ? 380 : 12),
      COMPACT_MENU_PANEL_WIDTH
    ),
    height:
      Math.max(
        Math.round(COMPACT_APPEARANCE_PRESETS.character.height * MAX_CHARACTER_SCALE * CHARACTER_SCALE_BASELINE) + 12,
        maxPresetHeight
      ) + COMPACT_MENU_PANEL_HEIGHT,
  };
}

function getExpandedCompactViewportSizeForAppearance(
  appearance: CompactAppearance,
  scale: number,
  options: { includeReply?: boolean; includeHorizontalPanel?: boolean } = {}
) {
  const compactSize = getCompactWindowSize(appearance, scale);
  const baseExpanded = getExpandedCompactViewportSize(Boolean(options.includeReply));
  const horizontalPanelWidth = options.includeHorizontalPanel ? COMPACT_MENU_PANEL_WIDTH : 0;

  return {
    width: Math.max(baseExpanded.width, compactSize.width + horizontalPanelWidth),
    height: Math.max(baseExpanded.height, compactSize.height + COMPACT_MENU_PANEL_HEIGHT),
  };
}

async function resizeWindow(targetWindow: ReturnType<typeof getCurrentWindow>, width: number, height: number) {
  const scaleFactor = await targetWindow.scaleFactor();
  const currentSize = (await targetWindow.outerSize()).toLogical(scaleFactor);
  const currentPosition = (await targetWindow.outerPosition()).toLogical(scaleFactor);
  const nextX = currentPosition.x + (currentSize.width - width) / 2;
  const nextY = currentPosition.y + (currentSize.height - height) / 2;

  await targetWindow.setSize(new LogicalSize(width, height));
  await targetWindow.setPosition(new LogicalPosition(Math.round(nextX), Math.round(nextY)));
}

async function applyCompactWindowChrome(targetWindow: ReturnType<typeof getCurrentWindow>) {
  await Promise.all([
    targetWindow.setShadow(false),
    targetWindow.setResizable(false),
    targetWindow.setAlwaysOnTop(true),
    targetWindow.setSkipTaskbar(true),
  ]);
}

async function applyExpandedWindowChrome(targetWindow: ReturnType<typeof getCurrentWindow>) {
  await Promise.all([
    targetWindow.setShadow(false),
    targetWindow.setResizable(true),
    targetWindow.setAlwaysOnTop(false),
    targetWindow.setSkipTaskbar(false),
    targetWindow.setDecorations(false),
  ]);
}

async function ensureCompactWindow(appearance: CompactAppearance, scale: number) {
  const size = getCompactWindowSize(appearance, scale);
  const expandedViewport = getExpandedCompactViewportSize(true);
  const storedPosition = getStoredCompactPosition();
  let compactWindow = await WebviewWindow.getByLabel(COMPACT_WINDOW_LABEL);

  if (!compactWindow) {
    compactWindow = new WebviewWindow(COMPACT_WINDOW_LABEL, {
      url: "/?compact=1",
      title: "Omni Compact",
      width: size.width,
      height: size.height,
      minWidth: size.width,
      minHeight: size.height,
      maxWidth: expandedViewport.width,
      maxHeight: expandedViewport.height,
      decorations: false,
      transparent: true,
      shadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      visible: false,
      focus: false,
      center: storedPosition == null,
      x: storedPosition?.x,
      y: storedPosition?.y,
    });

    await new Promise<void>((resolve, reject) => {
      compactWindow?.once("tauri://created", () => resolve());
      compactWindow?.once("tauri://error", (event) => reject(event.payload));
    });
  }

  await applyCompactWindowChrome(compactWindow);
  await compactWindow.setSize(new LogicalSize(size.width, size.height));
  return compactWindow;
}

async function showCompactWindow(appearance: CompactAppearance, scale: number) {
  const compactWindow = await ensureCompactWindow(appearance, scale);
  const storedPosition = getStoredCompactPosition();

  if (storedPosition) {
    await compactWindow.setPosition(new LogicalPosition(storedPosition.x, storedPosition.y));
  }

  await compactWindow.show();
  await compactWindow.setAlwaysOnTop(true);
  await compactWindow.setFocus();
}

async function openInternalChatWindow(entry: Extract<(typeof EXTERNAL_CHAT_ENTRIES)[number], { kind: "external" }>) {
  const label = `chat-${entry.id}`;
  let chatWindow = await WebviewWindow.getByLabel(label);

  if (!chatWindow) {
    chatWindow = new WebviewWindow(label, {
      url: entry.url,
      title: entry.title,
      width: CHAT_WINDOW_SIZE.width,
      height: CHAT_WINDOW_SIZE.height,
      minWidth: 960,
      minHeight: 640,
      center: true,
      decorations: true,
      transparent: false,
      resizable: true,
      alwaysOnTop: false,
      skipTaskbar: false,
      focus: true,
    });

    await new Promise<void>((resolve, reject) => {
      chatWindow?.once("tauri://created", () => resolve());
      chatWindow?.once("tauri://error", (event) => reject(event.payload));
    });
  }

  await chatWindow.show();
  await chatWindow.setFocus();
}

async function restoreMainWindow(focusInput = false) {
  const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);

  if (mainWindow) {
    try {
      const isMinimized = await mainWindow.isMinimized();
      if (isMinimized) {
        await mainWindow.unminimize();
      }
    } catch {
      // Ignore unsupported state checks on some platforms.
    }

    await applyExpandedWindowChrome(mainWindow);
    await mainWindow.show();
    const restoredSize = getMainWindowSizeForView(getStoredMainView());
    await resizeWindow(mainWindow, restoredSize.width, restoredSize.height);

    const settings = getBasicSettings();
    if (settings.mainWindowPositionMode !== "center") {
      const storedMainPos = getStoredMainPosition();
      if (storedMainPos && isMainPositionVisible(storedMainPos)) {
        await mainWindow.setPosition(new LogicalPosition(storedMainPos.x, storedMainPos.y));
      } else {
        await mainWindow.center();
      }
    } else {
      await mainWindow.center();
    }

    await mainWindow.setFocus();

    if (focusInput) {
      await mainWindow.emit("omni-focus-input");
    }
  }
}

function App() {
  const [chatSessions, setChatSessions] = useState<ChatSession[]>(getInitialChatSessions);
  const [activeChatId, setActiveChatId] = useState<string | null>(() => chatSessions[0]?.id ?? null);
  const [messages, setMessages] = useState<Message[]>(() => chatSessions[0]?.messages ?? []);
  const [currentModel, setCurrentModel] = useState("gpt-4o");
  const [isLoading, setIsLoading] = useState(false);
  const [view, setView] = useState<ViewMode>(getStoredMainView);
  const [compactAppearance, setCompactAppearance] = useState<CompactAppearance>(getInitialCompactAppearance);
  const [characterScale, setCharacterScale] = useState<number>(getInitialCharacterScale);
  const [characterModel, setCharacterModel] = useState<CharacterModel>(getInitialCharacterModel);
  const [error, setError] = useState<string | null>(null);
  const [inputFocusKey, setInputFocusKey] = useState(0);
  const [inputDraft, setInputDraft] = useState("");
  const [inputDraftImages, setInputDraftImages] = useState<string[]>([]);
  const [inputDraftKey, setInputDraftKey] = useState(0);
  const [basicSettings, setBasicSettings] = useState<BasicSettings>(getBasicSettings);
  const [previousModel, setPreviousModel] = useState<string | null>(null);
  const [isCompactMenuOpen, setIsCompactMenuOpen] = useState(false);
  const [isCompactModelOpen, setIsCompactModelOpen] = useState(false);
  const [isCompactAppearanceOpen, setIsCompactAppearanceOpen] = useState(false);
  const [isCharacterModelOpen, setIsCharacterModelOpen] = useState(false);
  const [isCharacterMenuPinned, setIsCharacterMenuPinned] = useState(false);
  const [characterMenuPosition, setCharacterMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [characterPanelSide, setCharacterPanelSide] = useState<"left" | "right">("left");
  const [isCompactQueryOpen, setIsCompactQueryOpen] = useState(false);
  const [compactQuery, setCompactQuery] = useState("");
  const [compactReply, setCompactReply] = useState<{ question: string; answer: string } | null>(null);
  const [isCompactReplyLoading, setIsCompactReplyLoading] = useState(false);
  const [editingMessageIndex, setEditingMessageIndex] = useState<number | null>(null);
  const [openChatMenu, setOpenChatMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [, setRegistryVersion] = useState(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const compactMenuCloseTimerRef = useRef<number | null>(null);
  const characterDragTimerRef = useRef<number | null>(null);
  const isCharacterDraggingRef = useRef(false);
  const lastRunIdRef = useRef(0);

  const effectiveCompactScale = compactAppearance === "character" ? characterScale * CHARACTER_SCALE_BASELINE : 1;
  const isCharacterAppearance = compactAppearance === "character";
  const compactSize = useMemo(
    () => getCompactWindowSize(compactAppearance, effectiveCompactScale),
    [compactAppearance, effectiveCompactScale]
  );
  const compactViewportSize = useMemo(() => {
    if (isCharacterAppearance && isCompactQueryOpen && !isCompactMenuOpen && !isCompactReplyLoading && !compactReply) {
      return {
        width: compactSize.width,
        height: compactSize.height + 96,
      };
    }
    if (isCompactMenuOpen || isCompactQueryOpen || isCompactReplyLoading || compactReply) {
      return getExpandedCompactViewportSizeForAppearance(compactAppearance, effectiveCompactScale, {
        includeReply: Boolean(isCompactReplyLoading || compactReply),
        includeHorizontalPanel: false,
      });
    }
    return null;
  }, [compactAppearance, compactReply, compactSize.height, compactSize.width, effectiveCompactScale, isCharacterAppearance, isCompactMenuOpen, isCompactQueryOpen, isCompactReplyLoading]);
  const isCharacterHorizontalPanelOpen = isCharacterAppearance && Boolean(isCompactMenuOpen || isCompactReplyLoading || compactReply);
  const compactStyle = useMemo<CSSProperties>(() => {
    const buttonSize = compactAppearance === "character" ? Math.max(26, Math.round(compactSize.width * 0.36)) : Math.max(28, compactSize.height - 30);
    const iconSize = compactAppearance === "character" ? Math.max(14, Math.round(buttonSize * 0.48)) : Math.max(14, Math.round(buttonSize * 0.5));
    const characterReplyGap = Math.min(108, Math.max(40, Math.round(compactSize.width * 0.3)));

    return {
      "--compact-bar-width": `${Math.max(42, compactSize.width - 20)}px`,
      "--compact-bar-height": `${Math.max(42, compactSize.height - 24)}px`,
      "--compact-button-size": `${buttonSize}px`,
      "--compact-button-icon-size": `${iconSize}px`,
      "--compact-gap": compactAppearance === "character" ? `${Math.max(4, Math.round(compactSize.width * 0.04))}px` : `${Math.max(8, Math.round(compactSize.width * 0.08))}px`,
      "--compact-padding": compactAppearance === "character" ? `${Math.max(3, Math.round(compactSize.width * 0.03))}px` : `${Math.max(6, Math.round(compactSize.height * 0.13))}px`,
      "--compact-character-size": `${Math.max(48, compactSize.width - 18)}px`,
      "--compact-character-reply-gap": `${characterReplyGap}px`,
    } as CSSProperties;
  }, [compactAppearance, compactSize.height, compactSize.width]);

  useEffect(() => {
    applyThemeFromStorage();
    const onThemeStorage = (event: StorageEvent) => {
      if (!event.key || event.key === THEME_MODE_STORAGE_KEY) {
        applyThemeFromStorage();
      }
    };
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onSystemThemeChange = () => applyThemeFromStorage();
    window.addEventListener("storage", onThemeStorage);
    media.addEventListener("change", onSystemThemeChange);
    return () => {
      window.removeEventListener("storage", onThemeStorage);
      media.removeEventListener("change", onSystemThemeChange);
    };
  }, []);

  useEffect(() => {
    void (isCompactWindow ? applyCompactWindowChrome(appWindow) : applyExpandedWindowChrome(appWindow));
    loadProviderConfigs();
    if (!isCompactWindow) {
      setCurrentModel(modelRegistry.getCurrentModel());
      setRegistryVersion((value) => value + 1);
      const initialBasicSettings = getBasicSettings();
      if (initialBasicSettings.showCompactBall) {
        void showCompactWindow(getInitialCompactAppearance(), getInitialCompactAppearance() === "character" ? getInitialCharacterScale() * CHARACTER_SCALE_BASELINE : 1);
      }
      void appWindow.hide();
    } else {
      setCurrentModel(modelRegistry.getCurrentModel());
    }
  }, []);

  useEffect(() => {
    if (isCompactWindow) return;
    const container = messagesScrollRef.current;
    if (!container) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  useEffect(() => {
    if (isCompactWindow) return;
    if (!activeChatId) return;
    const now = Date.now();
    setChatSessions((sessions) =>
      sessions.map((session) => {
        if (session.id !== activeChatId) return session;
        if (session.messages === messages) return session;
        return {
          ...session,
          title: getChatSessionTitle(messages),
          messages,
          updatedAt: now,
        };
      })
    );
  }, [activeChatId, messages]);

  useEffect(() => {
    if (isCompactWindow) return;
    localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, JSON.stringify(chatSessions));
  }, [chatSessions]);

  useEffect(() => {
    const onStorage = (event?: StorageEvent) => {
      setCompactAppearance(getInitialCompactAppearance());
      setCharacterScale(getInitialCharacterScale());
      setCharacterModel(getInitialCharacterModel());
      if (!event || event.key === BASIC_SETTINGS_STORAGE_KEY) {
        setBasicSettings(getBasicSettings());
      }
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    localStorage.setItem(COMPACT_APPEARANCE_STORAGE_KEY, compactAppearance);
  }, [compactAppearance]);

  useEffect(() => {
    localStorage.setItem(CHARACTER_SCALE_STORAGE_KEY, String(characterScale));
  }, [characterScale]);

  useEffect(() => {
    localStorage.setItem(CHARACTER_MODEL_STORAGE_KEY, characterModel);
  }, [characterModel]);

  useEffect(() => {
    if (!isCompactWindow) return;
    if (!basicSettings.showCompactBall) {
      void appWindow.hide();
    }
  }, [basicSettings.showCompactBall]);

  useEffect(() => {
    if (!isCompactWindow) return;
    let unlisten: (() => void) | undefined;
    void appWindow.onFocusChanged(({ payload }) => {
      if (payload) {
        void appWindow.setAlwaysOnTop(true);
        return;
      }
      setIsCharacterMenuPinned(false);
      setIsCompactMenuOpen(false);
      setIsCompactModelOpen(false);
      setIsCompactAppearanceOpen(false);
      setIsCharacterModelOpen(false);
      setCharacterMenuPosition(null);
      setIsCompactQueryOpen(false);
      setCompactReply(null);
      setIsCompactReplyLoading(false);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isCompactWindow) return;

    const targetSize = compactViewportSize ?? compactSize;
    void (async () => {
      if (isCharacterAppearance) {
        const scaleFactor = await appWindow.scaleFactor();
        const currentSize = (await appWindow.outerSize()).toLogical(scaleFactor);
        const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
        const anchorRight = characterPanelSide === "left";
        const nextX = anchorRight
          ? Math.round(currentPosition.x + currentSize.width - targetSize.width)
          : Math.round(currentPosition.x);
        await Promise.all([
          appWindow.setPosition(new LogicalPosition(nextX, Math.round(currentPosition.y))),
          appWindow.setSize(new LogicalSize(targetSize.width, targetSize.height)),
        ]);
        return;
      }

      await appWindow.setSize(new LogicalSize(targetSize.width, targetSize.height));
    })();
  }, [characterPanelSide, compactSize, compactViewportSize, isCharacterAppearance, isCharacterHorizontalPanelOpen]);

  useEffect(() => {
    if (isCompactWindow) return;
    localStorage.setItem(MAIN_VIEW_STORAGE_KEY, view);
    const targetSize = getMainWindowSizeForView(view);
    void resizeWindow(appWindow, targetSize.width, targetSize.height);
  }, [view, basicSettings.mainWindowWidth, basicSettings.mainWindowHeight, basicSettings.settingsWindowWidth, basicSettings.settingsWindowHeight]);

  // Persist compact window position on move
  useEffect(() => {
    if (!isCompactWindow) return;
    let unlisten: (() => void) | undefined;
    void appWindow.onMoved(async (event) => {
      const scaleFactor = await appWindow.scaleFactor();
      const pos = event.payload.toLogical(scaleFactor);
      persistCompactPosition({ x: Math.round(pos.x), y: Math.round(pos.y) });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (compactMenuCloseTimerRef.current !== null) {
        window.clearTimeout(compactMenuCloseTimerRef.current);
      }
      if (characterDragTimerRef.current !== null) {
        window.clearTimeout(characterDragTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isCompactWindow) return;
    let cleanup: (() => void) | undefined;
    let draftCleanup: (() => void) | undefined;
    let settingsCleanup: (() => void) | undefined;

    void appWindow
      .listen("omni-focus-input", () => {
        setInputFocusKey((value) => value + 1);
      })
      .then((unlisten) => {
        cleanup = unlisten;
      });

    void appWindow
      .listen("omni-set-draft", (event) => {
        const payload = event.payload as { draft?: string } | null;
        setInputDraft(payload?.draft ?? "");
        setInputDraftKey((value) => value + 1);
      })
      .then((unlisten) => {
        draftCleanup = unlisten;
      });

    void appWindow
      .listen("omni-open-settings", () => {
        setView("settings");
      })
      .then((unlisten) => {
        settingsCleanup = unlisten;
      });


    // Persist main window position on move
    let moveUnlisten: (() => void) | undefined;
    void appWindow.onMoved(async (event) => {
      const scaleFactor = await appWindow.scaleFactor();
      const pos = event.payload.toLogical(scaleFactor);
      persistMainPosition({ x: Math.round(pos.x), y: Math.round(pos.y) });
    }).then((fn) => {
      moveUnlisten = fn;
    });

    return () => {
      cleanup?.();
      draftCleanup?.();
      settingsCleanup?.();
      moveUnlisten?.();
    };
  }, []);

  const handleModelChange = useCallback((modelId: string) => {
    setCurrentModel((current) => {
      if (current && current !== modelId) {
        setPreviousModel(current);
      }
      return modelId;
    });
    modelRegistry.setCurrentModel(modelId);
    localStorage.setItem("omni_current_model", modelId);
  }, []);

  useEffect(() => {
    if (isCompactWindow) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = normalizeShortcutKey(event);
      if (!shortcut) return;
      if (basicSettings.openMainShortcut !== "未设置" && shortcut === basicSettings.openMainShortcut) {
        event.preventDefault();
        setView("chat");
        localStorage.setItem(MAIN_VIEW_STORAGE_KEY, "chat");
        void restoreMainWindow(false);
        return;
      }
      if (basicSettings.switchPreviousModelShortcut !== "未设置" && shortcut === basicSettings.switchPreviousModelShortcut && previousModel) {
        event.preventDefault();
        handleModelChange(previousModel);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [basicSettings.openMainShortcut, basicSettings.switchPreviousModelShortcut, handleModelChange, previousModel]);

  const handleOpenCompact = useCallback(async () => {
    if (basicSettings.showCompactBall) {
      await showCompactWindow(compactAppearance, effectiveCompactScale);
    }
    await appWindow.hide();
  }, [basicSettings.showCompactBall, compactAppearance, effectiveCompactScale]);

  const handleRestoreMain = useCallback(async (focusInput = false) => {
    await restoreMainWindow(focusInput);
  }, []);

  const handleOpenMainShortcut = useCallback(async () => {
    localStorage.setItem(MAIN_VIEW_STORAGE_KEY, "chat");
    setView("chat");
    await restoreMainWindow(false);
  }, []);

  useEffect(() => {
    if (isCompactWindow || basicSettings.openMainShortcut === "未设置") return;
    let registered = false;
    void register(basicSettings.openMainShortcut, () => {
      void handleOpenMainShortcut();
    }).then(() => {
      registered = true;
    }).catch(() => {
      registered = false;
    });
    return () => {
      if (registered) {
        void unregister(basicSettings.openMainShortcut);
      }
    };
  }, [basicSettings.openMainShortcut, handleOpenMainShortcut]);

  const closeCompactMenus = useCallback(() => {
    setIsCharacterMenuPinned(false);
    setCharacterMenuPosition(null);
    setIsCompactMenuOpen(false);
    setIsCompactModelOpen(false);
    setIsCompactAppearanceOpen(false);
    setIsCharacterModelOpen(false);
  }, []);

  const handleOpenSettingsFromCompact = useCallback(async () => {
    closeCompactMenus();
    localStorage.setItem(MAIN_VIEW_STORAGE_KEY, "settings");
    await restoreMainWindow(false);
    const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
    await mainWindow?.emit("omni-open-settings");
  }, [closeCompactMenus]);

  const closeCompactMenuPanels = useCallback(() => {
    setIsCompactMenuOpen(false);
    setIsCompactModelOpen(false);
    setIsCompactAppearanceOpen(false);
    setIsCharacterModelOpen(false);
    setCharacterMenuPosition(null);
  }, []);

  const handleToggleMainFromCompact = useCallback(async () => {
    await appWindow.setAlwaysOnTop(true);
    closeCompactMenus();
    setIsCompactQueryOpen(false);
    setCompactReply(null);

    const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
    if (!mainWindow) {
      await restoreMainWindow(false);
      return;
    }

    try {
      const isVisible = await mainWindow.isVisible();
      const isMinimized = await mainWindow.isMinimized();
      if (isVisible && !isMinimized) {
        await mainWindow.hide();
        return;
      }
    } catch {
      // If state checks fail, fall back to showing the window.
    }

    await restoreMainWindow(false);
  }, [closeCompactMenus]);

  const resolveCharacterPanelSide = useCallback(async () => {
    if (!isCompactWindow || !isCharacterAppearance) return "left" as const;

    const scaleFactor = await appWindow.scaleFactor();
    const currentPosition = (await appWindow.outerPosition()).toLogical(scaleFactor);
    const currentSize = (await appWindow.outerSize()).toLogical(scaleFactor);
    const monitor = await currentMonitor();
    const monitorScale = monitor?.scaleFactor || scaleFactor || 1;
    const workAreaLeft = monitor ? monitor.workArea.position.x / monitorScale : 0;
    const workAreaWidth = monitor ? monitor.workArea.size.width / monitorScale : Number(window.screen.availWidth || window.screen.width || 0);
    const workAreaRight = workAreaLeft + workAreaWidth;
    const expandedSize = getExpandedCompactViewportSizeForAppearance(compactAppearance, effectiveCompactScale, {
      includeReply: true,
      includeHorizontalPanel: false,
    });
    const panelWidth = Math.max(176, expandedSize.width - compactSize.width + 12);
    const leftSpace = Math.max(0, currentPosition.x - workAreaLeft);
    const rightSpace = Math.max(0, workAreaRight - (currentPosition.x + currentSize.width));
    const canOpenLeft = leftSpace >= panelWidth;
    const canOpenRight = rightSpace >= panelWidth;

    if (!canOpenLeft && canOpenRight) return "right" as const;
    if (canOpenLeft && !canOpenRight) return "left" as const;
    return leftSpace >= rightSpace ? "left" as const : "right" as const;
  }, [compactAppearance, compactSize.width, effectiveCompactScale, isCharacterAppearance]);

  const handleOpenCompactQuery = useCallback(async () => {
    setIsCompactMenuOpen(false);
    setIsCompactModelOpen(false);
    setIsCompactAppearanceOpen(false);
    setIsCharacterModelOpen(false);
    setIsCharacterMenuPinned(false);
    setCharacterMenuPosition(null);
    if (isCompactWindow && isCharacterAppearance) {
      setCharacterPanelSide(await resolveCharacterPanelSide());
    }
    setIsCompactQueryOpen(true);
  }, [isCharacterAppearance, resolveCharacterPanelSide]);

  const handleOpenExternalChat = useCallback(async (entry: (typeof EXTERNAL_CHAT_ENTRIES)[number]) => {
    closeCompactMenus();

    if (entry.kind === "main") {
      await handleRestoreMain(true);
      return;
    }

    await openInternalChatWindow(entry);
  }, [closeCompactMenus, handleRestoreMain]);

  const handleCharacterPointerDown = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (e.button !== 0) {
      if (characterDragTimerRef.current !== null) {
        window.clearTimeout(characterDragTimerRef.current);
        characterDragTimerRef.current = null;
      }
      return;
    }
    const isInCharacterHitArea = isCharacterPointerInHitArea(e.currentTarget, e.clientX, e.clientY);
    if (!isInCharacterHitArea) {
      if (compactMenuCloseTimerRef.current !== null) {
        window.clearTimeout(compactMenuCloseTimerRef.current);
        compactMenuCloseTimerRef.current = null;
      }
      setIsCharacterMenuPinned(false);
      setIsCompactMenuOpen(false);
      setIsCompactModelOpen(false);
      setIsCompactAppearanceOpen(false);
      setIsCharacterModelOpen(false);
      setCharacterMenuPosition(null);
      setIsCompactQueryOpen(false);
      setCompactReply(null);
      setIsCompactReplyLoading(false);
      return;
    }
    e.stopPropagation();
    isCharacterDraggingRef.current = false;
    if (characterDragTimerRef.current !== null) {
      window.clearTimeout(characterDragTimerRef.current);
    }
    characterDragTimerRef.current = window.setTimeout(() => {
      isCharacterDraggingRef.current = true;
      void appWindow.startDragging();
      characterDragTimerRef.current = null;
    }, 180);
  }, []);

  const handleCharacterPointerUp = useCallback(() => {
    if (characterDragTimerRef.current !== null) {
      window.clearTimeout(characterDragTimerRef.current);
      characterDragTimerRef.current = null;
    }
  }, []);

  const handleCompactQuerySubmit = useCallback(async (openMain = false) => {
    const draft = compactQuery.trim();
    if (!draft) return;

    loadProviderConfigs();
    const savedModel = localStorage.getItem(CURRENT_MODEL_STORAGE_KEY);
    const resolvedModel = savedModel && modelRegistry.getModelConfig(savedModel) ? savedModel : modelRegistry.getCurrentModel();
    modelRegistry.setCurrentModel(resolvedModel);
    if (resolvedModel !== currentModel) {
      setCurrentModel(resolvedModel);
    }

    if (openMain) {
      await restoreMainWindow(true);
      const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
      if (mainWindow) {
        await mainWindow.emit("omni-set-draft", { draft });
      }
      setIsCompactQueryOpen(false);
      setCompactQuery("");
      return;
    }

    try {
      setIsCompactReplyLoading(true);
      setCompactReply(null);

      const response = await executeChatTurn({
        model: resolvedModel,
        messages: [{ role: "user", content: draft }],
      });

      setCompactReply({
        question: draft,
        answer: response.content,
      });
      setIsCompactQueryOpen(false);
      setCompactQuery("");
    } catch (err) {
      setCompactReply({
        question: draft,
        answer: err instanceof Error ? err.message : "鏌ヨ澶辫触",
      });
    } finally {
      setIsCompactReplyLoading(false);
    }
  }, [compactQuery, currentModel]);

  const handleCompactWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (compactAppearance !== "character") {
      return;
    }
    e.preventDefault();
    setCharacterScale((value) => clampCharacterScale(value + (e.deltaY < 0 ? 0.08 : -0.08)));
  }, [compactAppearance]);

  const handleCompactAppearanceChange = useCallback((appearance: CompactAppearance) => {
    setCompactAppearance(appearance);
    setIsCharacterMenuPinned(false);
    setIsCompactMenuOpen(false);
    setIsCompactModelOpen(false);
    setIsCompactAppearanceOpen(false);
    setIsCharacterModelOpen(false);
  }, []);

  const handleCharacterModelChange = useCallback((model: CharacterModel) => {
    setCharacterModel(model);
    setIsCharacterMenuPinned(false);
    setIsCompactMenuOpen(false);
    setIsCompactModelOpen(false);
    setIsCompactAppearanceOpen(false);
    setIsCharacterModelOpen(false);
  }, []);

  const handleCompactScaleReset = useCallback(() => {
    setCharacterScale(1);
    setIsCharacterMenuPinned(false);
    setIsCompactMenuOpen(false);
    setIsCompactModelOpen(false);
    setIsCompactAppearanceOpen(false);
    setIsCharacterModelOpen(false);
  }, []);

  const applyUsageToSession = useCallback((sessionId: string, result: ChatExecutionResult, conversationMessages: Message[]) => {
    const now = Date.now();
    setChatSessions((sessions) =>
      sessions.map((session) => {
        if (session.id !== sessionId) return session;
        return {
          ...session,
          title: getChatSessionTitle(conversationMessages),
          updatedAt: now,
          usage: {
            requestCount: session.usage.requestCount + 1,
            promptTokens: session.usage.promptTokens + result.usage.promptTokens,
            completionTokens: session.usage.completionTokens + result.usage.completionTokens,
            totalTokens: session.usage.totalTokens + result.usage.totalTokens,
            totalCostUsd: session.usage.totalCostUsd + result.costUsd,
            lastModel: result.model,
            lastUsedAt: now,
            hasEstimatedUsage: session.usage.hasEstimatedUsage || result.estimated,
          },
        };
      })
    );
  }, []);

  const runConversationTurn = useCallback(
    async (
      conversationMessages: Message[],
      options: { sessionId?: string | null; createSession?: boolean } = {}
    ) => {
      let sessionId = options.sessionId ?? activeChatId;
      if (!sessionId && options.createSession) {
        const nextSession = createChatSession(conversationMessages);
        sessionId = nextSession.id;
        setActiveChatId(nextSession.id);
        setChatSessions((sessions) => [nextSession, ...sessions]);
      }

      const runId = lastRunIdRef.current + 1;
      lastRunIdRef.current = runId;
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      setMessages([...conversationMessages, { role: "assistant", content: "" }]);
      setError(null);
      setIsLoading(true);

      try {
        const result = await executeChatTurn({
          model: currentModel,
          messages: conversationMessages,
          signal: abortController.signal,
          onChunk: (chunk) => {
            if (runId !== lastRunIdRef.current || abortController.signal.aborted) return;
            setMessages((prev) => {
              const updated = [...prev];
              const lastIdx = updated.length - 1;
              if (lastIdx >= 0 && updated[lastIdx].role === "assistant") {
                updated[lastIdx] = {
                  ...updated[lastIdx],
                  content: updated[lastIdx].content + chunk,
                };
              }
              return updated;
            });
          },
        });

        if (runId !== lastRunIdRef.current) {
          return sessionId;
        }

        setMessages([...conversationMessages, { role: "assistant", content: result.content }]);
        if (sessionId) {
          applyUsageToSession(sessionId, result, conversationMessages);
        }

        return sessionId;
      } catch (err: any) {
        if (runId !== lastRunIdRef.current) {
          return sessionId;
        }

        if (err instanceof DOMException && err.name === "AbortError") {
          setMessages((prev) => prev.filter((message, index) => index < conversationMessages.length || message.content));
          return sessionId;
        }

        const errorMessage = err instanceof Error ? err.message : "未知错误";
        setError(errorMessage);
        setMessages(conversationMessages);
        return sessionId;
      } finally {
        if (runId === lastRunIdRef.current) {
          abortControllerRef.current = null;
          setIsLoading(false);
        }
      }
    },
    [activeChatId, applyUsageToSession, currentModel]
  );

  const handleSend = useCallback(
    async (content: string, images?: string[]) => {
      if (isLoading) return;
      const localCommand = resolveLocalSlashCommand(content);
      if (localCommand && (!images || images.length === 0)) {
        if (localCommand.command === "/new") {
          setActiveChatId(null);
          setMessages([]);
          setError(null);
          setOpenChatMenu(null);
          setEditingMessageIndex(null);
          return;
        }
        if (localCommand.command === "/clear") {
          setMessages([]);
          setError(null);
          setEditingMessageIndex(null);
          return;
        }
        if (localCommand.command === "/settings") {
          setView("settings");
          return;
        }
      }

      const resolved = resolveSlashSkillPrompt(content);
      const resolvedUserMessage: Message = { role: "user", content: resolved.content, images };
      const nextMessages = [...messages, resolvedUserMessage];
      await runConversationTurn(nextMessages, { sessionId: activeChatId, createSession: true });
    },
    [activeChatId, isLoading, messages, runConversationTurn]
  );

  const handleStop = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsLoading(false);
  }, []);

  const handleCopyMessage = useCallback(async (message: Message) => {
    await navigator.clipboard?.writeText(message.content);
  }, []);

  const handleEditUserMessage = useCallback(
    (messageIndex: number) => {
      if (isLoading) return;
      const targetMessage = messages[messageIndex];
      if (!targetMessage || targetMessage.role !== "user") return;

      setEditingMessageIndex(messageIndex);
      setError(null);
    },
    [isLoading, messages]
  );

  const handleCancelEditUserMessage = useCallback(() => {
    setEditingMessageIndex(null);
  }, []);

  const handleSubmitEditedUserMessage = useCallback(
    async (messageIndex: number, content: string) => {
      if (isLoading) return;
      const targetMessage = messages[messageIndex];
      if (!targetMessage || targetMessage.role !== "user" || !content.trim()) return;

      const conversationMessages = [
        ...messages.slice(0, messageIndex),
        { ...targetMessage, content: content.trim() },
      ];
      setEditingMessageIndex(null);
      await runConversationTurn(conversationMessages, { sessionId: activeChatId });
    },
    [activeChatId, isLoading, messages, runConversationTurn]
  );

  const handleRegenerateMessage = useCallback(
    async (messageIndex: number) => {
      if (isLoading) return;
      const targetMessage = messages[messageIndex];
      if (!targetMessage || targetMessage.role !== "assistant") return;

      const conversationMessages = messages.slice(0, messageIndex);
      if (!conversationMessages.some((message) => message.role === "user")) return;
      await runConversationTurn(conversationMessages, { sessionId: activeChatId });
    },
    [activeChatId, isLoading, messages, runConversationTurn]
  );

  const handleClearChat = useCallback(() => {
    setMessages([]);
    setError(null);
    setEditingMessageIndex(null);
  }, []);

  const handleUseEmptyPrompt = useCallback((prompt: string) => {
    setInputDraft(prompt);
    setInputDraftImages([]);
    setInputDraftKey((value) => value + 1);
  }, []);

  const handleNewChat = useCallback(() => {
    setActiveChatId(null);
    setMessages([]);
    setError(null);
    setOpenChatMenu(null);
    setEditingMessageIndex(null);
  }, []);

  const handleSelectChat = useCallback(
    (sessionId: string) => {
      if (sessionId === activeChatId || isLoading) return;
      const session = chatSessions.find((item) => item.id === sessionId);
      if (!session) return;
      setActiveChatId(session.id);
      setMessages(session.messages);
      setError(null);
      setEditingMessageIndex(null);
    },
    [activeChatId, chatSessions, isLoading]
  );

  const handleRenameChat = useCallback((session: ChatSession) => {
    const nextTitle = window.prompt("重命名", session.title)?.trim();
    if (!nextTitle) return;
    setChatSessions((sessions) =>
      sessions.map((item) => (item.id === session.id ? { ...item, title: nextTitle } : item))
    );
    setOpenChatMenu(null);
  }, []);

  const handleTogglePinChat = useCallback((session: ChatSession) => {
    setChatSessions((sessions) =>
      sessions.map((item) => (item.id === session.id ? { ...item, pinned: !item.pinned } : item))
    );
    setOpenChatMenu(null);
  }, []);

  const handleShareChat = useCallback(async (session: ChatSession) => {
    const text = session.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
    if (text) {
      await navigator.clipboard?.writeText(text);
    }
    setOpenChatMenu(null);
  }, []);

  const handleDeleteChat = useCallback(
    (session: ChatSession) => {
      setChatSessions((sessions) => sessions.filter((item) => item.id !== session.id));
      if (session.id === activeChatId) {
        setActiveChatId(null);
        setMessages([]);
        setError(null);
        setEditingMessageIndex(null);
      }
      setOpenChatMenu(null);
    },
    [activeChatId]
  );

  const handleCompactDrag = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (isCharacterMenuPinned && !target.closest(".compact-menu") && !target.closest(".compact-menu-anchor")) {
      setIsCharacterMenuPinned(false);
      setIsCompactMenuOpen(false);
      setIsCompactModelOpen(false);
      setIsCompactAppearanceOpen(false);
      setIsCharacterModelOpen(false);
    }
    if (
      compactAppearance === "character" &&
      !target.closest(".compact-menu-anchor") &&
      !target.closest(".compact-query") &&
      !target.closest(".compact-reply")
    ) {
      setIsCompactQueryOpen(false);
      setCompactReply(null);
    }
    if (compactAppearance === "character") {
      return;
    }
    if (target.closest(".no-drag")) {
      return;
    }
    if (e.button === 0) {
      await appWindow.startDragging();
    }
  }, [compactAppearance, isCharacterMenuPinned]);

  const openCompactMenu = useCallback(() => {
    if (compactMenuCloseTimerRef.current !== null) {
      window.clearTimeout(compactMenuCloseTimerRef.current);
      compactMenuCloseTimerRef.current = null;
    }
    if (isCompactQueryOpen) {
      return;
    }
    setIsCompactMenuOpen(true);
    setIsCompactModelOpen(false);
    setIsCompactAppearanceOpen(false);
    setIsCharacterModelOpen(false);
    setIsCharacterMenuPinned(false);
    setIsCompactQueryOpen(false);
  }, [isCompactQueryOpen]);

  const closeCompactMenu = useCallback(() => {
    if (isCharacterMenuPinned) {
      return;
    }
    if (compactMenuCloseTimerRef.current !== null) {
      window.clearTimeout(compactMenuCloseTimerRef.current);
    }
    compactMenuCloseTimerRef.current = window.setTimeout(() => {
      closeCompactMenuPanels();
      compactMenuCloseTimerRef.current = null;
    }, COMPACT_MENU_CLOSE_DELAY_MS);
  }, [closeCompactMenuPanels, isCharacterMenuPinned]);

  const closeCompactMenuNow = useCallback(() => {
    if (compactMenuCloseTimerRef.current !== null) {
      window.clearTimeout(compactMenuCloseTimerRef.current);
      compactMenuCloseTimerRef.current = null;
    }
    setIsCharacterMenuPinned(false);
    closeCompactMenuPanels();
  }, [closeCompactMenuPanels]);

  useEffect(() => {
    if (!isCompactWindow || isCharacterAppearance || isCharacterMenuPinned || !isCompactMenuOpen) return;

    const isPointInsideInteractiveArea = (x: number, y: number) => {
      const selectors = [".compact-bar", ".compact-menu", ".compact-submenu", ".compact-search-popover"];
      const padding = 8;

      return selectors.some((selector) =>
        Array.from(document.querySelectorAll<HTMLElement>(selector)).some((element) => {
          const rect = element.getBoundingClientRect();
          return x >= rect.left - padding && x <= rect.right + padding && y >= rect.top - padding && y <= rect.bottom + padding;
        })
      );
    };

    const scheduleCloseIfOutside = (event: MouseEvent) => {
      if (isPointInsideInteractiveArea(event.clientX, event.clientY)) {
        if (compactMenuCloseTimerRef.current !== null) {
          window.clearTimeout(compactMenuCloseTimerRef.current);
          compactMenuCloseTimerRef.current = null;
        }
        return;
      }

      closeCompactMenu();
    };

    window.addEventListener("mousemove", scheduleCloseIfOutside);
    window.addEventListener("mouseleave", closeCompactMenuNow);
    window.addEventListener("blur", closeCompactMenuNow);
    document.addEventListener("visibilitychange", closeCompactMenuNow);
    return () => {
      window.removeEventListener("mousemove", scheduleCloseIfOutside);
      window.removeEventListener("mouseleave", closeCompactMenuNow);
      window.removeEventListener("blur", closeCompactMenuNow);
      document.removeEventListener("visibilitychange", closeCompactMenuNow);
    };
  }, [closeCompactMenu, closeCompactMenuNow, isCharacterAppearance, isCharacterMenuPinned, isCompactMenuOpen]);

  useEffect(() => {
    if (!isCompactWindow || !isCharacterMenuPinned || !isCompactMenuOpen) return;

    const closeOnBlur = () => closeCompactMenuNow();
    const closeOnVisibilityChange = () => closeCompactMenuNow();
    window.addEventListener("blur", closeOnBlur);
    window.addEventListener("mouseleave", closeOnBlur);
    document.addEventListener("visibilitychange", closeOnVisibilityChange);
    return () => {
      window.removeEventListener("blur", closeOnBlur);
      window.removeEventListener("mouseleave", closeOnBlur);
      document.removeEventListener("visibilitychange", closeOnVisibilityChange);
    };
  }, [closeCompactMenuNow, isCharacterMenuPinned, isCompactMenuOpen]);

  const handleCharacterContextMenu = useCallback(async (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (characterDragTimerRef.current !== null) {
      window.clearTimeout(characterDragTimerRef.current);
      characterDragTimerRef.current = null;
    }
    isCharacterDraggingRef.current = false;
    if (compactMenuCloseTimerRef.current !== null) {
      window.clearTimeout(compactMenuCloseTimerRef.current);
      compactMenuCloseTimerRef.current = null;
    }
    const nextSide = await resolveCharacterPanelSide();
    setCharacterPanelSide(nextSide);
    const scaleFactor = await appWindow.scaleFactor();
    const currentSize = (await appWindow.outerSize()).toLogical(scaleFactor);
    const expandedSize = getExpandedCompactViewportSizeForAppearance(compactAppearance, effectiveCompactScale, {
      includeReply: false,
      includeHorizontalPanel: false,
    });
    const expandedDelta = Math.max(0, expandedSize.width - currentSize.width);
    const menuWidth = 176;
    const menuHeight = 260;
    const futureMouseX = nextSide === "left" ? e.clientX + expandedDelta : e.clientX;
    setCharacterMenuPosition({
      x: Math.max(8, Math.min(futureMouseX, expandedSize.width - menuWidth - 8)),
      y: Math.max(8, Math.min(e.clientY, Math.max(window.innerHeight, expandedSize.height) - menuHeight - 8)),
    });
    setIsCompactMenuOpen(true);
    setIsCompactModelOpen(false);
    setIsCompactAppearanceOpen(false);
    setIsCharacterModelOpen(false);
    setIsCharacterMenuPinned(true);
    setIsCompactQueryOpen(false);
  }, [compactAppearance, effectiveCompactScale, resolveCharacterPanelSide]);

  const availableModels = modelRegistry.getAvailableModels();
  const hasModels = availableModels.length > 0;
  const groupedChatSessions = useMemo(() => {
    const groups = new Map<string, ChatSession[]>();
    [...chatSessions]
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt)
      .forEach((session) => {
        const label = session.pinned ? "置顶" : getChatSessionGroupLabel(session.updatedAt);
        groups.set(label, [...(groups.get(label) ?? []), session]);
      });

    return Array.from(groups.entries()).map(([label, sessions]) => ({ label, sessions }));
  }, [chatSessions]);
  const activeSession = useMemo(
    () => chatSessions.find((session) => session.id === activeChatId) ?? null,
    [activeChatId, chatSessions]
  );
  const lastMessage = messages[messages.length - 1];
  const isStreaming = isLoading && lastMessage?.role === "assistant";

  if (isCompactWindow) {
    return (
      <div
        className={`compact-shell drag-region ${
          isCharacterHorizontalPanelOpen && characterPanelSide === "left" ? "compact-shell--reply-left" : ""
        }`}
        onMouseDownCapture={(e) => {
          const target = e.target as HTMLElement;
          if (isCharacterAppearance) {
            const isInsideFloatingPanel = Boolean(
              target.closest(".compact-query") ||
              target.closest(".compact-reply") ||
              target.closest(".compact-menu") ||
              target.closest(".compact-submenu")
            );
            const hasFloatingPanel = Boolean(isCompactMenuOpen || isCompactQueryOpen || isCompactReplyLoading || compactReply);
            if (hasFloatingPanel && !isInsideFloatingPanel) {
              e.preventDefault();
              e.stopPropagation();
              closeCompactMenuNow();
              setIsCompactQueryOpen(false);
              setCompactReply(null);
              setIsCompactReplyLoading(false);
            }
            return;
          }
          if (!target.closest(".compact-hover-zone") && !target.closest(".compact-query") && !target.closest(".compact-reply")) {
            closeCompactMenuNow();
          }
        }}
        onMouseDown={handleCompactDrag}
        onWheel={handleCompactWheel}
      >
        <div
          className={`compact-hover-zone ${isCharacterAppearance ? "compact-hover-zone--character" : ""}`}
          onMouseEnter={!isCharacterAppearance && !isCompactQueryOpen && basicSettings.menuOpenMode === "hover" ? openCompactMenu : undefined}
          onMouseLeave={!isCharacterAppearance && !isCompactQueryOpen ? closeCompactMenu : undefined}
          onClick={!isCharacterAppearance && !isCompactQueryOpen && basicSettings.menuOpenMode === "click" ? (e) => {
            const target = e.target as HTMLElement;
            if (!target.closest("button")) {
              openCompactMenu();
            }
          } : undefined}
        >
          <div
            className={`compact-bar ${isCharacterAppearance ? "compact-bar--character" : ""}`}
            style={compactStyle}
          >
          <div
            className="compact-menu-anchor no-drag"
            onMouseEnter={undefined}
            onMouseLeave={undefined}
            onContextMenu={isCharacterAppearance ? handleCharacterContextMenu : undefined}
          >
            <button
              type="button"
              className={`compact-button compact-button--brand ${isCharacterAppearance ? "compact-button--character" : ""}`}
              onMouseDown={isCharacterAppearance ? handleCharacterPointerDown : (e) => e.stopPropagation()}
              onMouseMove={isCharacterAppearance ? (e) => {
                e.currentTarget.style.cursor = isCharacterPointerInHitArea(e.currentTarget, e.clientX, e.clientY) ? "grab" : "default";
              } : undefined}
              onMouseUp={isCharacterAppearance ? handleCharacterPointerUp : undefined}
              onMouseLeave={isCharacterAppearance ? (e) => {
                e.currentTarget.style.cursor = "default";
                handleCharacterPointerUp();
              } : undefined}
              onClick={(e) => {
                if (isCharacterAppearance) {
                  const isInCharacterHitArea = isCharacterPointerInHitArea(e.currentTarget, e.clientX, e.clientY);
                  if (!isInCharacterHitArea || isCharacterDraggingRef.current) {
                    return;
                  }
                  void handleOpenCompactQuery();
                  return;
                }
                void handleToggleMainFromCompact();
              }}
              aria-label="切换主页面"
            >
              {isCharacterAppearance ? (
                <Live2DCharacter
                  key={characterModel}
                  width={Math.max(48, compactSize.width - 18)}
                  height={Math.max(72, compactSize.height - 34)}
                  model={characterModel}
                />
              ) : (
                <img src={omniSmallIconSrc} alt="Omni" className="compact-button__icon" />
              )}
            </button>

            {isCompactMenuOpen && (
              <div
                className={`compact-menu animate-fade-in ${isCharacterAppearance && characterMenuPosition ? "compact-menu--cursor" : ""}`}
                style={isCharacterAppearance && characterMenuPosition ? { left: characterMenuPosition.x, top: characterMenuPosition.y } : undefined}
              >
                <div className="compact-menu__section">
                  <button
                    type="button"
                    className="compact-menu__item compact-menu__item--branch"
                    onMouseDown={(e) => e.stopPropagation()}
                    onMouseEnter={() => {
                      setIsCompactModelOpen(true);
                      setIsCompactAppearanceOpen(false);
                      setIsCharacterModelOpen(false);
                    }}
                  >
                  <span>聊天入口</span>
                    <span className="compact-menu__arrow">{">"}</span>
                  </button>

                  {false && isCharacterAppearance && (
                    <button
                      type="button"
                      className="compact-menu__item compact-menu__item--branch"
                      onMouseDown={(e) => e.stopPropagation()}
                      onMouseEnter={() => {
                        setIsCharacterModelOpen(true);
                        setIsCompactAppearanceOpen(false);
                      }}
                    >
                  <span>角色模型</span>
                      <span className="compact-menu__arrow">{">"}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    className="compact-menu__item compact-menu__item--branch"
                    onMouseDown={(e) => e.stopPropagation()}
                    onMouseEnter={() => {
                      setIsCompactModelOpen(false);
                      setIsCompactAppearanceOpen(true);
                      setIsCharacterModelOpen(false);
                    }}
                  >
                    <span>界面外观</span>
                    <span className="compact-menu__arrow">{">"}</span>
                  </button>

                  {isCharacterAppearance && (
                    <button
                      type="button"
                      className="compact-menu__item"
                      onMouseDown={(e) => e.stopPropagation()}
                      onMouseEnter={() => {
                        setIsCompactModelOpen(false);
                        setIsCompactAppearanceOpen(false);
                        setIsCharacterModelOpen(false);
                      }}
                      onClick={handleCompactScaleReset}
                    >
                  <span>重置缩放</span>
                      <span className="compact-menu__meta">{(characterScale * 100).toFixed(0)}%</span>
                    </button>
                  )}

                  <button
                    type="button"
                    className="compact-menu__item compact-menu__item--settings"
                    onMouseDown={(e) => e.stopPropagation()}
                    onMouseEnter={() => {
                      setIsCompactModelOpen(false);
                      setIsCompactAppearanceOpen(false);
                      setIsCharacterModelOpen(false);
                    }}
                    onClick={() => {
                      void handleOpenSettingsFromCompact();
                    }}
                  >
                    <svg className="compact-menu__settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                      <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" strokeWidth="1.8" strokeLinecap="round" />
                      <path
                        d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.04.04a2.1 2.1 0 0 1-2.97 2.97l-.04-.04A1.8 1.8 0 0 0 14.8 19.6a1.8 1.8 0 0 0-1.08 1.65V21.3a2.1 2.1 0 0 1-4.2 0v-.06A1.8 1.8 0 0 0 8.45 19.6a1.8 1.8 0 0 0-1.98.36l-.04.04a2.1 2.1 0 0 1-2.97-2.97l.04-.04A1.8 1.8 0 0 0 3.86 15a1.8 1.8 0 0 0-1.65-1.08H2.15a2.1 2.1 0 0 1 0-4.2h.06A1.8 1.8 0 0 0 3.86 8.65a1.8 1.8 0 0 0-.36-1.98l-.04-.04a2.1 2.1 0 0 1 2.97-2.97l.04.04a1.8 1.8 0 0 0 1.98.36A1.8 1.8 0 0 0 9.53 2.4V2.35a2.1 2.1 0 0 1 4.2 0v.06a1.8 1.8 0 0 0 1.08 1.65 1.8 1.8 0 0 0 1.98-.36l.04-.04a2.1 2.1 0 0 1 2.97 2.97l-.04.04a1.8 1.8 0 0 0-.36 1.98 1.8 1.8 0 0 0 1.65 1.08h.06a2.1 2.1 0 0 1 0 4.2h-.06A1.8 1.8 0 0 0 19.4 15Z"
                        strokeWidth="1.35"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span>设置</span>
                  </button>
                </div>

                {isCompactModelOpen && (
                  <div
                    className="compact-submenu animate-fade-in"
                    onMouseEnter={() => {
                      setIsCompactModelOpen(true);
                      setIsCompactAppearanceOpen(false);
                      setIsCharacterModelOpen(false);
                    }}
                  >
                  <div className="compact-menu__label">聊天入口</div>
                    {EXTERNAL_CHAT_ENTRIES.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        className="compact-menu__item"
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => {
                          void handleOpenExternalChat(entry);
                        }}
                      >
                        <span>{entry.title}</span>
                        <span className="compact-menu__meta">{entry.kind === "main" ? "主界面" : "应用内打开"}</span>
                      </button>
                    ))}
                  </div>
                )}

                {isCompactAppearanceOpen && (
                  <div
                    className="compact-submenu animate-fade-in"
                    onMouseEnter={() => {
                      setIsCompactModelOpen(false);
                      setIsCompactAppearanceOpen(true);
                    }}
                  >
                    <div className="compact-menu__label">紧凑外观</div>
                    {COMPACT_APPEARANCE_OPTIONS.map((option) =>
                      option.id === "character" ? (
                        <button
                          key={option.id}
                          type="button"
                          className={`compact-menu__item compact-menu__item--branch ${
                            compactAppearance === option.id ? "compact-menu__item--active" : ""
                          }`}
                          onMouseDown={(e) => e.stopPropagation()}
                          onMouseEnter={() => {
                            setIsCompactModelOpen(false);
                            setIsCharacterModelOpen(true);
                          }}
                          onClick={() => {
                            if (compactAppearance !== "character") {
                              handleCompactAppearanceChange("character");
                              window.setTimeout(() => {
                                setIsCompactMenuOpen(true);
                                setIsCompactAppearanceOpen(true);
                                setIsCharacterModelOpen(true);
                                setIsCharacterMenuPinned(true);
                              }, 0);
                              return;
                            }
                            setIsCharacterModelOpen(true);
                          }}
                        >
                          <span>{option.title}</span>
                          <span className="compact-menu__meta">{option.description}</span>
                          <span className="compact-menu__arrow">{">"}</span>
                        </button>
                      ) : (
                        <button
                          key={option.id}
                          type="button"
                          className={`compact-menu__item ${compactAppearance === option.id ? "compact-menu__item--active" : ""}`}
                          onMouseDown={(e) => e.stopPropagation()}
                          onMouseEnter={() => {
                            setIsCompactModelOpen(false);
                            setIsCharacterModelOpen(false);
                          }}
                          onClick={() => handleCompactAppearanceChange(option.id)}
                        >
                          <span>{option.title}</span>
                          <span className="compact-menu__meta">{option.description}</span>
                        </button>
                      )
                    )}
                  </div>
                )}

                {isCompactAppearanceOpen && isCharacterModelOpen && (
                  <div
                    className="compact-submenu animate-fade-in"
                    style={{ left: "calc(100% + 192px)" }}
                    onMouseEnter={() => {
                      setIsCompactModelOpen(false);
                      setIsCharacterModelOpen(true);
                      setIsCompactAppearanceOpen(true);
                    }}
                  >
                  <div className="compact-menu__label">角色模型</div>
                    {CHARACTER_MODEL_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`compact-menu__item ${characterModel === option.id ? "compact-menu__item--active" : ""}`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => handleCharacterModelChange(option.id)}
                      >
                        <span>{option.title}</span>
                        <span className="compact-menu__meta">{option.description}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {isCharacterAppearance && isCompactQueryOpen && (
              <div className="compact-query animate-fade-in no-drag" onMouseDown={(e) => e.stopPropagation()}>
                <div className="compact-query__row">
                  <button type="button" className="compact-query__preset" onClick={() => setCompactQuery("默认查询")}>
                    默认查询
                  </button>
                  <input
                    type="text"
                    value={compactQuery}
                    onChange={(e) => setCompactQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && e.altKey) {
                        e.preventDefault();
                        void handleCompactQuerySubmit(true);
                        return;
                      }
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void handleCompactQuerySubmit(false);
                      }
                    }}
                    placeholder="请输入查询内容"
                    className="compact-query__input"
                    autoFocus
                  />
                  <button type="button" className="compact-query__preset" onClick={() => void handleCompactQuerySubmit(false)}>
                    发送
                  </button>
                </div>
                <div className="compact-query__hint">回车在角色旁回答，Alt+回车切到主窗口</div>
              </div>
            )}

            {isCharacterAppearance && (isCompactReplyLoading || compactReply) && (
              <div className={`compact-reply ${characterPanelSide === "right" ? "compact-reply--right" : ""} animate-fade-in no-drag`} onMouseDown={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="compact-reply__close"
                  onClick={() => {
                    setCompactReply(null);
                    setIsCompactReplyLoading(false);
                  }}
                  aria-label="关闭回答"
                >
                  ×
                </button>
                {isCompactReplyLoading ? (
                  <div className="compact-reply__summary">正在回答...</div>
                ) : (
                  <>
                    <div className="compact-reply__summary">
                      {compactReply?.answer.length && compactReply.answer.length > 84
                        ? `${compactReply.answer.slice(0, 84)}...`
                        : compactReply?.answer}
                    </div>
                    {compactReply && (
                      <div className="compact-reply__full">
                        <div className="compact-reply__qa compact-reply__qa--question">你：{compactReply.question}</div>
                        <div className="compact-reply__qa">角色：{compactReply.answer}</div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {!isCharacterAppearance && (
            isCompactQueryOpen ? (
              <div className="compact-search-popover no-drag" onMouseDown={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="compact-query__preset compact-query__preset--inline"
                  onClick={() => setCompactQuery("默认查询")}
                >
                  默认查询
                </button>
                <input
                  type="text"
                  value={compactQuery}
                  onChange={(e) => setCompactQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setIsCompactQueryOpen(false);
                      return;
                    }
                    if (e.key === "Enter" && e.altKey) {
                      e.preventDefault();
                      void handleCompactQuerySubmit(true);
                      setIsCompactQueryOpen(false);
                      return;
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void handleCompactQuerySubmit(false);
                      setIsCompactQueryOpen(false);
                    }
                  }}
                  placeholder="请输入查询内容"
                  className="compact-search-popover__input"
                  autoFocus
                />
                <button
                  type="button"
                  className="compact-query__preset compact-query__preset--inline"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    void handleCompactQuerySubmit(false);
                    setIsCompactQueryOpen(false);
                  }}
                >
                  发送
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="compact-button compact-button--search-chip no-drag"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => {
                  void handleOpenCompactQuery();
                }}
                aria-label="打开搜索"
              >
                <svg className="compact-button__search" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <circle cx="11" cy="11" r="6.5" strokeWidth="1.8" />
                  <path d="M16 16L21 21" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            )
          )}

          {!isCharacterAppearance && (isCompactReplyLoading || compactReply) && (
            <div className="compact-reply compact-reply--inline animate-fade-in no-drag" onMouseDown={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="compact-reply__close"
                onClick={() => {
                  setCompactReply(null);
                  setIsCompactReplyLoading(false);
                }}
                aria-label="关闭回答"
              >
                ×
              </button>
              {isCompactReplyLoading ? (
                <div className="compact-reply__summary">正在回答...</div>
              ) : (
                <>
                  <div className="compact-reply__summary">
                    {compactReply?.answer.length && compactReply.answer.length > 84
                      ? `${compactReply.answer.slice(0, 84)}...`
                      : compactReply?.answer}
                  </div>
                  {compactReply && (
                    <div className="compact-reply__full">
                      <div className="compact-reply__qa compact-reply__qa--question">你：{compactReply.question}</div>
                      <div className="compact-reply__qa">Omni：{compactReply.answer}</div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell glass flex flex-col h-screen w-screen overflow-hidden">
      <TitleBar onMinimizeToCompact={handleOpenCompact} minimizeBehavior={basicSettings.minimizeBehavior} />

      {view === "chat" ? (
        <div className="main-chat-layout">
          <aside className="chat-history-panel">
            <button
              type="button"
              className={`chat-history-panel__new ${!activeChatId && messages.length === 0 ? "chat-history-panel__new--active" : ""}`}
              onClick={handleNewChat}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <circle cx="12" cy="12" r="7" strokeWidth="1.7" />
                <path d="M12 8.5v7M8.5 12h7" strokeWidth="1.7" strokeLinecap="round" />
              </svg>
              <span>开启新对话</span>
            </button>
            <div className="chat-history-panel__list hide-scrollbar">
              {groupedChatSessions.map((group) => (
                <section key={group.label} className="chat-history-panel__group">
                  <div className="chat-history-panel__group-label">{group.label}</div>
                  {group.sessions.map((session) => (
                    <div key={session.id} className="chat-history-panel__item-wrap">
                      <button
                        type="button"
                        className={`chat-history-panel__item ${session.id === activeChatId ? "chat-history-panel__item--active" : ""}`}
                        onClick={() => {
                          setOpenChatMenu(null);
                          handleSelectChat(session.id);
                        }}
                      >
                        <span className="chat-history-panel__title">{session.title}</span>
                        <span className="chat-history-panel__meta">{formatUsageLabel(session.usage)}</span>
                      </button>
                      <button
                        type="button"
                        className="chat-history-panel__more"
                        onClick={(event) => {
                          event.stopPropagation();
                          const rect = event.currentTarget.getBoundingClientRect();
                          setOpenChatMenu((value) =>
                            value?.id === session.id ? null : { id: session.id, x: rect.right + 8, y: rect.top - 6 }
                          );
                        }}
                        aria-label="会话操作"
                      >
                        ...
                      </button>
                      {openChatMenu?.id === session.id && (
                        <div className="chat-history-panel__menu" style={{ left: openChatMenu.x, top: openChatMenu.y }}>
                          <button type="button" onClick={() => handleRenameChat(session)}>
                            <span>✎</span>
                            <span>重命名</span>
                          </button>
                          <button type="button" onClick={() => handleTogglePinChat(session)}>
                            <span>⌖</span>
                            <span>{session.pinned ? "取消置顶" : "置顶"}</span>
                          </button>
                          <button type="button" onClick={() => void handleShareChat(session)}>
                            <span>↗</span>
                            <span>分享</span>
                          </button>
                          <button type="button" className="chat-history-panel__menu-danger" onClick={() => handleDeleteChat(session)}>
                            <span>⌫</span>
                            <span>删除</span>
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </aside>
          <main className="main-chat-pane">
          <div className="main-chat-toolbar">
            <div className="main-chat-toolbar__session">
              <ModelSelector currentModel={currentModel} onModelChange={handleModelChange} />
              {activeSession && (
                <div className="main-chat-toolbar__usage">
                  <span>{formatUsageLabel(activeSession.usage)}</span>
                </div>
              )}
            </div>
            <div className="main-chat-toolbar__actions">
              {messages.length > 0 && (
                <button
                  onClick={handleClearChat}
                  className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
                  title="娓呯┖瀵硅瘽"
                  type="button"
                >
                  <svg className="w-3.5 h-3.5 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                </button>
              )}
              <button
                onClick={() => setView("settings")}
                className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
                title="璁剧疆"
                type="button"
              >
                <svg className="w-3.5 h-3.5 text-white/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            </div>
          </div>

          <div ref={messagesScrollRef} className="main-chat-scroll hide-scrollbar">
            {!hasModels && messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center px-6">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-violet-400 to-indigo-600 flex items-center justify-center mb-4 shadow-lg shadow-violet-500/30">
                  <img src={omniIconSrc} alt="Omni" className="w-7 h-7" />
                </div>
                <h3 className="text-sm font-medium text-white/70 mb-1">欢迎使用 Omni</h3>
                <p className="text-xs text-white/30 mb-4">请先配置一个模型提供方，再开始对话</p>
                <button
                  onClick={() => setView("settings")}
                  className="px-4 py-2 text-xs font-medium rounded-lg bg-gradient-to-r from-violet-500 to-indigo-600 text-white hover:from-violet-400 hover:to-indigo-500 transition-all shadow-lg shadow-violet-500/20"
                  type="button"
                >
                  打开设置
                </button>
              </div>
            )}

            {false && hasModels && messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center px-6">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-violet-400/20 to-indigo-600/20 flex items-center justify-center mb-3">
                  <img src={omniIconSrc} alt="Omni" className="w-5 h-5" />
                </div>
                <p className="text-xs text-white/30">输入消息开始对话</p>
                <p className="text-[10px] text-white/15 mt-1">支持直接把图片粘贴到输入框</p>
              </div>
            )}

            {hasModels && messages.length === 0 && (
              <div className="empty-chat-state">
                <div className="empty-chat-state__hero">
                  <div className="empty-chat-state__icon">
                    <img src={omniIconSrc} alt="Omni" />
                  </div>
                  <h2>今天想处理什么？</h2>
                  <p>可以直接输入问题，也可以从下面选择一个起点。支持粘贴图片到输入框。</p>
                </div>
                <div className="empty-chat-state__prompts">
                  {EMPTY_CHAT_PROMPTS.map((prompt) => (
                    <button key={prompt} type="button" onClick={() => handleUseEmptyPrompt(prompt)}>
                      <span>{prompt}</span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                        <path d="M5 12h13M13 6l6 6-6 6" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, idx) => (
              <ChatMessage
                key={idx}
                message={msg}
                index={idx}
                isStreaming={isStreaming && idx === messages.length - 1}
                isEditing={editingMessageIndex === idx}
                onCopy={handleCopyMessage}
                onEdit={handleEditUserMessage}
                onCancelEdit={handleCancelEditUserMessage}
                onSubmitEdit={handleSubmitEditedUserMessage}
                onRegenerate={handleRegenerateMessage}
              />
            ))}

            {error && (
              <div className="animate-fade-in px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400/80">
                {error}
              </div>
            )}

          </div>

          <ChatInput
            onSend={handleSend}
            isLoading={isLoading}
            onStop={handleStop}
            focusSignal={inputFocusKey}
            draftValue={inputDraft}
            draftImages={inputDraftImages}
            draftSignal={inputDraftKey}
          />
          </main>
        </div>
      ) : (
        <SettingsPanel onClose={() => setView("chat")} onModelChange={handleModelChange} />
      )}
    </div>
  );
}

export default App;
