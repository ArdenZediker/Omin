import { create } from "zustand";

/**
 * 跨组件共享的轻量 UI 状态（P2-#14 引入响应式状态管理）。
 *
 * 使用 zustand 的 `create` 实现。对外暴露 `useUiStore` hook，支持两种用法：
 * - `const { sidebarCollapsed } = useUiStore()` 取全部状态；
 * - `const collapsed = useUiStore((s) => s.sidebarCollapsed)` 用 selector 精准订阅。
 *
 * 命令式调用（非组件内）可用 `useUiStore.getState().setGlobalBusy(true)`。
 */
export type UiState = {
  sidebarCollapsed: boolean;
  commandPaletteOpen: boolean;
  /** 全局加载指示，供多入口并发任务统一展示。 */
  globalBusy: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (value: boolean) => void;
  setCommandPaletteOpen: (value: boolean) => void;
  setGlobalBusy: (value: boolean) => void;
};

export const useUiStore = create<UiState>((set) => ({
  sidebarCollapsed: false,
  commandPaletteOpen: false,
  globalBusy: false,
  toggleSidebar: () =>
    set((prev) => ({ sidebarCollapsed: !prev.sidebarCollapsed })),
  setSidebarCollapsed: (value) => set({ sidebarCollapsed: value }),
  setCommandPaletteOpen: (value) => set({ commandPaletteOpen: value }),
  setGlobalBusy: (value) => set({ globalBusy: value }),
}));
