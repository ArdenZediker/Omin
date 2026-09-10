import { invoke } from "@tauri-apps/api/core";
import { canonicalizeShortcut } from "./shortcuts";

export type GlobalShortcutRegistration = {
  /** 是否成功注册为 OS 级全局热键。 */
  ok: boolean;
  /** 失败原因（供设置页提示），成功时为空。 */
  error?: string;
};

function canUseTauriInvoke() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 注册「唤起主界面」的 OS 全局快捷键。
 *
 * 全局热键在应用未聚焦时同样触发——这是 DOM keydown 做不到的，也是它存在的唯一理由。
 * 代价是占用一条系统级组合键：若已被其它程序占用会注册失败，此时返回 `ok: false`，
 * 调用方应回落到 DOM 监听（即仅窗口聚焦时生效），并把 `error` 展示给用户，
 * 而不是让快捷键静默失效。
 *
 * 传入未设置 / 空串等价于「解绑」，Rust 侧不会注册新热键。
 */
export async function applyOpenMainShortcut(shortcut: string): Promise<GlobalShortcutRegistration> {
  if (!canUseTauriInvoke()) {
    return { ok: false, error: "当前环境不支持全局快捷键" };
  }

  try {
    await invoke("register_open_main_shortcut", {
      shortcut: canonicalizeShortcut(shortcut) || null,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
