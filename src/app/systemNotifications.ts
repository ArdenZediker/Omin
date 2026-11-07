import { invoke } from "@tauri-apps/api/core";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

export async function sendSystemNotification(title: string, body: string): Promise<void> {
  const allowed = await isPermissionGranted();
  if (!allowed && await requestPermission() !== "granted") {
    throw new Error("系统通知权限未获允许");
  }
  await invoke("plugin:notification|notify", { options: { title, body } });
}
