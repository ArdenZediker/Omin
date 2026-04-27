import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface TitleBarProps {
  onMinimizeToCompact: () => void | Promise<void>;
  minimizeBehavior?: "taskbar" | "compact";
}

const omniIconSrc = "/omni-mark-small.svg";

export default function TitleBar({ onMinimizeToCompact, minimizeBehavior = "taskbar" }: TitleBarProps) {
  const appWindow = getCurrentWindow();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
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

  const handleMinimize = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (minimizeBehavior === "compact") {
      await onMinimizeToCompact();
      return;
    }
    await appWindow.setSkipTaskbar(false);
    await appWindow.minimize();
  };

  const handleClose = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    await onMinimizeToCompact();
  };

  const handleToggleMaximize = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const nextIsMaximized = !(await appWindow.isMaximized());
    if (nextIsMaximized) {
      await appWindow.maximize();
    } else {
      await appWindow.unmaximize();
    }
    setIsMaximized(nextIsMaximized);
  };

  const handleDragStart = async (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest(".no-drag")) {
      return;
    }

    if (e.button === 0) {
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
          onMouseDown={(e) => e.stopPropagation()}
          className="w-5 h-5 rounded-md hover:bg-white/10 transition-colors flex items-center justify-center"
          title={minimizeBehavior === "compact" ? "收起到悬浮球" : "最小化到任务栏"}
          type="button"
        >
          <svg className="w-3 h-3 text-white/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>
        <button
          onClick={handleToggleMaximize}
          onMouseDown={(e) => e.stopPropagation()}
          className="w-5 h-5 rounded-md hover:bg-white/10 transition-colors flex items-center justify-center"
          title={isMaximized ? "还原" : "最大化"}
          type="button"
        >
          <svg className="w-3 h-3 text-white/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            {isMaximized ? (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"
              />
            ) : (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
              />
            )}
          </svg>
        </button>
        <button
          onClick={handleClose}
          onMouseDown={(e) => e.stopPropagation()}
          className="w-5 h-5 rounded-md hover:bg-red-500/15 transition-colors flex items-center justify-center"
          title="关闭到悬浮球"
          type="button"
        >
          <svg className="w-3 h-3 text-white/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
