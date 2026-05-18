import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import {
  BASIC_SETTINGS_STORAGE_KEY,
  COMPACT_WINDOW_LABEL,
  CURRENT_MODEL_STORAGE_KEY,
  MAIN_VIEW_STORAGE_KEY,
  THEME_MODE_STORAGE_KEY,
  UNSET_SHORTCUT,
} from "../app/constants";
import type { BasicSettings, ViewMode } from "../app/types";
import { bootstrapSqliteStorage, readSqliteBackedValue, saveSqliteBackedValue } from "../app/sqliteStorage";
import { getPetWindowScale } from "../app/compactPetScale";
import { COMPACT_PET_HIDDEN_STORAGE_KEY, isCompactPetHidden } from "../app/compactVisibility";
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
      COMPACT_PET_HIDDEN_STORAGE_KEY,
      "omni_provider_configs",
      "omni_knowledge_embedding_profile",
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
    if (isCompactWindow || !appWindow) {
      return;
    }

    let cleanup: (() => void) | undefined;
    void appWindow.listen("omni-knowledge-embedding-profile-changed", () => {
      void bootstrapSqliteStorage(["omni_knowledge_embedding_profile"]);
    }).then((unlisten) => {
      cleanup = unlisten;
    });

    return () => {
      cleanup?.();
    };
  }, [isCompactWindow]);

  useEffect(() => {
    if (appWindow) {
      void (isCompactWindow ? applyCompactWindowChrome(appWindow) : applyExpandedWindowChrome(appWindow));
    }
    if (!isCompactWindow && appWindow) {
      const initialBasicSettings = getBasicSettings();
      if (initialBasicSettings.showCompactBall) {
        const storedAppearance = readSqliteBackedValue("omni_compact_appearance");
        const appearance: CompactAppearance = storedAppearance === "compact" || storedAppearance === "large" || storedAppearance === "pet" ? storedAppearance : "default";
        void showCompactWindow(
          appearance,
          appearance === "pet" && isCompactPetHidden() ? 1 : appearance === "pet" ? getPetWindowScale() : 1,
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

  useEffect(() => {
    if (isCompactWindow || !appWindow) {
      return;
    }

    const win = appWindow;
    saveSqliteBackedValue(MAIN_VIEW_STORAGE_KEY, view);
    const shouldResize = true;

    if (shouldResize) {
      const targetSize = getMainWindowSizeForView(view);
      void win.isMaximized().then((isMaximized) => {
        if (isMaximized) {
          return;
        }
        void resizeWindow(win, targetSize.width, targetSize.height);
      });
    }
  }, [
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
  }, [basicSettings.openMainShortcut, basicSettings.switchPreviousModelShortcut, isCompactWindow, onModelChange, previousModel, setView]);

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
      const normalizedAppearance: CompactAppearance =
        compactAppearance === "pet" ? "pet" : compactAppearance === "compact" || compactAppearance === "large" ? compactAppearance : "default";
      await showCompactWindow(
        normalizedAppearance,
        normalizedAppearance === "pet" && isCompactPetHidden() ? 1 : normalizedAppearance === "pet" ? getPetWindowScale() : 1,
        COMPACT_WINDOW_LABEL,
        { avoidMainWindowOverlap: false }
      );
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

    let unlisten: (() => void) | undefined;
    void listen<{ modelId?: string }>("omni-model-changed", (event) => {
      const modelId = event.payload?.modelId;
      if (!modelId) {
        return;
      }
      setCurrentModel(modelId);
      onModelChange(modelId);
    }).then((cleanup) => {
      unlisten = cleanup;
    });

    return () => {
      unlisten?.();
    };
  }, [isCompactWindow, onModelChange, setCurrentModel]);

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

