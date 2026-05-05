import { useEffect, useState, type CSSProperties, type Dispatch, type MouseEvent, type SetStateAction, type WheelEvent } from "react";
import type { BasicSettings, CompactReply, ExternalChatEntry } from "../app/types";
import type { CharacterModel, CompactAppearance } from "../hooks/useCompactWindowState";
import type { DesktopPetAction } from "../config/pets/omniSchnauzer";
import Live2DCharacter from "./Live2DCharacter";
import DesktopPet from "./DesktopPet";
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
  onCharacterContextMenu: (e: MouseEvent<HTMLDivElement>) => void | Promise<void>;
  onCharacterModelChange: (model: CharacterModel) => void;
  onCharacterPointerDown: (e: MouseEvent<HTMLButtonElement>) => void;
  onCharacterPointerUp: () => void;
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
  isCharacterAppearance: _isCharacterAppearance,
  isCharacterDragging,
  isCharacterHorizontalPanelOpen,
  isCharacterModelOpen,
  isCompactAppearanceOpen,
  isCompactMenuOpen,
  isCompactModelOpen,
  isCompactQueryOpen,
  isCompactReplyLoading,
  omniSmallIconSrc,
  compactMenuSide,
  compactSubmenuSide,
  onCharacterContextMenu,
  onCharacterModelChange,
  onCharacterPointerDown,
  onCharacterPointerUp,
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
  onUpdateBasicSettings,
  onSetIsCharacterModelOpen,
  onSetIsCompactAppearanceOpen,
  onSetIsCompactMenuOpen,
  onSetIsCompactModelOpen,
  onSetIsCompactQueryOpen,
  onSetIsCompactReplyLoading,
}: CompactWindowProps) {
  const closeReply = () => {
    onSetCompactReply(null);
    onSetIsCompactReplyLoading(false);
  };
  const isLive2DAppearance = compactAppearance === "character";
  const isPetAppearance = compactAppearance === "pet";
  const isAnimatedAppearance = isLive2DAppearance || isPetAppearance;
  const petViewportSize = Math.max(48, compactSize.width - 18);
  const petRenderHeight = petViewportSize;
  const petRenderWidth = Math.round((petRenderHeight * 192) / 208);
  const [petRecentlyOpenedMenu, setPetRecentlyOpenedMenu] = useState(false);
  const petState: DesktopPetAction = isCharacterDragging
    ? "running"
    : compactReply?.isError
    ? "failed"
    : petRecentlyOpenedMenu
    ? "waving"
    : isCompactReplyLoading || compactReply
    ? "review"
    : isCompactMenuOpen
    ? "jumping"
    : "idle";

  useEffect(() => {
    if (!isPetAppearance || !isCompactMenuOpen) {
      setPetRecentlyOpenedMenu(false);
      return;
    }
    setPetRecentlyOpenedMenu(true);
    const timer = window.setTimeout(() => {
      setPetRecentlyOpenedMenu(false);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [isPetAppearance, isCompactMenuOpen]);


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
      } ${
        !isAnimatedAppearance && isCompactMenuOpen && !isCharacterMenuPinned && compactMenuSide === "left"
          ? "compact-shell--menu-left"
          : ""
      }`}
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

        if (isLive2DAppearance) {
          return;
        }
      }}
      onMouseDown={onCompactDrag}
      onWheel={onCompactWheel}
    >
      <div
        className={`compact-hover-zone ${isAnimatedAppearance ? "compact-hover-zone--character" : ""}`}
        onMouseEnter={
          !isLive2DAppearance && !isCompactQueryOpen && basicSettings.menuOpenMode === "hover"
            ? (e) => {
                const anchor = resolveAnchorEdge(e.currentTarget);
                void onOpenCompactMenu(anchor?.x ?? e.clientX, anchor?.y ?? e.clientY);
              }
            : undefined
        }
        onMouseLeave={
          !isLive2DAppearance && !isCompactQueryOpen && basicSettings.menuOpenMode === "hover"
            ? onCloseCompactMenuNow
            : undefined
        }
        onClick={
          !isLive2DAppearance && !isCompactQueryOpen && basicSettings.menuOpenMode === "click"
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
        <div
          className={`compact-bar ${isAnimatedAppearance ? "compact-bar--character" : ""} ${
            isPetAppearance ? "compact-bar--pet" : ""
          }`}
          style={compactStyle}
        >
          <div className="compact-menu-anchor no-drag" onContextMenu={isAnimatedAppearance ? onCharacterContextMenu : undefined}>
            <button
              type="button"
              className={`compact-button compact-button--brand ${isAnimatedAppearance ? "compact-button--character" : ""} ${
                isPetAppearance ? "compact-button--pet" : ""
              }`}
              onMouseDown={isAnimatedAppearance ? onCharacterPointerDown : (e) => e.stopPropagation()}
              onMouseMove={
                isAnimatedAppearance
                  ? (e) => {
                      e.currentTarget.style.cursor = onPointerHitTest(e.currentTarget, e.clientX, e.clientY) ? "grab" : "default";
                    }
                  : undefined
              }
              onMouseUp={isAnimatedAppearance ? onCharacterPointerUp : undefined}
              onMouseLeave={
                isAnimatedAppearance
                  ? (e) => {
                      e.currentTarget.style.cursor = "default";
                      onCharacterPointerUp();
                    }
                  : undefined
              }
              onClick={(event) => {
                if (isLive2DAppearance) {
                  if (isCharacterDragging) {
                    return;
                  }
                  return;
                }
                if (isPetAppearance) {
                  event.stopPropagation();
                  if (isCharacterDragging) {
                    return;
                  }
                  if (isCompactMenuOpen) {
                    onCloseCompactMenuNow();
                  }
                  closeReply();
                  if (isCompactQueryOpen) {
                    onSetIsCompactQueryOpen(false);
                    return;
                  }
                  void onOpenCompactQuery();
                  return;
                }
                event.stopPropagation();
                if (isCompactMenuOpen) {
                  onCloseCompactMenuNow();
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                void onOpenCompactMenu(rect.left + rect.width / 2, rect.top + rect.height / 2);
              }}
              data-hit-mode={isPetAppearance ? "full" : undefined}
              aria-label="切换主界面"
            >
              {isPetAppearance ? (
                <DesktopPet width={petRenderWidth} height={petRenderHeight} state={petState} />
              ) : isLive2DAppearance ? (
                <Live2DCharacter key={characterModel} width={Math.max(48, compactSize.width - 18)} height={Math.max(72, compactSize.height - 34)} model={characterModel} />
              ) : (
                <img src={omniSmallIconSrc} alt="Omni" className="compact-button__icon" />
              )}
            </button>

            {isCompactMenuOpen && (
              <CompactMenu
                appearanceOptions={appearanceOptions}
                characterMenuPosition={isCharacterMenuPinned || isPetAppearance ? characterMenuPosition : null}
                characterModel={characterModel}
                characterModelOptions={characterModelOptions}
                characterScale={characterScale}
                compactAppearance={compactAppearance}
                entries={entries}
                isCharacterAppearance={isAnimatedAppearance}
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
                isCharacterAppearance={isAnimatedAppearance}
                variant={isPetAppearance ? "pet" : isLive2DAppearance ? "character" : "default"}
                onChange={onSetCompactQuery}
                onClose={() => onSetIsCompactQueryOpen(false)}
                onSubmit={onCompactQuerySubmit}
              />
            )}

            <CompactReplyPanel
              compactReply={compactReply}
              isCharacterAppearance={isAnimatedAppearance}
              isCompactReplyLoading={isCompactReplyLoading}
              panelSide={characterPanelSide}
              speakerLabel={isLive2DAppearance ? "角色" : "Omni"}
              onClose={closeReply}
            />
          </div>

          {!isLive2DAppearance && !isPetAppearance && !isCompactQueryOpen && (
            <div className={`compact-bar__actions no-drag ${isPetAppearance ? "compact-bar__actions--pet" : ""}`}>
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

            </div>
          )}
        </div>
      </div>
    </div>
  );
}
