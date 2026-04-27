import type { CSSProperties } from "react";
import type { CharacterModel, CompactAppearance } from "../hooks/useCompactWindowState";
import type { BasicSettings, CompactReply, ExternalChatEntry } from "../app/types";
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
  omniSmallIconSrc: string;
  appearanceOptions: Array<{ id: CompactAppearance; title: string; description: string }>;
  characterModelOptions: Array<{ id: CharacterModel; title: string; description: string }>;
  onCharacterContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void | Promise<void>;
  onCharacterModelChange: (model: CharacterModel) => void;
  onCharacterPointerDown: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onCharacterPointerUp: () => void;
  onCloseCompactMenu: () => void;
  onCloseCompactMenuNow: () => void;
  onCompactAppearanceChange: (appearance: CompactAppearance) => void;
  onCompactDrag: (e: React.MouseEvent<HTMLDivElement>) => void | Promise<void>;
  onCompactQuerySubmit: (openMain?: boolean) => void | Promise<void>;
  onCompactScaleReset: () => void;
  onCompactWheel: (e: React.WheelEvent<HTMLDivElement>) => void;
  onOpenCompactMenu: () => void;
  onOpenCompactQuery: () => void | Promise<void>;
  onOpenExternalChat: (entry: ExternalChatEntry) => void | Promise<void>;
  onOpenSettingsFromCompact: () => void | Promise<void>;
  onPointerHitTest: (element: HTMLElement, clientX: number, clientY: number) => boolean;
  onSetCharacterMenuPinned: React.Dispatch<React.SetStateAction<boolean>>;
  onSetCompactQuery: React.Dispatch<React.SetStateAction<string>>;
  onSetCompactReply: React.Dispatch<React.SetStateAction<CompactReply | null>>;
  onSetIsCharacterModelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onSetIsCompactAppearanceOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onSetIsCompactMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onSetIsCompactModelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onSetIsCompactQueryOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onSetIsCompactReplyLoading: React.Dispatch<React.SetStateAction<boolean>>;
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
  onPointerHitTest,
  onSetCharacterMenuPinned,
  onSetCompactQuery,
  onSetCompactReply,
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

  return (
    <div
      className={`compact-shell drag-region ${
        isCharacterHorizontalPanelOpen && characterPanelSide === "left" ? "compact-shell--reply-left" : ""
      }`}
      onMouseDownCapture={(e) => {
        const target = e.target as HTMLElement;
        if (isCharacterAppearance) {
          const isInsideFloatingPanel = Boolean(
            target.closest(".compact-query") ||
              target.closest(".compact-reply") ||
              target.closest(".compact-menu") ||
              target.closest(".compact-submenu")
          );
          const hasFloatingPanel = Boolean(isCompactMenuOpen || isCompactQueryOpen || isCompactReplyLoading || compactReply);
          if (hasFloatingPanel && !isInsideFloatingPanel) {
            e.preventDefault();
            e.stopPropagation();
            onCloseCompactMenuNow();
            onSetIsCompactQueryOpen(false);
            closeReply();
          }
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
        onMouseEnter={!isCharacterAppearance && !isCompactQueryOpen && basicSettings.menuOpenMode === "hover" ? onOpenCompactMenu : undefined}
        onMouseLeave={!isCharacterAppearance && !isCompactQueryOpen ? onCloseCompactMenu : undefined}
        onClick={
          !isCharacterAppearance && !isCompactQueryOpen && basicSettings.menuOpenMode === "click"
            ? (e) => {
                const target = e.target as HTMLElement;
                if (!target.closest("button")) {
                  onOpenCompactMenu();
                }
              }
            : undefined
        }
      >
        <div className={`compact-bar ${isCharacterAppearance ? "compact-bar--character" : ""}`} style={compactStyle}>
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
              onClick={(e) => {
                if (isCharacterAppearance) {
                  const isInCharacterHitArea = onPointerHitTest(e.currentTarget, e.clientX, e.clientY);
                  if (!isInCharacterHitArea || isCharacterDragging) {
                    return;
                  }
                  void onOpenCompactQuery();
                  return;
                }
                void onToggleMainFromCompact();
              }}
              aria-label="切换主界面"
            >
              {isCharacterAppearance ? (
                <Live2DCharacter
                  key={characterModel}
                  width={Math.max(48, compactSize.width - 18)}
                  height={Math.max(72, compactSize.height - 34)}
                  model={characterModel}
                />
              ) : (
                <img src={omniSmallIconSrc} alt="Omni" className="compact-button__icon" />
              )}
            </button>

            {isCompactMenuOpen && (
              <CompactMenu
                appearanceOptions={appearanceOptions}
                characterMenuPosition={characterMenuPosition}
                characterModel={characterModel}
                characterModelOptions={characterModelOptions}
                characterScale={characterScale}
                compactAppearance={compactAppearance}
                entries={entries}
                isCharacterAppearance={isCharacterAppearance}
                isCharacterModelOpen={isCharacterModelOpen}
                isCompactAppearanceOpen={isCompactAppearanceOpen}
                isCompactModelOpen={isCompactModelOpen}
                onCharacterModelChange={onCharacterModelChange}
                onCompactAppearanceChange={onCompactAppearanceChange}
                onOpenExternalChat={onOpenExternalChat}
                onOpenSettingsFromCompact={onOpenSettingsFromCompact}
                onScaleReset={onCompactScaleReset}
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
            <button
              type="button"
              className="compact-button compact-button--search-chip no-drag"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                void onOpenCompactQuery();
              }}
              aria-label="打开查询"
            >
              <svg className="compact-button__search" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <circle cx="11" cy="11" r="6.5" strokeWidth="1.8" />
                <path d="M16 16L21 21" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
