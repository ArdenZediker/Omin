import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { COMPACT_APPEARANCE_OPTIONS, EXTERNAL_CHAT_ENTRIES } from "../app/constants";
import {
  COMPACT_MENU_WINDOW_BOOTSTRAP_READY_EVENT,
  COMPACT_MENU_WINDOW_CONFIG_KEY,
  COMPACT_MENU_WINDOW_RENDER_READY_EVENT,
  type CompactMenuWindowAction,
  type CompactMenuWindowShowPayload,
} from "../app/compactMenuWindow";
import { useThemeSync } from "../hooks/useThemeSync";
import CompactMenu from "./compact/CompactMenu";

const MENU_CLOSE_DELAY_MS = 220;

function emitMenuAction(action: CompactMenuWindowAction) {
  void emit("omni-compact-menu-action", action).catch(() => undefined);
}

function readMenuConfiguration(): CompactMenuWindowShowPayload | null {
  try {
    const raw = localStorage.getItem(COMPACT_MENU_WINDOW_CONFIG_KEY);
    return raw ? (JSON.parse(raw) as CompactMenuWindowShowPayload) : null;
  } catch {
    return null;
  }
}

export default function CompactMenuWindow() {
  useThemeSync(false);
  const [configuration, setConfiguration] = useState<CompactMenuWindowShowPayload | null>(readMenuConfiguration);
  const configurationRef = useRef<CompactMenuWindowShowPayload | null>(configuration);
  const hasFocusedRef = useRef(false);
  const [isCompactAppearanceOpen, setIsCompactAppearanceOpen] = useState(false);
  const [isCompactModelOpen, setIsCompactModelOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const focusCloseTimerRef = useRef<number | null>(null);
  const isPointerInsideRef = useRef(false);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const closeMenu = useCallback(() => {
    cancelClose();
    if (focusCloseTimerRef.current !== null) {
      window.clearTimeout(focusCloseTimerRef.current);
      focusCloseTimerRef.current = null;
    }
    emitMenuAction({ type: "close" });
    void getCurrentWindow().hide().catch(() => undefined);
  }, [cancelClose]);

  useEffect(() => {
    configurationRef.current = configuration;
  }, [configuration]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(closeMenu, MENU_CLOSE_DELAY_MS);
  }, [cancelClose, closeMenu]);

  const handleMouseEnter = useCallback(() => {
    isPointerInsideRef.current = true;
    cancelClose();
  }, [cancelClose]);

  const handleMouseLeave = useCallback(() => {
    if (!isPointerInsideRef.current) {
      return;
    }
    isPointerInsideRef.current = false;
    scheduleClose();
  }, [scheduleClose]);

  useEffect(() => {
    let disposed = false;
    let unlistenShow: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;

    void listen<CompactMenuWindowShowPayload>("omni-compact-menu-show", (event) => {
      cancelClose();
      hasFocusedRef.current = false;
      isPointerInsideRef.current = false;
      setConfiguration(event.payload);
      setIsCompactAppearanceOpen(false);
      setIsCompactModelOpen(false);
    }).then(async (unlistenShowListener) => {
      if (disposed) {
        unlistenShowListener();
        return;
      }
      unlistenShow = unlistenShowListener;
      await emit(COMPACT_MENU_WINDOW_BOOTSTRAP_READY_EVENT, {
        label: getCurrentWindow().label,
      }).catch(() => undefined);
    });

    void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        hasFocusedRef.current = true;
        if (focusCloseTimerRef.current !== null) {
          window.clearTimeout(focusCloseTimerRef.current);
          focusCloseTimerRef.current = null;
        }
        return;
      }
      if (hasFocusedRef.current && configurationRef.current) {
        hasFocusedRef.current = false;
        if (focusCloseTimerRef.current !== null) {
          window.clearTimeout(focusCloseTimerRef.current);
        }
        focusCloseTimerRef.current = window.setTimeout(() => {
          focusCloseTimerRef.current = null;
          void getCurrentWindow()
            .isFocused()
            .then((isFocused) => {
              if (!isFocused) {
                closeMenu();
              }
            })
            .catch(closeMenu);
        }, 320);
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenFocus = unlisten;
      }
    });

    return () => {
      disposed = true;
      cancelClose();
      if (focusCloseTimerRef.current !== null) {
        window.clearTimeout(focusCloseTimerRef.current);
        focusCloseTimerRef.current = null;
      }
      unlistenShow?.();
      unlistenFocus?.();
    };
  }, [cancelClose, closeMenu]);

  useEffect(() => {
    if (!configuration) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) {
        return;
      }
      void emit(COMPACT_MENU_WINDOW_RENDER_READY_EVENT, {
        renderId: configuration.renderId,
      }).catch(() => undefined);
    }, 40);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [configuration]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeMenu]);

  if (!configuration) {
    return <div className="compact-menu-window" />;
  }

  return (
    <div
      className="compact-menu-window"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <CompactMenu
        appearanceOptions={COMPACT_APPEARANCE_OPTIONS}
        menuPosition={configuration.menuPosition}
        isGeometryReady
        characterScale={configuration.characterScale}
        compactAppearance={configuration.compactAppearance}
        entries={EXTERNAL_CHAT_ENTRIES}
        isCompactAppearanceOpen={isCompactAppearanceOpen}
        isCompactModelOpen={isCompactModelOpen}
        compactMenuSide={configuration.menuSide}
        compactSubmenuSide={configuration.submenuSide}
        followCursorScreen={configuration.followCursorScreen}
        onCompactAppearanceChange={(appearance) => {
          emitMenuAction({ type: "appearance", appearance });
          closeMenu();
        }}
        onOpenExternalChat={(entry) => {
          emitMenuAction({ type: "external-chat", entryId: entry.id });
          closeMenu();
        }}
        onOpenSettingsFromCompact={() => {
          emitMenuAction({ type: "settings" });
          closeMenu();
        }}
        onScaleReset={() => {
          emitMenuAction({ type: "scale-reset" });
          closeMenu();
        }}
        onUpdateBasicSettings={(patch) => {
          if (typeof patch.followCursorScreen === "boolean") {
            setConfiguration((current) =>
              current ? { ...current, followCursorScreen: patch.followCursorScreen as boolean } : current
            );
          }
          emitMenuAction({ type: "update-basic-settings", patch });
        }}
        onSetIsCompactAppearanceOpen={setIsCompactAppearanceOpen}
        onSetIsCompactModelOpen={setIsCompactModelOpen}
      />
    </div>
  );
}
