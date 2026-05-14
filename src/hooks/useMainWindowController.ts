import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import {
  BASIC_SETTINGS_STORAGE_KEY,
  CHARACTER_SCALE_BASELINE,
  COMPACT_WINDOW_LABEL,
  CURRENT_MODEL_STORAGE_KEY,
  MAIN_VIEW_STORAGE_KEY,
  THEME_MODE_STORAGE_KEY,
  UNSET_SHORTCUT,
} from "../app/constants";
import type { BasicSettings, ViewMode } from "../app/types";
import { bootstrapSqliteStorage, readSqliteBackedValue, saveSqliteBackedValue } from "../app/sqliteStorage";
import { CHARACTER_SCALE_STORAGE_KEY, type CompactAppearance } from "./useCompactWindowState";
import {
  applyCompactWindowChrome,
  applyExpandedWindowChrome,
  applyThemeFromStorage,
  getBasicSettings,
  getMainWindowSizeForView,
  normalizeShortcutKey,
  persistMainPosition,
  resizeWindow,
  restoreMainWindow,
  showCompactWindow,
} from "../app/window";
import type { Message } from "../adapters/types";

function getSafeCurrentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

const appWindow = getSafeCurrentWindow();

type UseMainWindowControllerArgs = {
  basicSettings: BasicSettings;
  compactAppearance: CompactAppearance;
  effectiveCompactScale: number;
  isCompactWindow: boolean;
  messages: Message[];
  messagesScrollRef: RefObject<HTMLDivElement | null>;
  previousModel: string | null;
  setBasicSettings: Dispatch<SetStateAction<BasicSettings>>;
  setCurrentModel: Dispatch<SetStateAction<string>>;
  setInputDraft: Dispatch<SetStateAction<string>>;
  setInputDraftImages: Dispatch<SetStateAction<string[]>>;
  setInputDraftKey: Dispatch<SetStateAction<number>>;
  setInputFocusKey: Dispatch<SetStateAction<number>>;
  setView: Dispatch<SetStateAction<ViewMode>>;
  view: ViewMode;
  onModelChange: (modelId: string) => void;
};

export function useMainWindowController({
  basicSettings,
  compactAppearance,
  effectiveCompactScale,
  isCompactWindow,
  messages,
  messagesScrollRef,
  previousModel,
  setBasicSettings,
  setCurrentModel,
  setInputDraft,
  setInputDraftImages,
  setInputDraftKey,
  setInputFocusKey,
  setView,
  view,
  onModelChange,
}: UseMainWindowControllerArgs) {
  useEffect(() => {
    let cancelled = false;

    void bootstrapSqliteStorage([
      THEME_MODE_STORAGE_KEY,
      BASIC_SETTINGS_STORAGE_KEY,
      MAIN_VIEW_STORAGE_KEY,
      "omni_compact_appearance",
      CHARACTER_SCALE_STORAGE_KEY,
      "omni_character_model",
      "omni_provider_configs",
      CURRENT_MODEL_STORAGE_KEY,
      "omni_model_connection_status",
      "omni_basic_settings",
      "omni_compact_position",
      "omni_main_position",
    ]).then(() => {
      if (cancelled) return;
      applyThemeFromStorage();
      void loadProviderConfigs().then(() => {
        if (cancelled) return;
        setCurrentModel(modelRegistry.getCurrentModel());
      });
    });

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
      cancelled = true;
      window.removeEventListener("storage", onThemeStorage);
      media.removeEventListener("change", onSystemThemeChange);
    };
  }, []);

  useEffect(() => {
    if (appWindow) {
      void (isCompactWindow ? applyCompactWindowChrome(appWindow) : applyExpandedWindowChrome(appWindow));
    }
    if (!isCompactWindow && appWindow) {
      const initialBasicSettings = getBasicSettings();
      if (initialBasicSettings.showCompactBall) {
        const storedAppearance = readSqliteBackedValue("omni_compact_appearance");
        const appearance: CompactAppearance =
          storedAppearance === "compact" ||
          storedAppearance === "large" ||
          storedAppearance === "character" ||
          storedAppearance === "pet"
            ? storedAppearance
            : "default";
        const storedScale = Number(readSqliteBackedValue(CHARACTER_SCALE_STORAGE_KEY) || "1");
        const scale = Number.isFinite(storedScale) ? storedScale : 1;
        void showCompactWindow(
          appearance,
          appearance === "character" || appearance === "pet" ? scale * CHARACTER_SCALE_BASELINE : 1,
          COMPACT_WINDOW_LABEL
        );
      }
    }
  }, [isCompactWindow, setCurrentModel]);

  useEffect(() => {
    if (isCompactWindow || !appWindow) {
      return;
    }

    const onStorage = (event?: StorageEvent) => {
      if (!event || event.key === BASIC_SETTINGS_STORAGE_KEY) {
        setBasicSettings(getBasicSettings());
      }
    };

    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [isCompactWindow, setBasicSettings]);

  const previousViewRef = useRef<ViewMode | null>(null);
  const previousSettingsWindowSizeRef = useRef<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (isCompactWindow || !appWindow) {
      return;
    }

    const win = appWindow;
    const previousView = previousViewRef.current;
    const previousSettingsSize = previousSettingsWindowSizeRef.current;
    saveSqliteBackedValue(MAIN_VIEW_STORAGE_KEY, view);

    const isSettingsView = view === "settings";
    const settingsSizeChanged =
      !previousSettingsSize ||
      previousSettingsSize.width !== basicSettings.settingsWindowWidth ||
      previousSettingsSize.height !== basicSettings.settingsWindowHeight;
    const shouldResize = isSettingsView ? previousView !== "settings" || settingsSizeChanged : previousView === "settings";

    if (shouldResize) {
      const targetView = isSettingsView ? "settings" : "chat";
      const targetSize = getMainWindowSizeForView(targetView);
      void win.isMaximized().then((isMaximized) => {
        if (isMaximized) {
          return;
        }
        void resizeWindow(win, targetSize.width, targetSize.height);
      });
    }

    previousViewRef.current = view;
    if (isSettingsView) {
      previousSettingsWindowSizeRef.current = {
        width: basicSettings.settingsWindowWidth,
        height: basicSettings.settingsWindowHeight,
      };
    }
  }, [
    basicSettings.mainWindowHeight,
    basicSettings.mainWindowWidth,
    basicSettings.settingsWindowHeight,
    basicSettings.settingsWindowWidth,
    isCompactWindow,
    view,
  ]);

  useEffect(() => {
    if (isCompactWindow || !appWindow) {
      return;
    }
    const win = appWindow;

    let focusCleanup: (() => void) | undefined;
    let draftCleanup: (() => void) | undefined;
    let settingsCleanup: (() => void) | undefined;
    let knowledgeCleanup: (() => void) | undefined;
    let moveCleanup: (() => void) | undefined;

    void win
      .listen("omni-focus-input", () => {
        setInputFocusKey((value) => value + 1);
      })
      .then((unlisten) => {
        focusCleanup = unlisten;
      });

    void win
      .listen("omni-set-draft", (event) => {
        const payload = event.payload as { draft?: string; images?: string[] } | null;
        setInputDraft(payload?.draft ?? "");
        setInputDraftImages(payload?.images ?? []);
        setInputDraftKey((value) => value + 1);
      })
      .then((unlisten) => {
        draftCleanup = unlisten;
      });

    void win
      .listen("omni-open-settings", () => {
        setView("settings");
      })
      .then((unlisten) => {
        settingsCleanup = unlisten;
      });

    void win
      .listen("omni-open-knowledge", () => {
        setView("knowledge");
      })
      .then((unlisten) => {
        knowledgeCleanup = unlisten;
      });

    void win
      .onMoved(async (event) => {
        const scaleFactor = await win.scaleFactor();
        const pos = event.payload.toLogical(scaleFactor);
        persistMainPosition({ x: Math.round(pos.x), y: Math.round(pos.y) });
      })
      .then((unlisten) => {
        moveCleanup = unlisten;
      });

    return () => {
      focusCleanup?.();
      draftCleanup?.();
      settingsCleanup?.();
      knowledgeCleanup?.();
      moveCleanup?.();
    };
  }, [isCompactWindow, setInputDraft, setInputDraftImages, setInputDraftKey, setInputFocusKey, setView]);

  useEffect(() => {
    if (isCompactWindow) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = normalizeShortcutKey(event);
      if (!shortcut) {
        return;
      }

      if (basicSettings.openMainShortcut !== UNSET_SHORTCUT && shortcut === basicSettings.openMainShortcut) {
        event.preventDefault();
        setView("chat");
        saveSqliteBackedValue(MAIN_VIEW_STORAGE_KEY, "chat");
        void restoreMainWindow(false);
        return;
      }

      if (
        basicSettings.switchPreviousModelShortcut !== UNSET_SHORTCUT &&
        shortcut === basicSettings.switchPreviousModelShortcut &&
        previousModel
      ) {
        event.preventDefault();
        onModelChange(previousModel);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    basicSettings.openMainShortcut,
    basicSettings.switchPreviousModelShortcut,
    isCompactWindow,
    onModelChange,
    previousModel,
    setView,
  ]);

  useEffect(() => {
    if (isCompactWindow || basicSettings.openMainShortcut === UNSET_SHORTCUT) {
      return;
    }

    let registered = false;
    void register(basicSettings.openMainShortcut, () => {
      saveSqliteBackedValue(MAIN_VIEW_STORAGE_KEY, "chat");
      setView("chat");
      void restoreMainWindow(false);
    })
      .then(() => {
        registered = true;
      })
      .catch(() => {
        registered = false;
      });

    return () => {
      if (registered) {
        void unregister(basicSettings.openMainShortcut);
      }
    };
  }, [basicSettings.openMainShortcut, isCompactWindow, setView]);

  const handleOpenCompact = useCallback(async () => {
    if (basicSettings.showCompactBall) {
      await showCompactWindow(compactAppearance, effectiveCompactScale, COMPACT_WINDOW_LABEL);
    }
    if (appWindow) {
      await appWindow.hide();
    }
  }, [basicSettings.showCompactBall, compactAppearance, effectiveCompactScale]);

  const handleRestoreMain = useCallback(async (focusInput = false) => {
    await restoreMainWindow(focusInput);
  }, []);

  const lastMessagesCountRef = useRef(messages.length);

  useEffect(() => {
    if (isCompactWindow || !appWindow) {
      return;
    }

    const container = messagesScrollRef.current;
    if (!container) {
      return;
    }

    const previousCount = lastMessagesCountRef.current;
    const nextCount = messages.length;
    lastMessagesCountRef.current = nextCount;

    if (nextCount <= previousCount) {
      return;
    }

    container.scrollTo({ top: container.scrollHeight, behavior: "auto" });
  }, [isCompactWindow, messages.length, messagesScrollRef]);

  return {
    handleOpenCompact,
    handleRestoreMain,
  };
}
