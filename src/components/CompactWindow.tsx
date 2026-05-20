import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type MouseEvent, type SetStateAction, type WheelEvent } from "react";
import type { BasicSettings, CompactReply, ExternalChatEntry, PetThoughtState } from "../app/types";
import type { CompactAppearance } from "../hooks/useCompactWindowState";
import { getCodexPetViewportSize } from "../app/pets/codexPetSizing";
import type { CodexPetPackage } from "../app/pets/codexPetTypes";
import DesktopPet from "./DesktopPet";
import CompactMenu from "./compact/CompactMenu";
import CompactQueryPanel from "./compact/CompactQueryPanel";
import CompactReplyPanel from "./compact/CompactReplyPanel";
import PetThoughtBubble from "./compact/PetThoughtBubble";

type CompactWindowProps = {
  basicSettings: BasicSettings;
  menuPosition: { x: number; y: number } | null;
  codexPetPackage: CodexPetPackage | null;
  characterScale: number;
  compactAppearance: CompactAppearance;
  compactQuery: string;
  compactReply: CompactReply | null;
  compactSize: { width: number; height: number };
  compactStyle: CSSProperties;
  entries: ExternalChatEntry[];
  isCompactAppearanceOpen: boolean;
  isCompactMenuOpen: boolean;
  isCompactModelOpen: boolean;
  isCompactQueryOpen: boolean;
  isCompactReplyLoading: boolean;
  compactMenuSide: "left" | "right";
  compactSubmenuSide: "left" | "right";
  isCharacterDragging: boolean;
  petThought: PetThoughtState | null;
  petThoughtPlacement: "top" | "right" | "left" | "bottom";
  omniSmallIconSrc: string;
  appearanceOptions: Array<{ id: CompactAppearance; title: string; description: string }>;
  onCharacterContextMenu: (e: MouseEvent<HTMLDivElement>) => void | Promise<void>;
  onCharacterPointerDown: (e: MouseEvent<HTMLButtonElement>) => void;
  onCharacterPointerMove: (e: MouseEvent<HTMLButtonElement>) => void;
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
  onPetPrimaryClick: () => void | Promise<void>;
  onOpenSettingsFromCompact: () => void | Promise<void>;
  onPointerHitTest: (element: HTMLElement, clientX: number, clientY: number) => boolean;
  onSetCompactQuery: Dispatch<SetStateAction<string>>;
  onSetCompactReply: Dispatch<SetStateAction<CompactReply | null>>;
  onUpdateBasicSettings: (patch: Partial<BasicSettings>) => void;
  onSetIsCompactAppearanceOpen: Dispatch<SetStateAction<boolean>>;
  onSetIsCompactModelOpen: Dispatch<SetStateAction<boolean>>;
  onSetIsCompactQueryOpen: Dispatch<SetStateAction<boolean>>;
  onSetIsCompactReplyLoading: Dispatch<SetStateAction<boolean>>;
  onSetPetThoughtPlacement: Dispatch<SetStateAction<"top" | "right" | "left" | "bottom">>;
};

export default function CompactWindow({
  appearanceOptions,
  basicSettings,
  menuPosition,
  codexPetPackage,
  characterScale,
  compactAppearance,
  compactQuery,
  compactReply,
  compactSize,
  compactStyle,
  entries,
  isCompactAppearanceOpen,
  isCompactMenuOpen,
  isCompactModelOpen,
  isCompactQueryOpen,
  isCompactReplyLoading,
  isCharacterDragging,
  petThought,
  petThoughtPlacement,
  omniSmallIconSrc,
  compactMenuSide,
  compactSubmenuSide,
  onCharacterContextMenu,
  onCharacterPointerDown,
  onCharacterPointerMove,
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
  onPetPrimaryClick,
  onOpenSettingsFromCompact,
  onPointerHitTest,
  onSetCompactQuery,
  onSetCompactReply,
  onUpdateBasicSettings,
  onSetIsCompactAppearanceOpen,
  onSetIsCompactModelOpen,
  onSetIsCompactQueryOpen,
  onSetIsCompactReplyLoading,
  onSetPetThoughtPlacement,
}: CompactWindowProps) {
  const closeReply = () => {
    onSetCompactReply(null);
    onSetIsCompactReplyLoading(false);
  };
  const isPetAppearance = compactAppearance === "pet";
  const isAnimatedAppearance = isPetAppearance;
  const petViewportSize = getCodexPetViewportSize(compactSize.width);
  const petRenderHeight = petViewportSize.height;
  const petRenderWidth = petViewportSize.width;
  const petButtonRef = useRef<HTMLButtonElement | null>(null);
  const petAnchorRef = useRef<HTMLDivElement | null>(null);
  const [petCelebrateReply, setPetCelebrateReply] = useState(false);
  const shouldShowPetThought = Boolean(
    isPetAppearance &&
      petThought &&
      !isCompactMenuOpen &&
      !isCompactQueryOpen &&
      !isCompactReplyLoading &&
      !compactReply
  );
  const shellPetThoughtClass = shouldShowPetThought ? `compact-shell--pet-thought compact-shell--pet-thought-${petThoughtPlacement}` : "";
  const barPetThoughtClass = shouldShowPetThought ? "compact-bar--pet-thought" : "";
  const petState = compactReply?.isError
    ? "failed"
    : petCelebrateReply
      ? "review"
      : isCompactReplyLoading || compactReply
        ? "waiting"
        : "idle";

  useEffect(() => {
    if (!compactReply || compactReply.isError) {
      setPetCelebrateReply(false);
      return;
    }
    setPetCelebrateReply(true);
    const timer = window.setTimeout(() => {
      setPetCelebrateReply(false);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [compactReply]);


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
        !isAnimatedAppearance && isCompactMenuOpen && compactMenuSide === "left"
          ? "compact-shell--menu-left"
          : ""
      } ${
        isPetAppearance && (isCompactMenuOpen || isCompactQueryOpen || isCompactReplyLoading || compactReply)
          ? "compact-shell--pet-expanded"
          : ""
      } ${shellPetThoughtClass}`}
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

        if (isPetAppearance && isCompactQueryOpen && !isInsideFloatingPanel) {
          e.preventDefault();
          e.stopPropagation();
          onSetIsCompactQueryOpen(false);
          closeReply();
          return;
        }

      }}
      onMouseDown={onCompactDrag}
      onWheel={onCompactWheel}
    >
      <div
        className={`compact-hover-zone ${isAnimatedAppearance ? "compact-hover-zone--character" : ""} ${
          isPetAppearance ? "compact-hover-zone--pet" : ""
        }`}
        onMouseEnter={
          !isCompactQueryOpen && basicSettings.menuOpenMode === "hover"
            ? (e) => {
                const anchor = resolveAnchorEdge(e.currentTarget);
                void onOpenCompactMenu(anchor?.x ?? e.clientX, anchor?.y ?? e.clientY);
              }
            : undefined
        }
        onMouseLeave={
          !isCompactQueryOpen && basicSettings.menuOpenMode === "hover"
            ? onCloseCompactMenuNow
            : undefined
        }
        onClick={
          !isCompactQueryOpen && basicSettings.menuOpenMode === "click"
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
          } ${barPetThoughtClass}`}
          style={compactStyle}
        >
          <div className="compact-menu-anchor no-drag" onContextMenu={isAnimatedAppearance ? onCharacterContextMenu : undefined}>
            {shouldShowPetThought ? (
              <PetThoughtBubble
                thought={petThought}
                anchorRef={petAnchorRef}
                placement={petThoughtPlacement}
                lockPlacement={isCharacterDragging}
                onPlacementChange={onSetPetThoughtPlacement}
              />
            ) : null}
            <button
              ref={petButtonRef}
              type="button"
              className={`compact-button compact-button--brand ${isAnimatedAppearance ? "compact-button--character" : ""} ${
                isPetAppearance ? "compact-button--pet" : ""
              }`}
              onMouseDown={isAnimatedAppearance ? onCharacterPointerDown : (e) => e.stopPropagation()}
              onMouseMove={
                isAnimatedAppearance
                  ? (e) => {
                      const nextCursor = onPointerHitTest(e.currentTarget, e.clientX, e.clientY) ? "grab" : "default";
                      e.currentTarget.style.cursor = nextCursor;
                      onCharacterPointerMove(e);
                    }
                  : undefined
              }
              onMouseUp={isAnimatedAppearance ? onCharacterPointerUp : undefined}
              onMouseLeave={
                isAnimatedAppearance
                  ? (e) => {
                      e.currentTarget.style.cursor = "default";
                    }
                  : undefined
              }
              onClick={(event) => {
                if (isPetAppearance) {
                  event.stopPropagation();
                  void onPetPrimaryClick();
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
              aria-label="\u5207\u6362\u4e3b\u754c\u9762"
            >
              {isPetAppearance ? (
                <DesktopPet
                  ref={petAnchorRef}
                  width={petRenderWidth}
                  height={petRenderHeight}
                  state={petState}
                  packageData={codexPetPackage}
                />
              ) : (
                <img src={omniSmallIconSrc} alt="Omni" className="compact-button__icon" />
              )}
            </button>

            {isCompactMenuOpen && (
              <CompactMenu
                appearanceOptions={appearanceOptions}
                menuPosition={isPetAppearance ? menuPosition : null}
                characterScale={characterScale}
                compactAppearance={compactAppearance}
                entries={entries}
                isCompactAppearanceOpen={isCompactAppearanceOpen}
                isCompactModelOpen={isCompactModelOpen}
                compactMenuSide={compactMenuSide}
                compactSubmenuSide={compactSubmenuSide}
                followCursorScreen={basicSettings.followCursorScreen}
                onCompactAppearanceChange={onCompactAppearanceChange}
                onOpenExternalChat={onOpenExternalChat}
                onOpenSettingsFromCompact={onOpenSettingsFromCompact}
                onScaleReset={onCompactScaleReset}
                onUpdateBasicSettings={onUpdateBasicSettings}
                onSetIsCompactAppearanceOpen={onSetIsCompactAppearanceOpen}
                onSetIsCompactModelOpen={onSetIsCompactModelOpen}
              />
            )}

            {isCompactQueryOpen && !isPetAppearance && (
                <CompactQueryPanel
                  compactQuery={compactQuery}
                  isCharacterAppearance={isAnimatedAppearance}
                  variant="default"
                  onChange={onSetCompactQuery}
                  onClose={() => onSetIsCompactQueryOpen(false)}
                  onSubmit={onCompactQuerySubmit}
              />
            )}

            <CompactReplyPanel
              compactReply={compactReply}
              isCharacterAppearance={isAnimatedAppearance}
              isCompactReplyLoading={isCompactReplyLoading}
              panelSide="left"
              speakerLabel="Omni"
              variant={isPetAppearance ? "pet" : "default"}
              onClose={closeReply}
            />
          </div>

          {isCompactQueryOpen && isPetAppearance && (
            <CompactQueryPanel
              compactQuery={compactQuery}
              isCharacterAppearance={isAnimatedAppearance}
              variant="pet"
              onChange={onSetCompactQuery}
              onClose={() => onSetIsCompactQueryOpen(false)}
              onSubmit={onCompactQuerySubmit}
            />
          )}

          {!isPetAppearance && !isCompactQueryOpen && (
            <div className={`compact-bar__actions no-drag ${isPetAppearance ? "compact-bar__actions--pet" : ""}`}>
              <button
                type="button"
                className="compact-button compact-button--search-chip"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => {
                  void onOpenCompactQuery();
                }}
                aria-label="\u6253\u5f00\u67e5\u8be2"
                title="\u6253\u5f00\u67e5\u8be2"
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

