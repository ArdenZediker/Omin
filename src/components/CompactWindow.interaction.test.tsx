import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import CompactWindow from "./CompactWindow";

vi.mock("./compact/CompactMenu", () => ({
  default: ({ isGeometryReady }: { isGeometryReady: boolean }) => (
    <div className="compact-menu" data-geometry-ready={isGeometryReady}>Menu</div>
  ),
}));

const onOpenCompactMenu = vi.fn();
const onCloseCompactMenuNow = vi.fn();
const onCloseCompactMenu = vi.fn();
const onSetArePetThoughtsCollapsed = vi.fn();

function makeProps(): ComponentProps<typeof CompactWindow> {
  const noop = vi.fn();
  return {
    appearanceOptions: [],
    basicSettings: { followCursorScreen: false } as ComponentProps<typeof CompactWindow>["basicSettings"],
    menuPosition: null,
    codexPetPackage: null,
    characterScale: 1,
    compactAppearance: "default",
    compactQuery: "",
    compactReply: null,
    petThought: null,
    petThoughtQueue: [],
    petThoughtCount: 0,
    petThoughtPlacement: "top",
    arePetThoughtsCollapsed: false,
    canRenderPetThoughtBubbles: false,
    compactSize: { width: 64, height: 64 },
    compactStyle: {},
    entries: [],
    isCompactAppearanceOpen: false,
    isCompactMenuOpen: false,
    isCompactModelOpen: false,
    isCompactQueryOpen: false,
    isCompactReplyLoading: false,
    isCharacterDragging: false,
    previewCharacterScale: null,
    compactMenuSide: "right",
    visibleCompactMenuSide: "right",
    compactSubmenuSide: "right",
    isNormalCompactGeometryReady: true,
    characterDragMotion: null,
    omniSmallIconSrc: "icon.png",
    onCharacterContextMenu: noop,
    onCharacterPointerDown: noop,
    onCharacterPointerMove: noop,
    onCharacterPointerUp: noop,
    onPetPointerDown: noop,
    onPetPointerMove: noop,
    onPetPointerUp: noop,
    onCancelCompactMenuClose: noop,
    onCloseCompactMenu,
    onCloseCompactMenuNow,
    onCompactAppearanceChange: noop,
    onCompactDrag: noop,
    onCompactQuerySubmit: noop,
    onCompactScaleReset: noop,
    onCompactWheel: noop,
    onOpenCompactMenu,
    onOpenCompactQuery: noop,
    onOpenExternalChat: noop,
    onPetPrimaryClick: noop,
    onIsPetClickSuppressed: () => false,
    onOpenSettingsFromCompact: noop,
    onPointerHitTest: () => true,
    onSetCompactQuery: noop,
    onSetCompactReply: noop,
    onSetArePetThoughtsCollapsed,
    onUpdateBasicSettings: noop,
    onSetIsCompactAppearanceOpen: noop,
    onSetIsCompactModelOpen: noop,
    onSetIsCompactQueryOpen: noop,
    onSetIsCompactReplyLoading: noop,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("CompactWindow ball interaction", () => {
  it("keeps the ball visible until the native query viewport has settled", () => {
    const props = makeProps();
    const { container } = render(
      <CompactWindow {...props} isCompactQueryOpen isNormalCompactGeometryReady={false} />
    );

    expect(container.querySelector(".compact-shell--query-open")).toBeNull();
    expect(screen.getByRole("button", { name: "打开菜单" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "快速提问" })).toBeNull();
  });

  it("replaces the ball bar with a single input bar and keeps input clicks open", () => {
    const props = makeProps();
    const { container } = render(<CompactWindow {...props} isCompactQueryOpen />);
    expect(container.querySelector(".compact-shell--query-open")).not.toBeNull();
    const input = screen.getByRole("textbox", { name: "快速提问" });
    fireEvent.mouseDown(input);
    expect(onCloseCompactMenuNow).not.toHaveBeenCalled();
    expect(props.onSetIsCompactQueryOpen).not.toHaveBeenCalled();
  });

  it("opens only on click, so moving across the ball cannot trigger a resize during a drag", () => {
    const props = makeProps();
    const { container, rerender } = render(<CompactWindow {...props} />);
    const ball = screen.getByRole("button", { name: "打开菜单" });
    fireEvent.mouseEnter(container.querySelector(".compact-hover-zone")!);
    fireEvent.mouseDown(container.querySelector(".compact-hover-zone")!);
    expect(onOpenCompactMenu).not.toHaveBeenCalled();
    fireEvent.click(ball);
    expect(onOpenCompactMenu).toHaveBeenCalledTimes(1);

    rerender(<CompactWindow {...props} isCompactMenuOpen />);
    fireEvent.mouseDown(ball);
    fireEvent.click(ball);
    expect(onCloseCompactMenuNow).toHaveBeenCalledTimes(1);
    expect(onOpenCompactMenu).toHaveBeenCalledTimes(1);
  });

  it("does not let the floating-ball host close the external menu on mouseleave", () => {
    vi.useFakeTimers();
    const props = makeProps();
    const { container, rerender } = render(<CompactWindow {...props} />);
    const root = container.querySelector(".compact-shell")!;
    fireEvent.click(screen.getByRole("button", { name: "打开菜单" }));
    rerender(<CompactWindow {...props} isCompactMenuOpen />);
    fireEvent.mouseLeave(root);
    vi.advanceTimersByTime(1000);
    expect(onCloseCompactMenu).not.toHaveBeenCalled();
  });

  it("never mounts the normal menu inside the floating-ball host", () => {
    const props = makeProps();
    const { container, rerender } = render(
      <CompactWindow {...props} isCompactMenuOpen isNormalCompactGeometryReady={false} />
    );

    expect(container.querySelector(".compact-menu")).toBeNull();

    rerender(
      <CompactWindow {...props} isCompactMenuOpen isNormalCompactGeometryReady />
    );

    expect(container.querySelector(".compact-menu")).toBeNull();
  });
});
