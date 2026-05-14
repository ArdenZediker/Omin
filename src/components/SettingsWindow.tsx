import { useCallback, useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import { BASIC_SETTINGS_STORAGE_KEY, CURRENT_MODEL_STORAGE_KEY, THEME_MODE_STORAGE_KEY } from "../app/constants";
import { applyThemeFromStorage } from "../app/window";
import { bootstrapSqliteStorage, saveSqliteBackedValue } from "../app/sqliteStorage";
import { USAGE_PREFERENCES_STORAGE_KEY } from "../chat/storage";
import SettingsPanel from "./SettingsPanel";

const SETTINGS_BOOTSTRAP_KEYS = [
  BASIC_SETTINGS_STORAGE_KEY,
  CURRENT_MODEL_STORAGE_KEY,
  THEME_MODE_STORAGE_KEY,
  USAGE_PREFERENCES_STORAGE_KEY,
  "omni_provider_configs",
  "omni_knowledge_embedding_profile",
  "omni_model_connection_status",
];

function getSafeCurrentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export default function SettingsWindow() {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      await bootstrapSqliteStorage(SETTINGS_BOOTSTRAP_KEYS);
      await loadProviderConfigs();
      applyThemeFromStorage();

      if (!cancelled) {
        setIsReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleClose = useCallback(async () => {
    const currentWindow = getSafeCurrentWindow();
    if (!currentWindow) {
      return;
    }

    try {
      await currentWindow.close();
    } catch {
      // Ignore close failures and keep the window responsive.
    }
  }, []);

  const handleModelChange = useCallback(async (modelId: string) => {
    modelRegistry.setCurrentModel(modelId);
    saveSqliteBackedValue(CURRENT_MODEL_STORAGE_KEY, modelId);
    await emit("omni-model-changed", { modelId });
  }, []);

  useEffect(() => {
    const onKeyDown = async (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        await handleClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [handleClose]);

  if (!isReady) {
    return <div className="app-shell glass flex h-screen w-screen overflow-hidden" />;
  }

  return (
    <div className="app-shell glass flex h-screen w-screen overflow-hidden">
      <SettingsPanel onClose={handleClose} onModelChange={handleModelChange} />
    </div>
  );
}
