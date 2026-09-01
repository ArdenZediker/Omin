/**
 * Cbteams (skill suites) 浏览组件占位符。
 *
 * ⚠️ TODO（同事待补）：src-tauri/src/cbteams.rs 已添加 +150/-285 行 Rust 代码
 * 把 suites 浏览拆为独立模块，但对应的 React 浏览组件还没有建。本 placeholder
 * 只用于保证 build 通过，让其它改动（KB header 居中 / 工具栏对齐 / 卡片网格）
 * 能够跑过 tsc + vitest + vite build 三件套验证。
 *
 * 等同事把 CbteamsBrowser 真实实现放进来后，本文件应该被覆盖删除。
 */
export default function CbteamsBrowser() {
  return (
    <div className="plugin-marketplace__suites-placeholder">
      <div className="text-base font-semibold text-[var(--omni-app-text)]">
        套件浏览
      </div>
      <div className="mt-2 text-sm text-[var(--omni-app-muted)]">
        Cbteams 浏览组件待补充（src-tauri/src/cbteams.rs 已就位，前端组件待迁移）。
      </div>
    </div>
  );
}
