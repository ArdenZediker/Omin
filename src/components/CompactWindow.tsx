import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type MouseEvent, type SetStateAction, type WheelEvent } from "react";
import type { BasicSettings, CompactReply, ExternalChatEntry } from "../app/types";
import { emit, emitTo } from "@tauri-apps/api/event";
import { ChevronDown } from "lucide-react";
import { PET_THOUGHT_WINDOW_LABEL } from "../app/constants";
import type { CompactAppearance } from "../hooks/useCompactWindowState";
import { getCodexPetViewportSize } from "../app/pets/codexPetSizing";
import type { CodexPetPackage } from "../app/pets/codexPetTypes";
import DesktopPet, { type DesktopPetState } from "./DesktopPet";
import CompactMenu from "./compact/CompactMenu";
import CompactQueryPanel from "./compact/CompactQueryPanel";
import CompactReplyPanel from "./compact/CompactReplyPanel";

type CompactWindowProps = {
  basicSettings: BasicSettings;
  menuPosition: { x: number; y: number } | null;
  codexPetPackage: CodexPetPackage | null;
  characterScale: number;
  compactAppearance: CompactAppearance;
  compactQuery: string;
  compactReply: CompactReply | null;
  petThoughtCount: number;
  arePetThoughtsCollapsed: boolean;
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
  characterDragMotion: DesktopPetState | null;
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
  onSetArePetThoughtsCollapsed: Dispatch<SetStateAction<boolean>>;
  onUpdateBasicSettings: (patch: Partial<BasicSettings>) => void;
  onSetIsCompactAppearanceOpen: Dispatch<SetStateAction<boolean>>;
  onSetIsCompactModelOpen: Dispatch<SetStateAction<boolean>>;
  onSetIsCompactQueryOpen: Dispatch<SetStateAction<boolean>>;
  onSetIsCompactReplyLoading: Dispatch<SetStateAction<boolean>>;
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
  petThoughtCount,
  arePetThoughtsCollapsed,
  compactSize,
  compactStyle,
  entries,
  isCompactAppearanceOpen,
  isCompactMenuOpen,
  isCompactModelOpen,
  isCompactQueryOpen,
  isCompactReplyLoading,
  characterDragMotion,
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
  onSetArePetThoughtsCollapsed,
  onUpdateBasicSettings,
  onSetIsCompactAppearanceOpen,
  onSetIsCompactModelOpen,
  onSetIsCompactQueryOpen,
  onSetIsCompactReplyLoading,
}: CompactWindowProps) {
  const closeReply = () => {
    onSetCompactReply(null);
    onSetIsCompactReplyLoading(false);
  };
  const isPetAppearance = compactAppearance === "pet";
  const isAnimatedAppearance = isPetAppearance;
  const petViewportSize = getCodexPetViewportSize(compactSize);
  const petRenderHeight = petViewportSize.height;
  const petRenderWidth = petViewportSize.width;
  const petButtonRef = useRef<HTMLButtonElement | null>(null);
  const petAnchorRef = useRef<HTMLDivElement | null>(null);
  const [petCelebrateReply, setPetCelebrateReply] = useState(false);
  const [petClickBounce, setPetClickBounce] = useState(false);
  const [isPetHovered, setIsPetHovered] = useState(false);
  const [petWavingHold, setPetWavingHold] = useState(false);
  const petState: DesktopPetState = characterDragMotion
    ? characterDragMotion
    : petClickBounce
      ? "jumping"
    : compactReply?.isError
      ? "failed"
      : petCelebrateReply
        ? "review"
        : isCompactReplyLoading || compactReply
          ? "waiting"
          : isCompactMenuOpen || isCompactQueryOpen || isPetHovered || petWavingHold
            ? "waving"
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

  useEffect(() => {
    if (!petClickBounce) {
      return;
    }
    const timer = window.setTimeout(() => {
      setPetClickBounce(false);
    }, 760);
    return () => window.clearTimeout(timer);
  }, [petClickBounce]);

  useEffect(() => {
    if (isCompactMenuOpen || isCompactQueryOpen || isPetHovered) {
      setPetWavingHold(true);
      return;
    }
    const timer = window.setTimeout(() => {
      setPetWavingHold(false);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [isCompactMenuOpen, isCompactQueryOpen, isPetHovered]);

  useEffect(() => {
    if (petThoughtCount <= 0) {
      onSetArePetThoughtsCollapsed(false);
    }
  }, [onSetArePetThoughtsCollapsed, petThoughtCount]);


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
          (e) => {
            if (isPetAppearance) {
              setIsPetHovered(true);
            }
            if (!isCompactQueryOpen && basicSettings.menuOpenMode === "hover") {
                const anchor = resolveAnchorEdge(e.currentTarget);
                void onOpenCompactMenu(anchor?.x ?? e.clientX, anchor?.y ?? e.clientY);
            }
          }
        }
        onMouseLeave={
          () => {
            if (isPetAppearance) {
              setIsPetHovered(false);
            }
            if (!isCompactQueryOpen && basicSettings.menuOpenMode === "hover") {
              onCloseCompactMenuNow();
            }
          }
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
          }`}
          style={
            isPetAppearance
              ? ({
                  ...compactStyle,
                  "--pet-decoration-offset-top": "16px",
                  "--pet-thought-toggle-x": `${Math.round(petRenderWidth * 1.02)}px`,
                  "--pet-thought-toggle-y": `${Math.round(petRenderHeight * 0.02)}px`,
                } as CSSProperties)
              : compactStyle
          }
        >
          <div className="compact-menu-anchor no-drag" onContextMenu={isAnimatedAppearance ? onCharacterContextMenu : undefined}>
            <button
              ref={petButtonRef}
              type="button"
              className={`compact-button compact-button--brand no-drag ${isAnimatedAppearance ? "compact-button--character" : ""} ${
                isPetAppearance ? "compact-button--pet" : ""
              }`}
              onMouseDown={
                isAnimatedAppearance
                  ? onCharacterPointerDown
                  : (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }
              }
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
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
                  setPetClickBounce(true);
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

            {isPetAppearance && petThoughtCount > 0 ? (
              <button
                type="button"
                className={`pet-thought-compact-toggle ${arePetThoughtsCollapsed ? "pet-thought-compact-toggle--collapsed" : ""} no-drag`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const nextCollapsed = !arePetThoughtsCollapsed;
                  onSetArePetThoughtsCollapsed(nextCollapsed);
                  void emit("omni-pet-thought-collapse-changed", { collapsed: nextCollapsed });
                  void emitTo(PET_THOUGHT_WINDOW_LABEL, "omni-pet-thought-collapse-changed", { collapsed: nextCollapsed });
                }}
                aria-label={arePetThoughtsCollapsed ? `Expand ${petThoughtCount} thought bubbles` : "Collapse thought bubbles"}
                title={arePetThoughtsCollapsed ? `${petThoughtCount} topics` : "Collapse thought bubbles"}
              >
                {arePetThoughtsCollapsed ? petThoughtCount : <ChevronDown size={16} strokeWidth={2.25} aria-hidden="true" focusable="false" />}
              </button>
            ) : null}

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
                className="compact-button compact-button--search-chip no-drag"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
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

