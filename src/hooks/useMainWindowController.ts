import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";
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
import { USAGE_PREFERENCES_STORAGE_KEY } from "../chat/storage";
import { ARTIFACTS_KEY, ARTIFACT_PANEL_STATE_KEY } from "../chat/artifacts";
import { resolveCurrentModelId } from "../chat/modelSelection";
import { getPetWindowScale } from "../app/compactPetScale";
import { COMPACT_PET_HIDDEN_STORAGE_KEY, isCompactPetHidden } from "../app/compactVisibility";
import { CHARACTER_SCALE_STORAGE_KEY, type CompactAppearance } from "./useCompactWindowState";
import {
  applyCompactWindowChrome,
  applyThemeFromStorage,
  getBasicSettings,
  getMainWindowSizeForView,
  getStoredMainPosition,
  isMainPositionVisible,
  normalizeShortcutKey,
  persistMainPosition,
  resizeWindow,
  restoreMainWindow,
  showCompactWindow,
} from "../app/window";
import type { Message, ChatImage } from "../adapters/types";

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
  setInputDraftImages: Dispatch<SetStateAction<ChatImage[]>>;
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
  const hasAppliedInitialMainGeometryRef = useRef(false);

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
      USAGE_PREFERENCES_STORAGE_KEY,
      "omni_knowledge_embedding_profile",
      CURRENT_MODEL_STORAGE_KEY,
      "omni_model_connection_status",
      "omni_basic_settings",
      "omni_compact_position",
      "omni_main_position",
      ARTIFACTS_KEY,
      ARTIFACT_PANEL_STATE_KEY,
      "omni_output_root_v1",
      "omni_mirror_sessions_md_v1",
    ]).then(() => {
      if (cancelled) return;
      applyThemeFromStorage();
      void loadProviderConfigs().then(() => {
        if (cancelled) return;
        setCurrentModel(
          resolveCurrentModelId({
            savedModelId: readSqliteBackedValue(CURRENT_MODEL_STORAGE_KEY),
            registryModelId: modelRegistry.getCurrentModel(),
            availableModels: modelRegistry.getAvailableModels(),
          })
        );
      });
    });

    const onThemeStorage = (event: StorageEvent) => {
      if (!event.key || event.key === THEME_MODE_STORAGE_KEY) {
        applyThemeFromStorage();
      }
    };
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onSystemThemeChange = () => applyThemeFromStorage();
    let usagePreferencesCleanup: (() => void) | undefined;
    void listen("omni-usage-preferences-changed", () => {
      void bootstrapSqliteStorage([USAGE_PREFERENCES_STORAGE_KEY]);
    }).then((cleanup) => {
      usagePreferencesCleanup = cleanup;
    });
    window.addEventListener("storage", onThemeStorage);
    media.addEventListener("change", onSystemThemeChange);
    return () => {
      cancelled = true;
      usagePreferencesCleanup?.();
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
    let compactStartupTimer: number | null = null;

    if (isCompactWindow && appWindow) {
      void applyCompactWindowChrome(appWindow);
    }
    if (!isCompactWindow && appWindow) {
      const initialBasicSettings = getBasicSettings();
      if (initialBasicSettings.showCompactBall) {
        // 等主窗口和 WebView 完成首屏初始化后再创建紧凑窗口，避免 Windows
        // 原生窗口属性调用与主窗口初始化同时发生导致 WebView2 卡死。
        compactStartupTimer = window.setTimeout(() => {
          const storedAppearance = readSqliteBackedValue("omni_compact_appearance");
          const appearance: CompactAppearance = storedAppearance === "compact" || storedAppearance === "large" || storedAppearance === "pet" ? storedAppearance : "default";
          void showCompactWindow(
            appearance,
            appearance === "pet" && isCompactPetHidden() ? 1 : appearance === "pet" ? getPetWindowScale() : 1,
            COMPACT_WINDOW_LABEL
          );
        }, 2000);
      }
    }

    return () => {
      if (compactStartupTimer !== null) {
        window.clearTimeout(compactStartupTimer);
      }
    };
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
    const targetSize = getMainWindowSizeForView(view);

    void (async () => {
      const isMaximized = await win.isMaximized();
      if (isMaximized) {
        return;
      }

      await resizeWindow(win, targetSize.width, targetSize.height);

      if (hasAppliedInitialMainGeometryRef.current) {
        return;
      }
      hasAppliedInitialMainGeometryRef.current = true;

      const settings = getBasicSettings();
      if (settings.mainWindowPositionMode === "remember") {
        const storedMainPos = getStoredMainPosition();
        if (storedMainPos && isMainPositionVisible(storedMainPos)) {
          await win.setPosition(new LogicalPosition(storedMainPos.x, storedMainPos.y));
          return;
        }
      }

      await win.center();
    })().catch(() => undefined);
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
        const payload = event.payload as { draft?: string; images?: ChatImage[] } | null;
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
        const next = { x: Math.round(pos.x), y: Math.round(pos.y) };
        // 透明无边框窗口创建瞬间会在 (0,0) 闪现并触发 moved，
        // 不要把这种退化坐标当作用户真实摆放持久化。
        if (next.x <= 0 && next.y <= 0) {
          return;
        }
        persistMainPosition(next);
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

  const handleRestoreMain = useCallback(async (focusInput = false, options?: { restoreGeometry?: boolean }) => {
    await restoreMainWindow(focusInput, options);
  }, []);

  const lastMessagesCountRef = useRef(messages.length);

  useEffect(() => {
    if (isCompactWindow || !appWindow) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void listen<{ modelId?: string }>("omni-model-changed", (event) => {
      void (async () => {
        await loadProviderConfigs();
        const resolvedModel = resolveCurrentModelId({
          savedModelId: event.payload?.modelId ?? readSqliteBackedValue(CURRENT_MODEL_STORAGE_KEY),
          registryModelId: modelRegistry.getCurrentModel(),
          availableModels: modelRegistry.getAvailableModels(),
        });
        if (!resolvedModel) {
          modelRegistry.setCurrentModel("");
          setCurrentModel("");
          return;
        }
        onModelChange(resolvedModel);
      })();
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
