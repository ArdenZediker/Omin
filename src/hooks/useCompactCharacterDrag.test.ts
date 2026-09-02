import { act, renderHook } from "@testing-library/react";
import { useRef } from "react";
import type * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCompactCharacterDrag } from "./useCompactCharacterDrag";

const mocks = vi.hoisted(() => ({
  cursorPosition: vi.fn(async () => ({ x: 160, y: 100 })),
  appWindow: {
    setPosition: vi.fn(async () => undefined),
    outerPosition: vi.fn(async () => ({ x: 0, y: 0, toLogical: () => ({ x: 0, y: 0 }) })),
    scaleFactor: vi.fn(async () => 1),
  },
  getByLabel: vi.fn(async () => null),
  persistCompactPosition: vi.fn(),
  updatePetThoughtWindowForRect: vi.fn(
    async (_rect: { left: number; top: number; width: number; height: number }) => undefined
  ),
}));

vi.mock("@tauri-apps/api/window", () => ({ cursorPosition: () => mocks.cursorPosition() }));
vi.mock("@tauri-apps/api/dpi", () => ({
  PhysicalPosition: class {
    constructor(
      public x: number,
      public y: number
    ) {}
  },
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: () => mocks.getByLabel() },
}));
vi.mock("./compactWindowRuntime", () => ({ appWindow: mocks.appWindow }));
vi.mock("./compactInteractionGuards", () => ({ clearPendingDragTimer: () => undefined }));
vi.mock("../app/window", () => ({
  isCharacterPointerInHitArea: () => true,
  persistCompactPosition: (position: { x: number; y: number }) => mocks.persistCompactPosition(position),
}));
vi.mock("../app/constants", () => ({ MAIN_WINDOW_LABEL: "main" }));
vi.mock("../app/pets/codexPetSizing", () => ({
  PET_WINDOW_DECORATION_MARGIN_TOP: 0,
  PET_WINDOW_TOP_OVERSCROLL: 0,
}));
vi.mock("./compactWindowGeometry", () => ({
  resolveCharacterDragMotion: () => "running" as const,
  toVisualPetWindowY: (y: number) => y,
  waitForNextAnimationFrame: () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
}));

type DragArgs = Parameters<typeof useCompactCharacterDrag>[0];

function makeMouseEvent(
  overrides: Partial<React.MouseEvent<HTMLButtonElement>> = {}
): React.MouseEvent<HTMLButtonElement> {
  return {
    button: 0,
    screenX: 100,
    screenY: 100,
    clientX: 10,
    clientY: 10,
    currentTarget: document.createElement("button"),
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    ...overrides,
  } as unknown as React.MouseEvent<HTMLButtonElement>;
}

function setupDrag() {
  const onRestoreMain = vi.fn(async () => undefined);
  const resetCompactFloatingUi = vi.fn();
  const rendered = renderHook(() => {
    const compactMenuCloseTimerRef = useRef<number | null>(null);
    const characterPointerDownRef = useRef<{ screenX: number; screenY: number } | null>(null);
    const drag = useCompactCharacterDrag({
      compactSize: { width: 160, height: 160 },
      onRestoreMain,
      resetCompactFloatingUi,
      setIsCharacterDragging: () => undefined,
      setCharacterDragMotion: () => undefined,
      markCompactInteraction: () => undefined,
      suppressCompactBlur: () => undefined,
      raiseCompactWindow: async () => undefined,
      releaseCharacterDragWindowMove: () => undefined,
      hidePetThoughtWindowForDrag: async () => undefined,
      updatePetThoughtWindowForRect: (rect: { left: number; top: number; width: number; height: number }) =>
        mocks.updatePetThoughtWindowForRect(rect),
      compactMenuCloseTimerRef,
      characterPointerDownRef,
      characterDragOriginRef: useRef(null),
      characterDragRafRef: useRef<number | null>(null),
      characterDragPendingRef: useRef(null),
      characterDragMoveDrainRef: useRef<Promise<void> | null>(null),
      characterDragWindowMoveActiveRef: useRef(false),
      characterDragLastTargetRef: useRef(null),
      characterDragLastPersistedRef: useRef(null),
      characterPointerMovedRef: useRef(false),
      lastCharacterDragPointerRef: useRef(null),
      characterDragLastHandledPointerRef: useRef(null),
      characterDragMotionAccumRef: useRef({ x: 0, y: 0 }),
      characterDragMotionRef: useRef(null),
      isCharacterDraggingRef: useRef(false),
      compactInternalMoveRef: useRef(false),
      suppressPetClickUntilRef: useRef(0),
      lastAppliedPetViewportOffsetRef: useRef({ x: 0, y: 0 }),
    } as unknown as DragArgs);

    return { drag, characterPointerDownRef };
  });

  return { ...rendered, onRestoreMain, resetCompactFloatingUi };
}

describe("useCompactCharacterDrag 拖拽与点击判定", () => {
  beforeEach(() => {
    mocks.persistCompactPosition.mockClear();
    mocks.updatePetThoughtWindowForRect.mockClear();
    mocks.getByLabel.mockClear();
  });

  it("拖动后紧随的 click 被吞掉，不切换主界面", async () => {
    const { result, onRestoreMain } = setupDrag();

    act(() => {
      result.current.drag.handlePetPointerDown(makeMouseEvent());
    });
    act(() => {
      expect(result.current.drag.continueCharacterDrag(260, 100)).toBe(true);
    });
    // 关键：松手后**不 await**。真实浏览器里 click 紧跟 mouseup 派发，此时
    // handleCharacterPointerUp 还挂在 await 上（等 rAF / IPC），抑制标记必须
    // 在此之前就已经同步写好，否则主界面会被误切换。
    act(() => {
      void result.current.drag.handleCharacterPointerUp();
    });

    expect(result.current.drag.shouldSuppressPetClick()).toBe(true);
    await act(async () => {
      await result.current.drag.handlePetPrimaryClick();
    });
    expect(onRestoreMain).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
  });

  it("松手收尾先跑完（click 晚到）时同样不切换主界面", async () => {
    const { result, onRestoreMain } = setupDrag();

    act(() => {
      result.current.drag.handlePetPointerDown(makeMouseEvent());
    });
    act(() => {
      result.current.drag.continueCharacterDrag(260, 100);
    });
    // 另一种时序：等收尾逻辑（落位 + 持久化）全部跑完，ref 已被重置，此时
    // 只能靠松手瞬间同步写入的时间窗来拦住迟到的 click。
    await act(async () => {
      await result.current.drag.handleCharacterPointerUp();
    });

    expect(result.current.drag.shouldSuppressPetClick()).toBe(true);
    await act(async () => {
      await result.current.drag.handlePetPrimaryClick();
    });
    expect(onRestoreMain).not.toHaveBeenCalled();
  });

  it("没有位移的纯点击仍然切换主界面", async () => {
    const { result, onRestoreMain } = setupDrag();

    act(() => {
      result.current.drag.handlePetPointerDown(makeMouseEvent());
    });
    expect(result.current.drag.shouldSuppressPetClick()).toBe(false);
    await act(async () => {
      await result.current.drag.handlePetPrimaryClick();
    });

    expect(onRestoreMain).toHaveBeenCalledWith(false, { restoreGeometry: false });
  });

  it("低于拖拽阈值（4px）的抖动仍算点击", async () => {
    const { result, onRestoreMain } = setupDrag();

    act(() => {
      result.current.drag.handlePetPointerDown(makeMouseEvent());
    });
    act(() => {
      expect(result.current.drag.continueCharacterDrag(103, 100)).toBe(false);
    });
    act(() => {
      void result.current.drag.handleCharacterPointerUp();
    });

    expect(result.current.drag.shouldSuppressPetClick()).toBe(false);
    await act(async () => {
      await result.current.drag.handlePetPrimaryClick();
    });
    expect(onRestoreMain).toHaveBeenCalledWith(false, { restoreGeometry: false });
  });
});
