import type { CSSProperties, Dispatch, MouseEvent, SetStateAction, WheelEvent } from "react";
import type { DesktopRuntimeSnapshot } from "../app/runtimeSnapshot";
import type { BasicSettings, CompactReply, ExternalChatEntry } from "../app/types";
import type { CharacterModel, CompactAppearance } from "../hooks/useCompactWindowState";
import Live2DCharacter from "./Live2DCharacter";
import CompactMenu from "./compact/CompactMenu";
import CompactQueryPanel from "./compact/CompactQueryPanel";
import CompactReplyPanel from "./compact/CompactReplyPanel";

type CompactWindowProps = {
  basicSettings: BasicSettings;
  characterMenuPosition: { x: number; y: number } | null;
  characterModel: CharacterModel;
  characterPanelSide: "left" | "right";
  characterScale: number;
  compactAppearance: CompactAppearance;
  isCharacterMenuPinned: boolean;
  compactQuery: string;
  compactReply: CompactReply | null;
  compactSize: { width: number; height: number };
  compactStyle: CSSProperties;
  entries: ExternalChatEntry[];
  isCharacterAppearance: boolean;
  isCharacterDragging: boolean;
  isCharacterHorizontalPanelOpen: boolean;
  isCompactAppearanceOpen: boolean;
  isCompactMenuOpen: boolean;
  isCompactModelOpen: boolean;
  isCompactQueryOpen: boolean;
  isCompactReplyLoading: boolean;
  isCharacterModelOpen: boolean;
  compactMenuSide: "left" | "right";
  compactSubmenuSide: "left" | "right";
  omniSmallIconSrc: string;
  appearanceOptions: Array<{ id: CompactAppearance; title: string; description: string }>;
  characterModelOptions: Array<{ id: CharacterModel; title: string; description: string }>;
  runtimeSnapshot: DesktopRuntimeSnapshot;
  onCharacterContextMenu: (e: MouseEvent<HTMLDivElement>) => void | Promise<void>;
  onCharacterModelChange: (model: CharacterModel) => void;
  onCharacterPointerDown: (e: MouseEvent<HTMLButtonElement>) => void;
  onCharacterPointerUp: () => void;
  onCloseCompactMenu: () => void;
  onCloseCompactMenuNow: () => void;
  onCompactAppearanceChange: (appearance: CompactAppearance) => void;
  onCompactDrag: (e: MouseEvent<HTMLDivElement>) => void | Promise<void>;
  onCompactQuerySubmit: (openMain?: boolean) => void | Promise<void>;
  onCompactScaleReset: () => void;
  onCompactWheel: (e: WheelEvent<HTMLDivElement>) => void;
  onOpenCompactMenu: (clientX?: number, clientY?: number) => void | Promise<void>;
  onOpenCompactQuery: () => void | Promise<void>;
  onOpenExternalChat: (entry: ExternalChatEntry) => void | Promise<void>;
  onOpenSettingsFromCompact: () => void | Promise<void>;
  onOpenNewTopicFromCompact: () => void | Promise<void>;
  onPointerHitTest: (element: HTMLElement, clientX: number, clientY: number) => boolean;
  onSetCharacterMenuPinned: Dispatch<SetStateAction<boolean>>;
  onSetCompactQuery: Dispatch<SetStateAction<string>>;
  onSetCompactReply: Dispatch<SetStateAction<CompactReply | null>>;
  onUpdateBasicSettings: (patch: Partial<BasicSettings>) => void;
  onSetIsCharacterModelOpen: Dispatch<SetStateAction<boolean>>;
  onSetIsCompactAppearanceOpen: Dispatch<SetStateAction<boolean>>;
  onSetIsCompactMenuOpen: Dispatch<SetStateAction<boolean>>;
  onSetIsCompactModelOpen: Dispatch<SetStateAction<boolean>>;
  onSetIsCompactQueryOpen: Dispatch<SetStateAction<boolean>>;
  onSetIsCompactReplyLoading: Dispatch<SetStateAction<boolean>>;
  onToggleMainFromCompact: () => void | Promise<void>;
};

export default function CompactWindow({
  appearanceOptions,
  basicSettings,
  characterMenuPosition,
  characterModel,
  characterModelOptions,
  characterPanelSide,
  characterScale,
  compactAppearance,
  isCharacterMenuPinned,
  compactQuery,
  compactReply,
  compactSize,
  compactStyle,
  entries,
  isCharacterAppearance,
  isCharacterDragging,
  isCharacterHorizontalPanelOpen,
  isCharacterModelOpen,
  isCompactAppearanceOpen,
  isCompactMenuOpen,
  isCompactModelOpen,
  isCompactQueryOpen,
  isCompactReplyLoading,
  omniSmallIconSrc,
  runtimeSnapshot,
  compactMenuSide,
  compactSubmenuSide,
  onCharacterContextMenu,
  onCharacterModelChange,
  onCharacterPointerDown,
  onCharacterPointerUp,
  onCloseCompactMenu,
  onCloseCompactMenuNow,
  onCompactAppearanceChange,
  onCompactDrag,
  onCompactQuerySubmit,
  onCompactScaleReset,
  onCompactWheel,
  onOpenCompactMenu,
  onOpenCompactQuery,
  onOpenExternalChat,
  onOpenSettingsFromCompact,
  onOpenNewTopicFromCompact,
  onPointerHitTest,
  onSetCharacterMenuPinned,
  onSetCompactQuery,
  onSetCompactReply,
  onUpdateBasicSettings,
  onSetIsCharacterModelOpen,
  onSetIsCompactAppearanceOpen,
  onSetIsCompactMenuOpen,
  onSetIsCompactModelOpen,
  onSetIsCompactQueryOpen,
  onSetIsCompactReplyLoading,
  onToggleMainFromCompact,
}: CompactWindowProps) {
  const closeReply = () => {
    onSetCompactReply(null);
    onSetIsCompactReplyLoading(false);
  };

  const resolveAnchorEdge = (target: HTMLElement) => {
    const anchor = target.querySelector<HTMLElement>(".compact-menu-anchor");
    if (!anchor) {
      return null;
    }

    const rect = anchor.getBoundingClientRect();
    return {
      x: rect.left + rect.width * 0.62,
      y: rect.top + rect.height / 2,
    };
  };

  return (
    <div
      className={`compact-shell drag-region ${
        isCharacterHorizontalPanelOpen && characterPanelSide === "left" ? "compact-shell--reply-left" : ""
      } ${isCompactMenuOpen && !isCharacterMenuPinned && compactMenuSide === "left" ? "compact-shell--menu-left" : ""}`}
      onMouseDownCapture={(e) => {
        const target = e.target as HTMLElement;
        const isInsideFloatingPanel = Boolean(
          target.closest(".compact-query") || target.closest(".compact-reply") || target.closest(".compact-menu") || target.closest(".compact-submenu")
        );
        const hasFloatingPanel = Boolean(isCompactMenuOpen || isCompactQueryOpen || isCompactReplyLoading || compactReply);

        if (hasFloatingPanel && !isInsideFloatingPanel) {
          e.preventDefault();
          e.stopPropagation();
          onCloseCompactMenuNow();
          onSetIsCompactQueryOpen(false);
          closeReply();
          return;
        }

        if (isCharacterAppearance) {
          return;
        }
        if (!target.closest(".compact-hover-zone") && !target.closest(".compact-query") && !target.closest(".compact-reply")) {
          onCloseCompactMenuNow();
        }
      }}
      onMouseDown={onCompactDrag}
      onWheel={onCompactWheel}
    >
      <div
        className={`compact-hover-zone ${isCharacterAppearance ? "compact-hover-zone--character" : ""}`}
        onMouseEnter={
          !isCharacterAppearance && !isCompactQueryOpen && basicSettings.menuOpenMode === "hover"
            ? (e) => {
                const anchor = resolveAnchorEdge(e.currentTarget);
                void onOpenCompactMenu(anchor?.x ?? e.clientX, anchor?.y ?? e.clientY);
              }
            : undefined
        }
        onMouseLeave={!isCharacterAppearance && !isCompactQueryOpen ? onCloseCompactMenu : undefined}
        onClick={
          !isCharacterAppearance && !isCompactQueryOpen && basicSettings.menuOpenMode === "click"
            ? (e) => {
                const target = e.target as HTMLElement;
                if (!target.closest("button")) {
                  const anchor = resolveAnchorEdge(e.currentTarget);
                  void onOpenCompactMenu(anchor?.x ?? e.clientX, anchor?.y ?? e.clientY);
                }
              }
            : undefined
        }
      >
        <div className={`compact-bar ${isCharacterAppearance ? "compact-bar--character" : ""}`} style={compactStyle}>
          {!isCharacterAppearance && runtimeSnapshot.activeAssistantTitle && (
            <div className="compact-bar__meta no-drag" title={runtimeSnapshot.activeTaskGoal ?? runtimeSnapshot.activeAssistantTitle}>
              <strong>{runtimeSnapshot.activeAssistantTitle}</strong>
              <span>{runtimeSnapshot.activeTaskGoal ?? `任务 ${runtimeSnapshot.taskCount}`}</span>
            </div>
          )}

          <div className="compact-menu-anchor no-drag" onContextMenu={isCharacterAppearance ? onCharacterContextMenu : undefined}>
            <button
              type="button"
              className={`compact-button compact-button--brand ${isCharacterAppearance ? "compact-button--character" : ""}`}
              onMouseDown={isCharacterAppearance ? onCharacterPointerDown : (e) => e.stopPropagation()}
              onMouseMove={
                isCharacterAppearance
                  ? (e) => {
                      e.currentTarget.style.cursor = onPointerHitTest(e.currentTarget, e.clientX, e.clientY) ? "grab" : "default";
                    }
                  : undefined
              }
              onMouseUp={isCharacterAppearance ? onCharacterPointerUp : undefined}
              onMouseLeave={
                isCharacterAppearance
                  ? (e) => {
                      e.currentTarget.style.cursor = "default";
                      onCharacterPointerUp();
                    }
                  : undefined
              }
              onClick={() => {
                if (isCharacterAppearance) {
                  if (isCharacterDragging) {
                    return;
                  }
                  return;
                }
                void onToggleMainFromCompact();
              }}
              aria-label="切换主界面"
            >
              {isCharacterAppearance ? (
                <Live2DCharacter key={characterModel} width={Math.max(48, compactSize.width - 18)} height={Math.max(72, compactSize.height - 34)} model={characterModel} />
              ) : (
                <img src={omniSmallIconSrc} alt="Omni" className="compact-button__icon" />
              )}
            </button>

            {isCompactMenuOpen && (
              <CompactMenu
                appearanceOptions={appearanceOptions}
                characterMenuPosition={isCharacterMenuPinned ? characterMenuPosition : null}
                characterModel={characterModel}
                characterModelOptions={characterModelOptions}
                characterScale={characterScale}
                compactAppearance={compactAppearance}
                entries={entries}
                isCharacterAppearance={isCharacterAppearance}
                isCharacterModelOpen={isCharacterModelOpen}
                isCompactAppearanceOpen={isCompactAppearanceOpen}
                isCompactModelOpen={isCompactModelOpen}
                compactMenuSide={compactMenuSide}
                compactSubmenuSide={compactSubmenuSide}
                followCursorScreen={basicSettings.followCursorScreen}
                onCharacterModelChange={onCharacterModelChange}
                onCompactAppearanceChange={onCompactAppearanceChange}
                onOpenExternalChat={onOpenExternalChat}
                onOpenSettingsFromCompact={onOpenSettingsFromCompact}
                onScaleReset={onCompactScaleReset}
                onUpdateBasicSettings={onUpdateBasicSettings}
                onSetCharacterMenuPinned={onSetCharacterMenuPinned}
                onSetIsCharacterModelOpen={onSetIsCharacterModelOpen}
                onSetIsCompactAppearanceOpen={onSetIsCompactAppearanceOpen}
                onSetIsCompactMenuOpen={onSetIsCompactMenuOpen}
                onSetIsCompactModelOpen={onSetIsCompactModelOpen}
              />
            )}

            {isCompactQueryOpen && (
              <CompactQueryPanel
                compactQuery={compactQuery}
                isCharacterAppearance={isCharacterAppearance}
                onChange={onSetCompactQuery}
                onClose={() => onSetIsCompactQueryOpen(false)}
                onSubmit={onCompactQuerySubmit}
              />
            )}

            <CompactReplyPanel
              compactReply={compactReply}
              isCharacterAppearance={isCharacterAppearance}
              isCompactReplyLoading={isCompactReplyLoading}
              panelSide={characterPanelSide}
              speakerLabel={isCharacterAppearance ? "角色" : "Omni"}
              onClose={closeReply}
            />
          </div>

          {!isCharacterAppearance && !isCompactQueryOpen && (
            <div className="compact-bar__actions no-drag">
              <button
                type="button"
                className="compact-button compact-button--search-chip"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => {
                  void onOpenCompactQuery();
                }}
                aria-label="打开查询"
                title="打开查询"
              >
                <svg className="compact-button__search" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <circle cx="11" cy="11" r="6.5" strokeWidth="1.8" />
                  <path d="M16 16L21 21" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
              <button
                type="button"
                className="compact-button compact-button--search-chip"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => {
                  void onOpenNewTopicFromCompact();
                }}
                aria-label="新话题"
                title="新话题"
              >
                +
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
