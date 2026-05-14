import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { MAIN_WINDOW_LABEL, SETTINGS_WINDOW_LABEL } from "./constants";
import { showSettingsWindow } from "./window";
import { saveSqliteBackedValue } from "./sqliteStorage";

export type DesktopActionHandlers = {
  onNewChat: () => void;
  onRestoreMain: (focusInput?: boolean) => Promise<void>;
  onNotify?: (title: string, body: string) => void | Promise<void>;
};

export function createDesktopActions(handlers: DesktopActionHandlers) {
  const { onNewChat, onRestoreMain, onNotify } = handlers;

  return {
    async openSettings() {
      await showSettingsWindow();
    },

    async openChat(focusInput = true) {
      saveSqliteBackedValue("omni_main_view", "chat");
      await onRestoreMain(focusInput);
    },

    async openNewTopic() {
      onNewChat();
      await onRestoreMain(true);
    },

    async setDraft(draft: string, images: string[] = []) {
      await onRestoreMain(true);
      const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
      await mainWindow?.emit("omni-set-draft", { draft, images });
    },

    async closeSettings() {
      const settingsWindow = await WebviewWindow.getByLabel(SETTINGS_WINDOW_LABEL);
      if (!settingsWindow) {
        return;
      }

      try {
        await settingsWindow.close();
      } catch {
        // Ignore close failures. The caller already treats this as a best-effort action.
      }
    },

    async notify(title: string, body: string) {
      await onNotify?.(title, body);
    },
  };
}
