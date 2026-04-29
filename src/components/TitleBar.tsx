import { useEffect, useState } from "react";
import { Maximize2, Minimize2, Minus, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface TitleBarProps {
  onMinimizeToCompact: () => void | Promise<void>;
  minimizeBehavior?: "taskbar" | "compact";
}

const omniIconSrc = "/omni-mark-small.svg";

function getSafeCurrentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export default function TitleBar({ onMinimizeToCompact, minimizeBehavior = "taskbar" }: TitleBarProps) {
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
    <div className="flex items-center justify-between h-9 px-3 drag-region select-none shrink-0" onMouseDown={handleDragStart}>
      <div className="flex items-center gap-2">
        <img src={omniIconSrc} alt="Omni" className="w-4 h-4" />
        <span className="text-xs font-semibold text-white/80 tracking-wider">OMNI</span>
      </div>

      <div className="flex items-center gap-1 no-drag">
        <button
          onClick={handleMinimize}
          onMouseDown={(event) => event.stopPropagation()}
          className="w-5 h-5 rounded-md hover:bg-white/10 transition-colors flex items-center justify-center"
          title={minimizeBehavior === "compact" ? "收起到悬浮球" : "最小化到任务栏"}
          type="button"
        >
          <Minus className="w-3 h-3 text-white/50" strokeWidth={2} />
        </button>
        <button
          onClick={handleToggleMaximize}
          onMouseDown={(event) => event.stopPropagation()}
          className="w-5 h-5 rounded-md hover:bg-white/10 transition-colors flex items-center justify-center"
          title={isMaximized ? "还原" : "最大化"}
          type="button"
        >
          {isMaximized ? (
            <Minimize2 className="w-3 h-3 text-white/50" strokeWidth={2} />
          ) : (
            <Maximize2 className="w-3 h-3 text-white/50" strokeWidth={2} />
          )}
        </button>
        <button
          onClick={handleClose}
          onMouseDown={(event) => event.stopPropagation()}
          className="w-5 h-5 rounded-md hover:bg-red-500/15 transition-colors flex items-center justify-center"
          title="关闭到悬浮球"
          type="button"
        >
          <X className="w-3 h-3 text-white/50" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
