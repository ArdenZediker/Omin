import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const MAXIMIZED_CLASS = "omni-window-maximized";

function getSafeCurrentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export function useWindowRoundedCorners(enabled = true) {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") {
      return;
    }

    const appWindow = getSafeCurrentWindow();
    if (!appWindow) {
      return;
    }

    let unlistenResize: (() => void) | undefined;

    const syncClass = async () => {
      const isMaximized = await appWindow.isMaximized();
      if (isMaximized) {
        document.documentElement.classList.add(MAXIMIZED_CLASS);
      } else {
        document.documentElement.classList.remove(MAXIMIZED_CLASS);
      }
    };

    void syncClass();
    void appWindow
      .onResized(() => {
        void syncClass();
      })
      .then((unlisten) => {
        unlistenResize = unlisten;
      });

    return () => {
      unlistenResize?.();
      document.documentElement.classList.remove(MAXIMIZED_CLASS);
    };
  }, [enabled]);
}
