import { useCallback, useEffect } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import {
  BASIC_SETTINGS_STORAGE_KEY,
  CHARACTER_SCALE_BASELINE,
  COMPACT_WINDOW_LABEL,
  MAIN_VIEW_STORAGE_KEY,
  THEME_MODE_STORAGE_KEY,
  UNSET_SHORTCUT,
} from "../app/constants";
import type { BasicSettings, ViewMode } from "../app/types";
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

const appWindow = getCurrentWindow();

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
    setCurrentModel(modelRegistry.getCurrentModel());

    if (!isCompactWindow) {
      const initialBasicSettings = getBasicSettings();
      if (initialBasicSettings.showCompactBall) {
        const storedAppearance = localStorage.getItem("omni_compact_appearance");
        const appearance: CompactAppearance =
          storedAppearance === "compact" || storedAppearance === "large" || storedAppearance === "character"
            ? storedAppearance
            : "default";
        const storedScale = Number(localStorage.getItem(CHARACTER_SCALE_STORAGE_KEY) || "1");
        const scale = Number.isFinite(storedScale) ? storedScale : 1;
        void showCompactWindow(
          appearance,
          appearance === "character" ? scale * CHARACTER_SCALE_BASELINE : 1,
          COMPACT_WINDOW_LABEL
        );
      }
      void appWindow.hide();
    }
  }, [isCompactWindow, setCurrentModel]);

  useEffect(() => {
    if (isCompactWindow) {
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

  useEffect(() => {
    if (isCompactWindow) {
      return;
    }

    const container = messagesScrollRef.current;
    if (!container) {
      return;
    }

    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [isCompactWindow, messages, messagesScrollRef]);

  useEffect(() => {
    if (isCompactWindow) {
      return;
    }

    localStorage.setItem(MAIN_VIEW_STORAGE_KEY, view);
    const targetSize = getMainWindowSizeForView(view);
    void resizeWindow(appWindow, targetSize.width, targetSize.height);
  }, [
    basicSettings.mainWindowHeight,
    basicSettings.mainWindowWidth,
    basicSettings.settingsWindowHeight,
    basicSettings.settingsWindowWidth,
    isCompactWindow,
    view,
  ]);

  useEffect(() => {
    if (isCompactWindow) {
      return;
    }

    let focusCleanup: (() => void) | undefined;
    let draftCleanup: (() => void) | undefined;
    let settingsCleanup: (() => void) | undefined;
    let moveCleanup: (() => void) | undefined;

    void appWindow
      .listen("omni-focus-input", () => {
        setInputFocusKey((value) => value + 1);
      })
      .then((unlisten) => {
        focusCleanup = unlisten;
      });

    void appWindow
      .listen("omni-set-draft", (event) => {
        const payload = event.payload as { draft?: string; images?: string[] } | null;
        setInputDraft(payload?.draft ?? "");
        setInputDraftImages(payload?.images ?? []);
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

    void appWindow
      .onMoved(async (event) => {
        const scaleFactor = await appWindow.scaleFactor();
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
        localStorage.setItem(MAIN_VIEW_STORAGE_KEY, "chat");
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
      localStorage.setItem(MAIN_VIEW_STORAGE_KEY, "chat");
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
    await appWindow.hide();
  }, [basicSettings.showCompactBall, compactAppearance, effectiveCompactScale]);

  const handleRestoreMain = useCallback(async (focusInput = false) => {
    await restoreMainWindow(focusInput);
  }, []);

  return {
    handleOpenCompact,
    handleRestoreMain,
  };
}
