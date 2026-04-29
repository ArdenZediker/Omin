import { useEffect, useState } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface TitleBarProps {
  onMinimizeToCompact: () => void | Promise<void>;
  inline?: boolean;
  minimizeBehavior?: "taskbar" | "compact";
}

function getSafeCurrentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export default function TitleBar({ onMinimizeToCompact, inline = false, minimizeBehavior = "taskbar" }: TitleBarProps) {
  const appWindow = getSafeCurrentWindow();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!appWindow) {
      return;
    }

    let unlistenResize: (() => void) | undefined;

    const syncMaximizedState = async () => {
      setIsMaximized(await appWindow.isMaximized());
    };

    void syncMaximizedState();
    void appWindow
      .onResized(() => {
        void syncMaximizedState();
      })
      .then((unlisten) => {
        unlistenResize = unlisten;
      });

    return () => {
      unlistenResize?.();
    };
  }, [appWindow]);

  const handleMinimize = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (minimizeBehavior === "compact") {
      await onMinimizeToCompact();
      return;
    }
    if (!appWindow) {
      return;
    }
    await appWindow.setSkipTaskbar(false);
    await appWindow.minimize();
  };

  const handleClose = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    await onMinimizeToCompact();
  };

  const handleToggleMaximize = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!appWindow) {
      return;
    }
    const nextIsMaximized = !(await appWindow.isMaximized());
    if (nextIsMaximized) {
      await appWindow.maximize();
    } else {
      await appWindow.unmaximize();
    }
    setIsMaximized(nextIsMaximized);
  };

  const handleDragStart = async (event: React.MouseEvent<HTMLDivElement>) => {
    if (!appWindow) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest(".no-drag")) {
      return;
    }

    if (event.button === 0) {
      await appWindow.startDragging();
    }
  };

  return (
    <div className={`omni-window-controls ${inline ? "omni-window-controls--inline" : "drag-region select-none"}`} onMouseDown={inline ? undefined : handleDragStart}>
      <div className="flex items-center gap-1 no-drag">
        <button
          onClick={handleMinimize}
          onMouseDown={(event) => event.stopPropagation()}
          className="omni-window-controls__button"
          title={minimizeBehavior === "compact" ? "收起到悬浮球" : "最小化到任务栏"}
          type="button"
        >
          <Minus className="omni-window-controls__icon" strokeWidth={1.7} />
        </button>
        <button
          onClick={handleToggleMaximize}
          onMouseDown={(event) => event.stopPropagation()}
          className="omni-window-controls__button"
          title={isMaximized ? "还原" : "最大化"}
          type="button"
        >
          {isMaximized ? (
            <Minimize2 className="omni-window-controls__icon" strokeWidth={1.7} />
          ) : (
            <Maximize2 className="omni-window-controls__icon" strokeWidth={1.7} />
          )}
        </button>
        <button
          onClick={handleClose}
          onMouseDown={(event) => event.stopPropagation()}
          className="omni-window-controls__button omni-window-controls__button--close"
          title="关闭到悬浮球"
          type="button"
        >
          <X className="omni-window-controls__icon" strokeWidth={1.7} />
        </button>
      </div>
    </div>
  );
}
