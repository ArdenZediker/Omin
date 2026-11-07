import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { monitorFromPoint } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { BasicSettings, ExternalChatEntry } from "./types";
import type { CompactAppearance } from "../hooks/useCompactWindowState";
import {
  COMPACT_MENU_EDGE_PADDING,
  COMPACT_MENU_GAP,
  COMPACT_MENU_SUBMENU_HEIGHT,
  COMPACT_MENU_WIDTH,
  clampToRange,
  getCompactMenuTotalWidth,
} from "../hooks/compactMenuGeometry";
import { COMPACT_MENU_WINDOW_LABEL } from "./constants";
import { getPhysicalWorkArea } from "./window";

const COMPACT_MENU_WINDOW_WIDTH =
  getCompactMenuTotalWidth() + COMPACT_MENU_EDGE_PADDING * 2;
const COMPACT_MENU_WINDOW_HEIGHT =
  COMPACT_MENU_SUBMENU_HEIGHT + COMPACT_MENU_EDGE_PADDING * 2;
const MENU_ANCHOR_OFFSET_Y = 34;
const COMPACT_MENU_WARMUP_MS = 180;
const COMPACT_MENU_WARMUP_POSITION = { x: -30000, y: -30000 };
export const COMPACT_MENU_WINDOW_CONFIG_KEY = "omni_compact_menu_window_config";
export const COMPACT_MENU_WINDOW_BOOTSTRAP_READY_EVENT = "omni-compact-menu-bootstrap-ready";
export const COMPACT_MENU_WINDOW_RENDER_READY_EVENT = "omni-compact-menu-render-ready";

type CompactMenuSide = "left" | "right";

type PhysicalRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type CompactMenuHostBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type CompactMenuWindowLayout = {
  side: CompactMenuSide;
  x: number;
  y: number;
  width: number;
  height: number;
  menuPosition: { x: number; y: number };
};

export type CompactMenuWindowShowPayload = {
  renderId: string;
  compactAppearance: CompactAppearance;
  characterScale: number;
  followCursorScreen: boolean;
  menuSide: CompactMenuSide;
  submenuSide: CompactMenuSide;
  menuPosition: { x: number; y: number };
};

export type CompactMenuWindowRenderReadyPayload = {
  renderId: string;
};

export type CompactMenuWindowAction =
  | { type: "appearance"; appearance: CompactAppearance }
  | { type: "external-chat"; entryId: ExternalChatEntry["id"] }
  | { type: "settings" }
  | { type: "scale-reset" }
  | { type: "update-basic-settings"; patch: Partial<BasicSettings> }
  | { type: "close" };

export function resolveCompactMenuWindowLayout(
  anchor: { x: number; y: number },
  workArea: PhysicalRect,
  scaleFactor: number,
  hostBounds?: CompactMenuHostBounds
): CompactMenuWindowLayout {
  const scale = scaleFactor > 0 ? scaleFactor : 1;
  const width = Math.round(COMPACT_MENU_WINDOW_WIDTH * scale);
  const height = Math.round(COMPACT_MENU_WINDOW_HEIGHT * scale);
  const padding = Math.round(COMPACT_MENU_EDGE_PADDING * scale);
  const gap = Math.round(COMPACT_MENU_GAP * scale);
  const menuWidth = Math.round(COMPACT_MENU_WIDTH * scale);
  const submenuWidth = Math.round((COMPACT_MENU_WINDOW_WIDTH - COMPACT_MENU_EDGE_PADDING * 2 - COMPACT_MENU_WIDTH - COMPACT_MENU_GAP) * scale);
  const hostRight = hostBounds ? hostBounds.x + hostBounds.width : anchor.x;
  const hostLeft = hostBounds ? hostBounds.x : anchor.x;
  const hostCenterX = hostBounds ? hostBounds.x + hostBounds.width / 2 : anchor.x;
  const rightSpace = workArea.right - hostRight;
  const leftSpace = hostLeft - workArea.left;
  const side: CompactMenuSide =
    rightSpace >= width || (leftSpace < width && workArea.right - hostCenterX >= hostCenterX - workArea.left)
      ? "right"
      : "left";
  const menuX = side === "right" ? padding : padding + submenuWidth + gap;
  const desiredX =
    side === "right"
      ? hostRight + gap - menuX
      : hostLeft - gap - (menuX + menuWidth);
  const desiredY = anchor.y - Math.round(MENU_ANCHOR_OFFSET_Y * scale);
  const maxX = Math.max(workArea.left, workArea.right - width);
  const maxY = Math.max(workArea.top, workArea.bottom - height);

  return {
    side,
    x: Math.round(clampToRange(desiredX, workArea.left, maxX)),
    y: Math.round(clampToRange(desiredY, workArea.top, maxY)),
    width,
    height,
    menuPosition: {
      x: Math.round(menuX / scale),
      y: COMPACT_MENU_EDGE_PADDING,
    },
  };
}

async function ensureCompactMenuWindow() {
  let menuWindow = await WebviewWindow.getByLabel(COMPACT_MENU_WINDOW_LABEL);
  if (menuWindow) {
    return menuWindow;
  }

  let resolveBootstrap: (() => void) | undefined;
  const bootstrapReady = new Promise<void>((resolve) => {
    resolveBootstrap = resolve;
  });
  const unlistenBootstrap = await listen<{ label?: string }>(
    COMPACT_MENU_WINDOW_BOOTSTRAP_READY_EVENT,
    (event) => {
      if (!event.payload?.label || event.payload.label === COMPACT_MENU_WINDOW_LABEL) {
        resolveBootstrap?.();
      }
    }
  );

  menuWindow = new WebviewWindow(COMPACT_MENU_WINDOW_LABEL, {
    url: "/?compactMenu=1",
    title: "Omni Compact Menu",
    width: COMPACT_MENU_WINDOW_WIDTH,
    height: COMPACT_MENU_WINDOW_HEIGHT,
    minWidth: 1,
    minHeight: 1,
    decorations: false,
    transparent: true,
    backgroundColor: [0, 0, 0, 0],
    shadow: false,
    alwaysOnTop: true,
    visibleOnAllWorkspaces: true,
    skipTaskbar: true,
    resizable: false,
    visible: false,
    focus: false,
    center: false,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      menuWindow?.once("tauri://created", () => resolve());
      menuWindow?.once("tauri://error", (event) => reject(event.payload));
    });
    await Promise.race([
      bootstrapReady,
      new Promise<void>((resolve) => window.setTimeout(resolve, 3000)),
    ]);
    // The first visible presentation of a transparent WebView2 surface can be
    // a half-composited frame. Present it once fully off-screen so the first
    // user-visible show already has a warm compositor and complete paint.
    await menuWindow.setPosition(
      new PhysicalPosition(
        COMPACT_MENU_WARMUP_POSITION.x,
        COMPACT_MENU_WARMUP_POSITION.y
      )
    );
    await menuWindow.show();
    await new Promise<void>((resolve) => window.setTimeout(resolve, COMPACT_MENU_WARMUP_MS));
    await menuWindow.hide();
  } finally {
    unlistenBootstrap();
  }
  return menuWindow;
}

async function createMenuRenderWaiter(renderId: string) {
  let settled = false;
  let resolveRendered: (() => void) | undefined;
  const rendered = new Promise<void>((resolve) => {
    resolveRendered = resolve;
  });
  const unlisten = await listen<CompactMenuWindowRenderReadyPayload>(
    COMPACT_MENU_WINDOW_RENDER_READY_EVENT,
    (event) => {
      if (event.payload?.renderId === renderId) {
        settled = true;
        resolveRendered?.();
      }
    }
  );

  return {
    wait: async () => {
      let timeoutId: number | undefined;
      try {
        await Promise.race([
          rendered,
          new Promise<void>((resolve) => {
            timeoutId = window.setTimeout(resolve, 1200);
          }),
        ]);
      } finally {
        if (timeoutId !== undefined) {
          window.clearTimeout(timeoutId);
        }
        settled = true;
        unlisten();
      }
    },
    dispose: () => {
      if (!settled) {
        unlisten();
      }
    },
  };
}

export async function showCompactMenuWindow(
  anchor: { x: number; y: number },
  payload: Omit<
    CompactMenuWindowShowPayload,
    "renderId" | "menuSide" | "submenuSide" | "menuPosition"
  >,
  hostBounds?: CompactMenuHostBounds
) {
  const monitor = await monitorFromPoint(Math.round(anchor.x), Math.round(anchor.y));
  if (!monitor) {
    throw new Error("无法定位紧凑菜单所在显示器");
  }
  const workArea = getPhysicalWorkArea(monitor);
  const layout = resolveCompactMenuWindowLayout(
    anchor,
    workArea,
    monitor.scaleFactor || 1,
    hostBounds
  );
  const showPayload = {
    renderId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ...payload,
    menuSide: layout.side,
    submenuSide: layout.side,
    menuPosition: layout.menuPosition,
  } satisfies CompactMenuWindowShowPayload;
  localStorage.setItem(COMPACT_MENU_WINDOW_CONFIG_KEY, JSON.stringify(showPayload));
  const menuWindow = await ensureCompactMenuWindow();

  // Keep every native mutation behind the hidden window. Once the window is
  // visible, do not move, resize, refocus, or change its z-order; each of those
  // operations can make a transparent WebView2 surface flash for one frame.
  await menuWindow.hide().catch(() => undefined);
  await menuWindow.setSize(new PhysicalSize(layout.width, layout.height));
  await menuWindow.setPosition(new PhysicalPosition(layout.x, layout.y));
  await menuWindow.setAlwaysOnTop(true);
  const renderWaiter = await createMenuRenderWaiter(showPayload.renderId);
  try {
    await menuWindow.emit("omni-compact-menu-show", showPayload).catch(() => undefined);
    await renderWaiter.wait();
  } finally {
    renderWaiter.dispose();
  }
  await menuWindow.show();
  return layout;
}

export async function hideCompactMenuWindow() {
  const menuWindow = await WebviewWindow.getByLabel(COMPACT_MENU_WINDOW_LABEL);
  await menuWindow?.hide().catch(() => undefined);
}
