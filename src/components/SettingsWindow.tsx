import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { loadProviderConfigs, modelRegistry } from "../adapters/registry";
import { BASIC_SETTINGS_STORAGE_KEY, CURRENT_MODEL_STORAGE_KEY, THEME_MODE_STORAGE_KEY } from "../app/constants";
import { applyThemeFromStorage } from "../app/window";
import { bootstrapSqliteStorage, saveSqliteBackedValue } from "../app/sqliteStorage";
import { MODEL_USAGE_PREFERENCES_STORAGE_KEY, USAGE_PREFERENCES_STORAGE_KEY } from "../chat/storage";
import SettingsPanel from "./SettingsPanel";

const SETTINGS_BOOTSTRAP_KEYS = [
  BASIC_SETTINGS_STORAGE_KEY,
  CURRENT_MODEL_STORAGE_KEY,
  THEME_MODE_STORAGE_KEY,
  USAGE_PREFERENCES_STORAGE_KEY,
  MODEL_USAGE_PREFERENCES_STORAGE_KEY,
  "omni_provider_configs",
  "omni_knowledge_embedding_profile",
  "omni_model_connection_status",
];

export default function SettingsWindow({ onClose }: { onClose: () => void }) {
  const [isReady, setIsReady] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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

  const handleModelChange = useCallback(async (modelId: string) => {
    modelRegistry.setCurrentModel(modelId);
    saveSqliteBackedValue(CURRENT_MODEL_STORAGE_KEY, modelId);
    await emit("omni-model-changed", { modelId });
  }, []);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => dialogRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) {
        return;
      }

      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex]:not([tabindex="-1"])'
      )];
      if (!focusable.length) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.documentElement.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, []);

  return (
    <div
      className="settings-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section ref={dialogRef} className="settings-overlay__panel" role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1}>
        {isReady ? (
          <SettingsPanel onClose={onClose} onModelChange={handleModelChange} />
        ) : (
          <div className="settings-overlay__loading" aria-label="正在加载设置" />
        )}
      </section>
    </div>
  );
}
