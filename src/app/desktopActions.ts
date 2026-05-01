import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { MAIN_WINDOW_LABEL } from "./constants";
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
      saveSqliteBackedValue("omni_main_view", "settings");
      await onRestoreMain(false);
      const mainWindow = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
      await mainWindow?.emit("omni-open-settings");
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

    async notify(title: string, body: string) {
      await onNotify?.(title, body);
    },
  };
}
