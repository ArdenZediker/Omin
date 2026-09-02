import { useEffect, useRef, useState, type CSSProperties, type Dispatch, type MouseEvent, type SetStateAction, type WheelEvent } from "react";
import type { BasicSettings, CompactReply, ExternalChatEntry } from "../app/types";
import { emit, emitTo } from "@tauri-apps/api/event";
import { ChevronDown } from "lucide-react";
import { PET_THOUGHT_WINDOW_LABEL } from "../app/constants";
import { getPetThoughtKey } from "../app/petThoughts";
import type { PetThoughtState } from "../app/types";
import type { PetThoughtPlacement } from "../app/window";
import type { CompactAppearance } from "../hooks/useCompactWindowState";
import { getCodexPetViewportSize } from "../app/pets/codexPetSizing";
import type { CodexPetPackage } from "../app/pets/codexPetTypes";
import DesktopPet, { type DesktopPetState } from "./DesktopPet";
import CompactMenu from "./compact/CompactMenu";
import CompactQueryPanel from "./compact/CompactQueryPanel";
import PetThoughtBubble from "./compact/PetThoughtBubble";

type CompactWindowProps = {
  basicSettings: BasicSettings;
  menuPosition: { x: number; y: number } | null;
  codexPetPackage: CodexPetPackage | null;
  characterScale: number;
  compactAppearance: CompactAppearance;
  compactQuery: string;
  compactReply: CompactReply | null;
  petThought: PetThoughtState | null;
  petThoughtQueue: PetThoughtState[];
  petThoughtCount: number;
  petThoughtPlacement: PetThoughtPlacement;
  arePetThoughtsCollapsed: boolean;
  compactSize: { width: number; height: number };
  compactStyle: CSSProperties;
  entries: ExternalChatEntry[];
  isCompactAppearanceOpen: boolean;
  isCompactMenuOpen: boolean;
  isCompactModelOpen: boolean;
  isCompactQueryOpen: boolean;
  isCompactReplyLoading: boolean;
  isCharacterDragging: boolean;
  previewCharacterScale: number | null;
  compactMenuSide: "left" | "right";
  compactSubmenuSide: "left" | "right";
  characterDragMotion: DesktopPetState | null;
  omniSmallIconSrc: string;
  appearanceOptions: Array<{ id: CompactAppearance; title: string; description: string }>;
  onCharacterContextMenu: (e: MouseEvent<HTMLDivElement>) => void | Promise<void>;
  onCharacterPointerDown: (e: MouseEvent<HTMLButtonElement>) => void;
  onCharacterPointerMove: (e: MouseEvent<HTMLButtonElement>) => void;
  onCharacterPointerUp: () => void;
  onPetPointerDown: (e: MouseEvent<HTMLButtonElement>) => void;
  onPetPointerMove: (e: MouseEvent<HTMLButtonElement>) => void;
  onPetPointerUp: () => void;
  onCancelCompactMenuClose: () => void;
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
  onPetPrimaryClick: () => void | Promise<void>;
  /** 同步判断本次 click 是否只是拖拽收尾（用于跳过点击反馈动画）。 */
  onIsPetClickSuppressed: () => boolean;
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
  petThought,
  petThoughtQueue,
  petThoughtCount,
  petThoughtPlacement,
  arePetThoughtsCollapsed,
  compactSize,
  compactStyle,
  entries,
  isCompactAppearanceOpen,
  isCompactMenuOpen,
  isCompactModelOpen,
  isCompactQueryOpen,
  isCompactReplyLoading,
  isCharacterDragging,
  previewCharacterScale,
  characterDragMotion,
  omniSmallIconSrc,
  compactMenuSide,
  compactSubmenuSide,
  onCharacterContextMenu,
  onCharacterPointerDown,
  onCharacterPointerMove,
  onCharacterPointerUp,
  onPetPointerDown,
  onPetPointerMove,
  onPetPointerUp,
  onCancelCompactMenuClose,
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
  onPetPrimaryClick,
  onIsPetClickSuppressed,
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
  const isPetThoughtToggleVisible =
    isPetAppearance &&
    petThoughtCount > 0 &&
    !isCharacterDragging &&
    !isCompactMenuOpen &&
    !isCompactQueryOpen &&
    !isCompactReplyLoading &&
    !compactReply;
  const resolvedPetThoughtQueue = petThoughtQueue.length > 0 ? petThoughtQueue : petThought ? [petThought] : [];
  const visiblePetThoughts = petThoughtPlacement === "top" ? [...resolvedPetThoughtQueue].reverse() : resolvedPetThoughtQueue;
  const isInlinePetThoughtStackVisible =
    isPetThoughtToggleVisible && resolvedPetThoughtQueue.length > 0 && typeof previewCharacterScale !== "number";
  const petViewportSize = getCodexPetViewportSize(compactSize);
  const petRenderHeight = petViewportSize.height;
  const petRenderWidth = petViewportSize.width;
  const petThoughtBubbleWidth = 250;
  const petThoughtSafeGap = 12;
  const compactStyleVars = compactStyle as CSSProperties & Record<string, string | number | undefined>;
  const rawPetThoughtViewportOffsetX = compactStyleVars["--pet-viewport-offset-x"];
  const parsedPetThoughtViewportOffsetX =
    typeof rawPetThoughtViewportOffsetX === "number"
      ? rawPetThoughtViewportOffsetX
      : typeof rawPetThoughtViewportOffsetX === "string"
        ? Number.parseFloat(rawPetThoughtViewportOffsetX)
        : 0;
  const petThoughtViewportOffsetX = Number.isFinite(parsedPetThoughtViewportOffsetX) ? parsedPetThoughtViewportOffsetX : 0;
  const petThoughtViewportWidth = compactSize.width + petThoughtViewportOffsetX * 2;
  const petThoughtStackMinLeft = -petThoughtViewportOffsetX + petThoughtSafeGap;
  const petThoughtStackMaxLeft = compactSize.width + petThoughtViewportOffsetX - petThoughtBubbleWidth - petThoughtSafeGap;
  const petThoughtStackPreferredLeft = (petThoughtViewportWidth - petThoughtBubbleWidth) / 2 - petThoughtViewportOffsetX;
  const petThoughtStackLeft = Math.round(
    Math.min(petThoughtStackMaxLeft, Math.max(petThoughtStackMinLeft, petThoughtStackPreferredLeft))
  );
  const petThoughtTailX = Math.max(
    18,
    Math.min(
      petThoughtBubbleWidth - 18,
      Math.round(petRenderWidth * 0.74 - petThoughtStackLeft)
    )
  );
  const petButtonRef = useRef<HTMLButtonElement | null>(null);
  const petAnchorRef = useRef<HTMLDivElement | null>(null);
  const [petCelebrateReply, setPetCelebrateReply] = useState(false);
  const [petClickBounce, setPetClickBounce] = useState(false);
  const [isPetHovered, setIsPetHovered] = useState(false);
  const [petWavingHold, setPetWavingHold] = useState(false);
  const petHoverGraceRef = useRef<number | null>(null);
  const petMenuOpenGraceRef = useRef<number>(0);
  // After the menu opens (hover mode), the window resizes to make room for it.
  // That resize can momentarily push the cursor out of the hover zone and fire a
  // spurious mouseleave, which would flip the pet back to idle and (after the
  // short grace) close the menu — then re-open on re-enter, producing the
  // "jitter/flash" loop. This timestamp keeps the menu + pet state stable for a
  // while right after opening so the resize settles without flipping state.
  const petMenuStableUntilRef = useRef<number>(0);
  const PET_MENU_STABLE_MS = 700;
  // Debounced close timer for hover mode: the menu closes only when the pointer
  // truly leaves the whole floating window (root onMouseLeave), not when it
  // merely moves across the pet body. Moving onto the menu (a child) never
  // fires root onMouseLeave, which is what stops the open/close jitter.
  const petHoverCloseTimerRef = useRef<number | null>(null);
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

  const isPointerInsideVisibleFloatingUi = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    return Boolean(
      target.closest(
        ".compact-menu, .compact-submenu, .compact-query, .compact-reply, .compact-menu-anchor, .compact-button--pet, .pet-thought-compact-toggle, .compact-pet-thought-stack"
      )
    );
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
        // The pet button owns its own press: never intercept it for panel
        // dismissal. Otherwise, whenever a menu/panel is open (e.g. hover mode
        // opens the menu the moment you hover), the capture-phase
        // stopPropagation below swallows the pet's mousedown and dragging
        // becomes completely unresponsive.
        if (isPetAppearance && Boolean(target.closest(".compact-button--pet"))) {
          return;
        }
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
      onMouseEnter={() => {
        // Cancel a pending hover-close if the pointer re-enters the window.
        if (petHoverCloseTimerRef.current !== null) {
          window.clearTimeout(petHoverCloseTimerRef.current);
          petHoverCloseTimerRef.current = null;
        }
      }}
      onMouseMove={(event) => {
        if (!isCompactMenuOpen || isCompactQueryOpen) {
          return;
        }
        // Ignore spurious moves that immediately follow the open-menu resize.
        if (Date.now() < petMenuStableUntilRef.current) {
          return;
        }
        if (isPointerInsideVisibleFloatingUi(event.target)) {
          if (petHoverCloseTimerRef.current !== null) {
            window.clearTimeout(petHoverCloseTimerRef.current);
            petHoverCloseTimerRef.current = null;
          }
          return;
        }
        // Pointer is inside the window but outside the menu/pet area: schedule
        // a close so that moving from a submenu back onto the desktop (or any
        // blank transparent area) dismisses the whole menu.
        if (petHoverCloseTimerRef.current === null) {
          petHoverCloseTimerRef.current = window.setTimeout(() => {
            if (isCompactMenuOpen && !isCompactQueryOpen) {
              onCloseCompactMenu();
            }
            petHoverCloseTimerRef.current = null;
          }, 140);
        }
      }}
      onMouseLeave={() => {
        if (isCompactQueryOpen || !isCompactMenuOpen) {
          return;
        }
        // The pointer left the *entire* floating window. Because onMouseLeave
        // does not fire when moving onto a child, this only triggers on a
        // genuine exit.
        if (petHoverCloseTimerRef.current !== null) {
          window.clearTimeout(petHoverCloseTimerRef.current);
        }
        petHoverCloseTimerRef.current = window.setTimeout(() => {
          if (isCompactMenuOpen && !isCompactQueryOpen) {
            onCloseCompactMenu();
          }
          petHoverCloseTimerRef.current = null;
        }, 160);
      }}
    >
      <div
        className={`compact-hover-zone ${isAnimatedAppearance ? "compact-hover-zone--character" : ""} ${
          isPetAppearance ? "compact-hover-zone--pet" : ""
        }`}
        onMouseMove={(event) => {
          if (isPetAppearance) {
            // 宠物菜单的关闭由根 div 的 onMouseMove 统一处理（含 140ms 防抖）
            return;
          }
          // 菜单由进入/离开整个悬浮窗口（根 div 处理器）控制。
          if (isCompactMenuOpen && isPointerInsideVisibleFloatingUi(event.target)) {
            onCancelCompactMenuClose();
          }
        }}
        onMouseEnter={
          (e) => {
            if (isPetAppearance) {
              if (petHoverGraceRef.current !== null) {
                window.clearTimeout(petHoverGraceRef.current);
                petHoverGraceRef.current = null;
              }
              setIsPetHovered(true);
              // 宠物菜单改为右键展开，hover 不再自动打开。
              return;
            }
            if (!isCompactQueryOpen) {
              onCancelCompactMenuClose();
              const anchor = resolveAnchorEdge(e.currentTarget);
              petMenuOpenGraceRef.current = Date.now();
              petMenuStableUntilRef.current = Date.now() + PET_MENU_STABLE_MS;
              void onOpenCompactMenu(anchor?.x ?? e.clientX, anchor?.y ?? e.clientY);
            }
          }
        }
        onMouseLeave={
          () => {
            const withinStableWindow = isPetAppearance && Date.now() < petMenuStableUntilRef.current;
            if (isPetAppearance) {
              if (withinStableWindow) {
                // Ignore the spurious leave caused by the open-menu resize: keep
                // the pet waving and do not schedule an idle flip.
              } else {
                if (petHoverGraceRef.current !== null) {
                  window.clearTimeout(petHoverGraceRef.current);
                }
                petHoverGraceRef.current = window.setTimeout(() => {
                  setIsPetHovered(false);
                  petHoverGraceRef.current = null;
                }, 140);
              }
            }
            // Hover-mode menu close is now owned by the root onMouseLeave
            // (leaving the whole floating window), so nothing to do here.
          }
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
          <div
            className="compact-menu-anchor no-drag"
            onContextMenu={
              isAnimatedAppearance || isPetAppearance
                ? (e) => {
                    if (isPetAppearance) {
                      // 右键展开宠物菜单时设置稳定窗口，避免接着的 resize 误关。
                      petMenuStableUntilRef.current = Date.now() + PET_MENU_STABLE_MS;
                    }
                    void onCharacterContextMenu(e);
                  }
                : undefined
            }
          >
            <button
              ref={petButtonRef}
              type="button"
              className={`compact-button compact-button--brand no-drag ${isAnimatedAppearance ? "compact-button--character" : ""} ${
                isPetAppearance ? "compact-button--pet" : ""
              }`}
              onMouseDown={
                isPetAppearance
                  ? onPetPointerDown
                  : isAnimatedAppearance
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
                isPetAppearance
                  ? (e) => {
                      const nextCursor = onPointerHitTest(e.currentTarget, e.clientX, e.clientY) ? "grab" : "default";
                      e.currentTarget.style.cursor = nextCursor;
                      onPetPointerMove(e);
                    }
                  : isAnimatedAppearance
                  ? (e) => {
                      const nextCursor = onPointerHitTest(e.currentTarget, e.clientX, e.clientY) ? "grab" : "default";
                      e.currentTarget.style.cursor = nextCursor;
                      onCharacterPointerMove(e);
                    }
                  : undefined
              }
              onMouseUp={isPetAppearance ? onPetPointerUp : isAnimatedAppearance ? onCharacterPointerUp : undefined}
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
                  // 拖拽收尾触发的 click 不做点击反馈（回弹动画），否则看起来
                  // 像是「拖完还被点了一下」。
                  if (!onIsPetClickSuppressed()) {
                    setPetClickBounce(true);
                  }
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

            {isPetThoughtToggleVisible ? (
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

            {isInlinePetThoughtStackVisible ? (
              <div
                className={`compact-pet-thought-stack compact-pet-thought-stack--${petThoughtPlacement} ${
                  arePetThoughtsCollapsed ? "compact-pet-thought-stack--collapsed" : ""
                } no-drag`}
                style={
                  {
                    "--pet-thought-inline-width": `${petThoughtBubbleWidth}px`,
                    "--pet-thought-inline-safe-gap": `${petThoughtSafeGap}px`,
                    "--pet-thought-inline-left": `${petThoughtStackLeft}px`,
                    "--pet-thought-tail-x": `${petThoughtTailX}px`,
                  } as CSSProperties
                }
              >
                {visiblePetThoughts.slice(0, 3).map((thought) => (
                  <PetThoughtBubble
                    key={getPetThoughtKey(thought)}
                    thought={thought}
                    placement={petThoughtPlacement}
                    usePortal={false}
                    stacked
                    collapsed={arePetThoughtsCollapsed}
                  />
                ))}
              </div>
            ) : null}

            {isCompactMenuOpen && !isPetAppearance && (
              <CompactMenu
                appearanceOptions={appearanceOptions}
                menuPosition={null}
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

        {isCompactMenuOpen && isPetAppearance && (
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

      </div>
    </div>
  );
}
