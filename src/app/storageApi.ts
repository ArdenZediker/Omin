import { invoke } from "@tauri-apps/api/core";

export type DataRootSource = "custom" | "portable" | "default";

export interface DataRootInfo {
  path: string;
  source: DataRootSource;
  writable: boolean;
  databasePath: string;
  knowledgePath: string;
  fallbackReason: string | null;
}

export interface BackupManifest {
  app: string;
  formatVersion: number;
  appVersion: string;
  createdAt: number;
  encrypted: boolean;
}

function canUseTauriInvoke() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getDataRootInfo(): Promise<DataRootInfo | null> {
  if (!canUseTauriInvoke()) return null;
  return invoke<DataRootInfo>("get_data_root_info");
}

export async function setDataRoot(newPath: string): Promise<DataRootInfo> {
  if (!canUseTauriInvoke()) {
    throw new Error("当前环境不支持修改数据存储位置");
  }
  return invoke<DataRootInfo>("set_data_root", { newPath });
}

export async function resetDataRoot(): Promise<DataRootInfo> {
  if (!canUseTauriInvoke()) {
    throw new Error("当前环境不支持修改数据存储位置");
  }
  return invoke<DataRootInfo>("reset_data_root");
}

export async function openDataDir(): Promise<void> {
  if (!canUseTauriInvoke()) return;
  await invoke("open_data_dir");
}

export async function openPath(path: string): Promise<void> {
  if (!canUseTauriInvoke()) return;
  await invoke("open_path", { path });
}

export async function revealItemInDir(path: string): Promise<void> {
  if (!canUseTauriInvoke()) return;
  await invoke("reveal_item_in_dir", { path });
}

export async function exportDataBackup(targetPath: string, secret?: string | null): Promise<BackupManifest> {
  if (!canUseTauriInvoke()) {
    throw new Error("当前环境不支持导出备份");
  }
  return invoke<BackupManifest>("export_data_backup", {
    targetPath,
    secret: secret ?? null,
  });
}

export async function importDataBackup(
  sourcePath: string,
  targetDir: string,
  secret?: string | null
): Promise<BackupManifest> {
  if (!canUseTauriInvoke()) {
    throw new Error("当前环境不支持导入备份");
  }
  return invoke<BackupManifest>("import_data_backup", {
    sourcePath,
    targetDir,
    secret: secret ?? null,
  });
}
