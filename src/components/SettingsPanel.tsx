import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { showCompactWindow } from "../app/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Cuboid, Database, MessageSquareText, Paintbrush, Settings, Sparkles } from "lucide-react";
import { modelRegistry, saveProviderConfigs } from "../adapters/registry";
import { PROVIDER_DEFAULTS } from "../adapters/modelCatalog";
import { MODEL_PARAM_COMPAT_CHANGED_EVENT } from "../adapters/paramCompat";
import type { CustomModelConfig, UnsupportedParam } from "../adapters/types";
import type { ChatUsagePreferences } from "../chat/types";
import { BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS } from "../app/constants";
import {
  loadCodexPetLibraryState,
  loadCodexPetPackages,
  importCodexPetPackage,
  saveCodexPetLibraryState,
} from "../app/pets/codexPetStore";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getPetWindowScale } from "../app/compactPetScale";
import { setCompactPetHidden } from "../app/compactVisibility";
import {
  DEFAULT_CODEX_PET_LIBRARY_STATE,
  type CodexPetLibraryState,
  type CodexPetPackage,
} from "../app/pets/codexPetTypes";
import type { BasicSettings } from "../app/types";
import { type ThemeMode } from "../app/settings";
import { useThemeSync } from "../hooks/useThemeSync";
import { COMPACT_WINDOW_LABEL } from "../app/constants";
import { saveSqliteBackedValue } from "../app/sqliteStorage";
import { applyOpenMainShortcut } from "../app/globalShortcut";
import { shortcutFromEvent } from "../app/shortcuts";
import { resolveCurrentModelId } from "../chat/modelSelection";
import {
  loadBasicSettings,
  removeModelConnectionStatus,
  saveBasicSettings,
  saveModelConnectionStatus,
} from "../app/settingsStore";
import { loadKnowledgeEmbeddingConfig, saveKnowledgeEmbeddingConfig, type KnowledgeEmbeddingConfig } from "../chat/knowledgeEmbedding";
import {
  loadKnowledgeMultimodalConfig,
  saveKnowledgeMultimodalConfig,
  type KnowledgeMultimodalConfig,
} from "../chat/knowledgeMultimodal";
import {
  DEFAULT_USAGE_PREFERENCES,
  getUsagePreferencesForModel,
  removeUsagePreferencesForModel,
  saveUsagePreferencesForModel,
} from "../chat/storage";
import BasicSettingsSection from "./settings/BasicSettingsSection";
import KnowledgeEmbeddingSection from "./settings/KnowledgeEmbeddingSection";
import KnowledgeMultimodalSection from "./settings/KnowledgeMultimodalSection";
import ModelSettingsSection from "./settings/ModelSettingsSection";
import PersonalizationSettingsSection from "./settings/PersonalizationSettingsSection";
import StorageSettingsSection from "./settings/StorageSettingsSection";
import TitleBar from "./TitleBar";

interface SettingsPanelProps {
  onClose: () => void;
  onBackToMain: () => void | Promise<void>;
  onModelChange: (modelId: string) => void;
}
type SettingsSection = "basic" | "personalization" | "models" | "storage" | "plugins";
type ModelConfigSection = "chat" | "embedding" | "multimodal";
type ModelSectionCard = {
  title: string;
  description: string;
  icon: typeof Settings;
  count: number;
};
type ModelSectionCards = Record<ModelConfigSection, ModelSectionCard>;
type RawRegistry = { configs: Map<string, { apiKey: string; baseUrl?: string; name?: string; customModels?: CustomModelConfig[] }> };
type ShortcutSettingKey = keyof Pick<BasicSettings, "openMainShortcut" | "switchPreviousModelShortcut">;
/** 内置厂商端点预设（单源来自 modelCatalog） */
const DEFAULT_ENDPOINTS = Object.entries(PROVIDER_DEFAULTS)
  .filter(([, value]) => !value.local)
  .map(([id, value]) => ({ id, name: value.label, baseUrl: value.baseUrl }));

function getRawApiKey(id: string) {
  return (modelRegistry as unknown as RawRegistry).configs.get(id)?.apiKey || "";
}

function resolveFormApiKey(endpointId: string, apiKeyInput: string) {
  const trimmed = apiKeyInput.trim();
  if (trimmed && trimmed !== "********") {
    return trimmed;
  }

  return getRawApiKey(endpointId);
}

function normalizeUsagePreferences(prefs: ChatUsagePreferences): ChatUsagePreferences {
  const temperature = Number.isFinite(prefs.temperature) ? prefs.temperature : DEFAULT_USAGE_PREFERENCES.temperature;
  const maxOutputTokens = Number.isFinite(prefs.maxOutputTokens)
    ? Math.floor(prefs.maxOutputTokens)
    : DEFAULT_USAGE_PREFERENCES.maxOutputTokens;

  return {
    enableStreaming: prefs.enableStreaming,
    enableVisionInput: prefs.enableVisionInput,
    temperature: Math.min(2, Math.max(0, temperature)),
    maxOutputTokens: Math.min(200000, Math.max(1, maxOutputTokens)),
    costSaverCompaction: Boolean(prefs.costSaverCompaction),
  };
}

function getSafeCurrentWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

export default function SettingsPanel({ onClose, onBackToMain, onModelChange }: SettingsPanelProps) {
  const [section, setSection] = useState<SettingsSection>("basic");
  const [modelSection, setModelSection] = useState<ModelConfigSection>("chat");
  const [version, setVersion] = useState(0);
  const [currentModel, setCurrentModel] = useState(modelRegistry.getCurrentModel());
  const { themeMode, setMode: setThemeMode } = useThemeSync();
  const [basicSettings, setBasicSettings] = useState<BasicSettings>(
    loadBasicSettings(BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS)
  );
  const [codexPetPackages, setCodexPetPackages] = useState<CodexPetPackage[]>([]);
  const [codexPetLibraryState, setCodexPetLibraryState] = useState<CodexPetLibraryState>(DEFAULT_CODEX_PET_LIBRARY_STATE);
  const [codexPetHome, setCodexPetHome] = useState("");
  const [isDesktopPetAwake, setIsDesktopPetAwake] = useState(false);
  /** 正在编辑的模型的请求参数草稿：打开「新增/编辑模型」时按该模型载入，随「保存模型」一并落盘 */
  const [modelPrefs, setModelPrefs] = useState<ChatUsagePreferences>(DEFAULT_USAGE_PREFERENCES);
  const [knowledgeEmbeddingConfig, setKnowledgeEmbeddingConfig] = useState<KnowledgeEmbeddingConfig>(loadKnowledgeEmbeddingConfig);
  const [knowledgeMultimodalConfig, setKnowledgeMultimodalConfig] = useState<KnowledgeMultimodalConfig>(loadKnowledgeMultimodalConfig);
  const [recordingShortcut, setRecordingShortcut] = useState<"openMainShortcut" | "switchPreviousModelShortcut" | null>(null);
  // 「打开主界面」是 OS 级全局热键，可能因组合键被其它程序占用而注册失败。
  // 失败必须让用户看见，否则会误以为设置没生效。
  const [openMainShortcutNotice, setOpenMainShortcutNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [endpointName, setEndpointName] = useState("OpenAI 官方");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [testingConnection, setTestingConnection] = useState(false);
  const [testResult, setTestResult] = useState<boolean | null>(null);
  const [modelEndpointId, setModelEndpointId] = useState("openai");
  const [modelId, setModelId] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelVision, setModelVision] = useState(false);
  const [modelStreaming, setModelStreaming] = useState(true);
  const [modelUnsupportedParams, setModelUnsupportedParams] = useState<UnsupportedParam[]>([]);
  const [isModelFormOpen, setIsModelFormOpen] = useState(false);
  const [editingModel, setEditingModel] = useState<{ endpointId: string; id: string } | null>(null);

  const endpoints = useMemo(() => {
    const map = new Map(DEFAULT_ENDPOINTS.map((entry) => [entry.id, entry]));
    for (const id of modelRegistry.getRegisteredProviders()) {
      const cfg = modelRegistry.getProviderConfig(id);
      map.set(id, { id, name: cfg?.name || id, baseUrl: cfg?.baseUrl || "" });
    }
    return [...map.values()];
  }, [version]);

  const endpointModels = endpoints.flatMap((endpoint) =>
    modelRegistry.getCustomModels(endpoint.id).map((model) => ({ ...model, endpointId: endpoint.id, endpointName: endpoint.name }))
  );
  const availableModels = useMemo(() => modelRegistry.getAvailableModels(), [version]);
  const resolvedCurrentModel = resolveCurrentModelId({
    savedModelId: currentModel,
    registryModelId: modelRegistry.getCurrentModel(),
    availableModels,
  });
  const modelSectionCards: ModelSectionCards = {
    chat: {
      title: "聊天模型",
      description: "管理 OpenAI 兼容聊天模型、接口、偏好和连接测试。",
      icon: MessageSquareText,
      count: endpointModels.length,
    },
    embedding: {
      title: "向量模型",
      description: "管理知识库向量化供应商、API Key 和多个嵌入模型。",
      icon: Cuboid,
      count: knowledgeEmbeddingConfig.models.length,
    },
    multimodal: {
      title: "多模态模型",
      description: "管理知识库图片、音频分析模型及默认能力映射。",
      icon: Sparkles,
      count: knowledgeMultimodalConfig.models.length,
    },
  };
  const currentModelSectionCard = modelSectionCards[modelSection];

  useEffect(() => {
    setIsModelFormOpen(false);
    setEditingModel(null);
  }, []);

  const updateBasicSettings = (patch: Partial<BasicSettings>) => {
    setBasicSettings((current) => {
      const next = { ...current, ...patch };
      saveBasicSettings(BASIC_SETTINGS_STORAGE_KEY, next);
      return next;
    });
  };

  const updateCodexPetLibraryState = (patch: Partial<CodexPetLibraryState>) => {
    setCodexPetLibraryState((current) => {
      const next = { ...current, ...patch, updatedAt: Date.now() };
      void saveCodexPetLibraryState(next);
      return next;
    });
  };

  const selectCodexPet = (petId: string) => updateCodexPetLibraryState({ activePetId: petId });

  const syncCompactVisualState = async () => {
    const compactWindow = await WebviewWindow.getByLabel(COMPACT_WINDOW_LABEL);
    const currentAppearance = typeof window === "undefined" ? "default" : localStorage.getItem("omni_compact_appearance");
    const isPetAppearance = currentAppearance === "pet";

    if (!compactWindow) {
      setIsDesktopPetAwake(false);
      return;
    }

    try {
      const visible = await compactWindow.isVisible();
      setIsDesktopPetAwake(visible && isPetAppearance);
    } catch {
      setIsDesktopPetAwake(false);
    }
  };

  const refreshCodexPets = async () => {
    const payload = await loadCodexPetPackages();
    setCodexPetPackages(payload.packages);
    setCodexPetHome(payload.codexHome);
    setCodexPetLibraryState((current) => {
      const nextActivePetId = current.activePetId && payload.packages.some((pet) => pet.id === current.activePetId)
        ? current.activePetId
        : payload.activePetId;
      if (current.activePetId === nextActivePetId) {
        return current;
      }
      return { ...current, activePetId: nextActivePetId, updatedAt: Date.now() };
    });
  };

  const importCodexPet = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "选择宠物文件夹",
    });
    if (typeof selected !== "string") {
      return false;
    }

    const created = await importCodexPetPackage(selected);
    const payload = await loadCodexPetPackages();
    const nextPackages = payload.packages.some((pet) => pet.id === created.id) ? payload.packages : [created, ...payload.packages];
    const nextActivePetId = payload.activePetId ?? created.id;
    setCodexPetPackages(nextPackages);
    setCodexPetHome(payload.codexHome);
    setCodexPetLibraryState((current) => {
      const nextSelection = current.activePetId && nextPackages.some((pet) => pet.id === current.activePetId)
        ? current.activePetId
        : nextActivePetId;
      if (current.activePetId === nextSelection) {
        return current;
      }
      return { ...current, activePetId: nextSelection, updatedAt: Date.now() };
    });
    return true;
  };

  useEffect(() => {
    if (!codexPetLibraryState.activePetId) {
      return;
    }

    if (!isDesktopPetAwake) {
      return;
    }

    void showCompactWindow("pet", getPetWindowScale(), COMPACT_WINDOW_LABEL);
    void syncCompactVisualState();
  }, [codexPetLibraryState.activePetId, isDesktopPetAwake]);

  const enableDesktopPet = async () => {
    const compactWindow = await WebviewWindow.getByLabel(COMPACT_WINDOW_LABEL);
    if (compactWindow) {
      try {
        const visible = await compactWindow.isVisible();
        if (visible && isDesktopPetAwake) {
          setCompactPetHidden(true);
          saveSqliteBackedValue("omni_compact_appearance", "default");
          await emit("omni-compact-appearance-changed", { appearance: "default" });
          await showCompactWindow("default", 1, COMPACT_WINDOW_LABEL);
          setIsDesktopPetAwake(false);
          return;
        }
      } catch {
        // Fall through to wake pet.
      }
    }

    updateBasicSettings({ minimizeBehavior: "compact", showCompactBall: true });
    await saveCodexPetLibraryState({
      activePetId: codexPetLibraryState.activePetId,
      updatedAt: Date.now(),
    });
    saveSqliteBackedValue("omni_compact_appearance", "pet");
    setCompactPetHidden(false);
    await emit("omni-compact-appearance-changed", { appearance: "pet" });
    await showCompactWindow("pet", getPetWindowScale(), COMPACT_WINDOW_LABEL);
    setIsDesktopPetAwake(true);
  };

  const changeThemeMode = (mode: ThemeMode) => {
    setThemeMode(mode);
  };

  // 在设置页也注册一次，让用户改完立刻拿到「是否被占用」的反馈。
  // 主界面那边的 effect 会注册同一组合键（先解绑再注册，幂等）。
  const applyOpenMainShortcutFromSettings = async (shortcut: string) => {
    const result = await applyOpenMainShortcut(shortcut);
    if (result.ok) {
      setOpenMainShortcutNotice(
        shortcut
          ? { kind: "ok", text: "已注册为全局快捷键，应用未聚焦时同样可用。" }
          : { kind: "ok", text: "已取消全局快捷键绑定。" }
      );
      return;
    }
    setOpenMainShortcutNotice({ kind: "error", text: result.error ?? "全局快捷键注册失败" });
  };

  const saveCapturedShortcut = (event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">, keyName: ShortcutSettingKey) => {
    if (event.key === "Backspace" || event.key === "Delete" || event.key === "Escape") {
      updateBasicSettings({ [keyName]: "未设置" });
      setRecordingShortcut(null);
      if (keyName === "openMainShortcut") {
        void applyOpenMainShortcutFromSettings("");
      }
      return;
    }

    const shortcut = shortcutFromEvent(event);
    if (!shortcut) {
      return;
    }

    updateBasicSettings({ [keyName]: shortcut });
    setRecordingShortcut(null);
    if (keyName === "openMainShortcut") {
      void applyOpenMainShortcutFromSettings(shortcut);
    }
  };

  const startShortcutCapture = (keyName: ShortcutSettingKey) => {
    setRecordingShortcut(keyName);
  };

  const cancelShortcutCapture = () => {
    setRecordingShortcut(null);
  };

  const captureShortcut = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    keyName: ShortcutSettingKey
  ) => {
    event.preventDefault();
    event.stopPropagation();
    saveCapturedShortcut(event, keyName);
  };

  useEffect(() => {
    if (!recordingShortcut) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      saveCapturedShortcut(event, recordingShortcut);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [recordingShortcut]);

  const chooseEndpoint = (id: string) => {
    if (id === "__new__") {
      setModelEndpointId("");
      setEndpointName("");
      setBaseUrl("");
      setTestResult(null);
      return;
    }

    const endpoint = endpoints.find((item) => item.id === id);
    const cfg = modelRegistry.getProviderConfig(id);
    setModelEndpointId(id);
    setEndpointName(cfg?.name || endpoint?.name || id);
    setBaseUrl(cfg?.baseUrl || endpoint?.baseUrl || "");
    setTestResult(null);
  };

  const openNewModelForm = () => {
    const endpoint = endpoints[0];
    setEditingModel(null);
    setModelEndpointId(endpoint?.id || "openai");
    if (endpoint) {
      const cfg = modelRegistry.getProviderConfig(endpoint.id);
      setEndpointName(cfg?.name || endpoint.name);
      setBaseUrl(cfg?.baseUrl || endpoint.baseUrl || "");
    }
    setApiKey("");
    setModelId("");
    setModelName("");
    setModelVision(false);
    setModelStreaming(true);
    setModelUnsupportedParams([]);
    setModelPrefs({ ...DEFAULT_USAGE_PREFERENCES });
    setTestResult(null);
    setIsModelFormOpen(true);
  };

  const openEditModelForm = (model: CustomModelConfig & { endpointId: string }) => {
    const endpoint = endpoints.find((item) => item.id === model.endpointId);
    const cfg = modelRegistry.getProviderConfig(model.endpointId);
    setEditingModel({ endpointId: model.endpointId, id: model.id });
    setModelEndpointId(model.endpointId);
    setEndpointName(cfg?.name || endpoint?.name || model.endpointId);
    setBaseUrl(cfg?.baseUrl || endpoint?.baseUrl || "");
    setApiKey(getRawApiKey(model.endpointId) ? "********" : "");
    setModelId(model.requestModelId || model.id.replace(`${model.endpointId}:`, ""));
    setModelName(model.name);
    setModelVision(model.supportsVision ?? false);
    setModelStreaming(model.supportsStreaming ?? true);
    setModelUnsupportedParams(model.unsupportedParams ?? []);
    setModelPrefs(getUsagePreferencesForModel(model.id));
    setTestResult(null);
    setIsModelFormOpen(true);
  };

  const validateCurrentEndpoint = async () => {
    const id = modelEndpointId.trim();
    const resolvedApiKey = resolveFormApiKey(id, apiKey);
    if (!id || !endpointName.trim() || !resolvedApiKey) return null;

    const existingModels = modelRegistry.getCustomModels(id);
    modelRegistry.registerProvider(id, {
      apiKey: resolvedApiKey,
      name: endpointName.trim(),
      // baseUrl 留空时使用内置默认端点（modelCatalog 或适配器兜底）
      baseUrl: baseUrl.trim() || undefined,
      customModels: existingModels.length ? existingModels : undefined,
    });
    return modelRegistry.validateProvider(id);
  };

  const testConnection = async () => {
    const id = modelEndpointId.trim();
    const rawId = modelId.trim();
    setTestingConnection(true);
    setTestResult(null);

    try {
      const valid = await validateCurrentEndpoint();
      if (valid === null) return;
      setTestResult(valid);
      if (rawId) {
        await saveModelConnectionStatus(`${id}:${rawId}`, valid);
      }
      if (valid) {
        await saveProviderConfigs();
        setVersion((value) => value + 1);
      }
    } catch {
      setTestResult(false);
      if (id && rawId) {
        await saveModelConnectionStatus(`${id}:${rawId}`, false);
      }
    } finally {
      setTestingConnection(false);
    }
  };

  const saveModel = async () => {
    const id = modelEndpointId.trim();
    const rawId = modelId.trim();
    const resolvedApiKey = resolveFormApiKey(id, apiKey);
    if (!id || !endpointName.trim() || !resolvedApiKey || !rawId) return;

    setTestingConnection(true);
    setTestResult(null);

    let valid = false;
    try {
      valid = Boolean(await validateCurrentEndpoint());
    } catch {
      valid = false;
    }

    setTestingConnection(false);
    setTestResult(valid);
    await saveModelConnectionStatus(`${id}:${rawId}`, valid);
    if (!valid) return;

    if (editingModel) {
      modelRegistry.removeCustomModel(editingModel.endpointId, editingModel.id);
    }

    const existingModels = modelRegistry.getCustomModels(id);
    modelRegistry.registerProvider(id, {
      apiKey: resolvedApiKey,
      name: endpointName.trim(),
      baseUrl: baseUrl.trim() || undefined,
      customModels: existingModels.length ? existingModels : undefined,
    });

    const model: CustomModelConfig = {
      id: `${id}:${rawId}`,
      requestModelId: rawId,
      name: modelName.trim() || rawId,
      supportsVision: modelVision,
      supportsStreaming: modelStreaming,
      unsupportedParams: modelUnsupportedParams.length > 0 ? modelUnsupportedParams : undefined,
    };

    // 请求参数按模型 id 隔离落盘；若编辑时改了接口/模型 ID，先把旧条目的偏好清掉，避免留孤儿。
    if (editingModel && editingModel.id !== model.id) {
      removeUsagePreferencesForModel(editingModel.id);
    }
    saveUsagePreferencesForModel(model.id, normalizeUsagePreferences(modelPrefs));
    await emit("omni-usage-preferences-changed", { modelId: model.id });

    modelRegistry.addCustomModel(id, model);
    modelRegistry.setCurrentModel(model.id);
    await saveProviderConfigs();
    setCurrentModel(model.id);
    onModelChange(model.id);
    setEditingModel(null);
    setIsModelFormOpen(false);
    setApiKey("");
    setModelId("");
    setModelName("");
    setTestResult(null);
    setVersion((value) => value + 1);
  };

  const toggleModelUnsupportedParam = (param: UnsupportedParam) => {
    setModelUnsupportedParams((prev) =>
      prev.includes(param) ? prev.filter((item) => item !== param) : [...prev, param]
    );
  };

  const removeModel = (endpointId: string, id: string) => {
    modelRegistry.removeCustomModel(endpointId, id);
    removeUsagePreferencesForModel(id);
    void removeModelConnectionStatus(id);
    void saveProviderConfigs();
    const nextModel = resolveCurrentModelId({
      savedModelId: id === currentModel ? null : currentModel,
      registryModelId: modelRegistry.getCurrentModel(),
      availableModels: modelRegistry.getAvailableModels(),
    });
    if (nextModel !== currentModel) {
      setCurrentModel(nextModel);
      onModelChange(nextModel);
    }
    setVersion((value) => value + 1);
  };

  const changeMainModel = (modelId: string) => {
    if (!modelId) {
      return;
    }
    modelRegistry.setCurrentModel(modelId);
    setCurrentModel(modelId);
    onModelChange(modelId);
  };

  const updateModelPrefs = (nextPrefs: ChatUsagePreferences) => {
    setModelPrefs(normalizeUsagePreferences(nextPrefs));
  };

  const resetModelPrefs = () => {
    setModelPrefs({ ...DEFAULT_USAGE_PREFERENCES });
  };

  const updateKnowledgeEmbeddingConfig = (config: KnowledgeEmbeddingConfig) => {
    setKnowledgeEmbeddingConfig(config);
    saveKnowledgeEmbeddingConfig(config);
    void emit("omni-knowledge-embedding-profile-changed", { config });
  };

  const updateKnowledgeMultimodalConfig = (config: KnowledgeMultimodalConfig) => {
    setKnowledgeMultimodalConfig(config);
    saveKnowledgeMultimodalConfig(config);
    void emit("omni-knowledge-multimodal-profile-changed", { config });
  };

  useEffect(() => {
    if (section === "models") {
      return;
    }
    setModelSection("chat");
  }, [section]);

  // 运行期学到「该模型不支持某参数」后，刷新模型列表上的「已调参」标记。
  const [, setParamCompatVersion] = useState(0);
  useEffect(() => {
    const refresh = () => setParamCompatVersion((version) => version + 1);
    window.addEventListener(MODEL_PARAM_COMPAT_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(MODEL_PARAM_COMPAT_CHANGED_EVENT, refresh);
  }, []);

  useEffect(() => {
    void (async () => {
      const [libraryState, payload] = await Promise.all([
        loadCodexPetLibraryState(DEFAULT_CODEX_PET_LIBRARY_STATE),
        loadCodexPetPackages(),
      ]);
      setCodexPetLibraryState(libraryState);
      setCodexPetPackages(payload.packages);
      setCodexPetHome(payload.codexHome);
      if (!libraryState.activePetId && payload.activePetId) {
        setCodexPetLibraryState({ activePetId: payload.activePetId, updatedAt: Date.now() });
      }

      await syncCompactVisualState();
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;

    const syncCompactPetVisibility = async () => {
      try {
        await syncCompactVisualState();
      } catch {
        if (!cancelled) {
          setIsDesktopPetAwake(false);
        }
      }
    };

    void syncCompactPetVisibility();
    const timer = window.setInterval(() => {
      void syncCompactPetVisibility();
    }, 800);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const handleHeaderMouseDown = useCallback(async (event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest(".no-drag")) {
      return;
    }

    const currentWindow = getSafeCurrentWindow();
    if (!currentWindow) {
      return;
    }

    await currentWindow.startDragging();
  }, []);

  const handleMinimizeWindow = useCallback(async () => {
    const currentWindow = getSafeCurrentWindow();
    if (!currentWindow) {
      return;
    }

    try {
      await currentWindow.setSkipTaskbar(false);
      await currentWindow.minimize();
    } catch {
      // Ignore window manager failures.
    }
  }, []);

  return (
    <div className="omni-settings-root relative flex h-full w-full flex-1 min-w-0 overflow-hidden bg-white text-slate-900">
      <aside className="omni-settings-sidebar w-36 shrink-0 border-r border-slate-200 bg-slate-50 py-3">
        <div className="omni-settings-muted px-3 pb-3 text-xs font-semibold text-slate-500">设置</div>
        <div className="space-y-1 px-2">
          <button
            type="button"
            onClick={() => setSection("basic")}
            className={`omni-settings-nav flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs ${
              section === "basic"
                ? "omni-settings-nav--active bg-white text-slate-950 shadow-sm ring-1 ring-slate-200"
                : "text-slate-500 hover:bg-white/70 hover:text-slate-800"
            }`}
          >
            <span className="omni-settings-nav-icon flex h-5 w-5 items-center justify-center rounded-md bg-sky-100 text-sky-700">
              <Settings size={13} strokeWidth={1.8} />
            </span>
            基本设置
          </button>
          <button
            type="button"
            onClick={() => setSection("personalization")}
            className={`omni-settings-nav flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs ${
              section === "personalization"
                ? "omni-settings-nav--active bg-white text-slate-950 shadow-sm ring-1 ring-slate-200"
                : "text-slate-500 hover:bg-white/70 hover:text-slate-800"
            }`}
          >
            <span className="omni-settings-nav-icon flex h-5 w-5 items-center justify-center rounded-md bg-pink-100 text-pink-700">
              <Paintbrush size={13} strokeWidth={1.8} />
            </span>
            个性化
          </button>
          <button
            type="button"
            onClick={() => setSection("models")}
            className={`omni-settings-nav flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs ${
              section === "models"
                ? "omni-settings-nav--active bg-white text-slate-950 shadow-sm ring-1 ring-slate-200"
                : "text-slate-500 hover:bg-white/70 hover:text-slate-800"
            }`}
          >
            <span className="omni-settings-nav-icon flex h-5 w-5 items-center justify-center rounded-md bg-violet-100 text-violet-700">
              <Cuboid size={13} strokeWidth={1.8} />
            </span>
            模型配置
          </button>
          <button
            type="button"
            onClick={() => setSection("storage")}
            className={`omni-settings-nav flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs ${
              section === "storage"
                ? "omni-settings-nav--active bg-white text-slate-950 shadow-sm ring-1 ring-slate-200"
                : "text-slate-500 hover:bg-white/70 hover:text-slate-800"
            }`}
          >
            <span className="omni-settings-nav-icon flex h-5 w-5 items-center justify-center rounded-md bg-emerald-100 text-emerald-700">
              <Database size={13} strokeWidth={1.8} />
            </span>
            数据存储
          </button>
        </div>
      </aside>

      <section className="omni-settings-main flex min-w-0 flex-1 flex-col bg-white">
        <header className="omni-settings-header flex h-12 shrink-0 items-center justify-between border-b border-slate-200 px-5 select-none" onMouseDown={handleHeaderMouseDown}>
          <div className="min-w-0 flex-1 pr-3">
            <h2 className="omni-settings-title text-sm font-semibold text-slate-950">
              {section === "basic"
                ? "基本设置"
                : section === "personalization"
                  ? "个性化"
                  : section === "storage"
                    ? "数据存储"
                    : "模型配置"}
            </h2>
            <p className="omni-settings-muted text-[11px] text-slate-500">
              {section === "basic"
                ? "管理 Omni 的通用基础选项。"
                : section === "personalization"
                  ? "调整 Omni 的回复风格、语调与自定义指令。"
                  : section === "storage"
                    ? "管理数据库、知识库文件存放位置与整库备份。"
                    : "通过模型列表新增或编辑 OpenAI 兼容模型。"}
            </p>
          </div>
          <div className="no-drag flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onBackToMain()}
              className="rounded-none border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
            >
              回到主界面
            </button>
            <TitleBar
              inline
              onMinimizeToCompact={handleMinimizeWindow}
              onClose={onClose}
              closeTitle="关闭设置"
              minimizeBehavior="taskbar"
            />
          </div>
        </header>

        <div className="hide-scrollbar flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-5">
          <div className={`mx-auto flex min-h-full w-full ${section === "models" ? "max-w-none flex-col gap-6" : "max-w-3xl flex-col gap-6"}`}>
            {section === "basic" ? (
              <BasicSettingsSection
                basicSettings={basicSettings}
                codexPetPackages={codexPetPackages}
                codexPetLibraryState={codexPetLibraryState}
                codexPetHome={codexPetHome}
                isDesktopPetAwake={isDesktopPetAwake}
                onEnableDesktopPet={enableDesktopPet}
                onSelectCodexPet={selectCodexPet}
                onImportCodexPet={importCodexPet}
                onRefreshCodexPets={refreshCodexPets}
                onCaptureShortcut={captureShortcut}
                onChangeThemeMode={changeThemeMode}
                onUpdateBasicSettings={updateBasicSettings}
                onStartShortcutCapture={startShortcutCapture}
                onCancelShortcutCapture={cancelShortcutCapture}
                openMainShortcutNotice={openMainShortcutNotice}
                themeMode={themeMode}
                recordingShortcut={recordingShortcut}
              />
            ) : section === "personalization" ? (
              <PersonalizationSettingsSection />
            ) : section === "storage" ? (
              <StorageSettingsSection basicSettings={basicSettings} onUpdateBasicSettings={updateBasicSettings} />
            ) : (
              <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[240px_minmax(0,1fr)] gap-6">
                <aside className="omni-model-section-sidebar min-w-0 self-start rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <div className="px-2 pb-3">
                    <div className="text-xs font-semibold text-slate-500">模型分类</div>
                    <div className="mt-1 text-[11px] leading-5 text-slate-400">聊天、向量和多模态模型分开配置，切换不会互相干扰。</div>
                  </div>
                  <div className="space-y-1">
                    {(["chat", "embedding", "multimodal"] as const).map((key) => {
                      const item = modelSectionCards[key];
                      const isActive = modelSection === key;
                      const Icon = item.icon;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setModelSection(key)}
                          className={`omni-model-section-item flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors ${
                            isActive
                              ? "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200"
                              : "text-slate-600 hover:bg-white/70 hover:text-slate-900"
                          }`}
                        >
                          <span className={`omni-model-section-icon mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg ${isActive ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}>
                            <Icon size={15} strokeWidth={1.8} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2">
                              <span className="text-sm font-medium">{item.title}</span>
                              <span className={`omni-model-section-count rounded-full px-2 py-0.5 text-[11px] ${isActive ? "bg-slate-100 text-slate-700" : "bg-slate-100 text-slate-500"}`}>
                                {item.count}
                              </span>
                            </span>
                            <span className="mt-1 block text-[11px] leading-4 text-slate-400">{item.description}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </aside>

                <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6">
                  <div className="omni-model-section-header rounded-2xl border border-slate-200 bg-white px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-slate-900">{currentModelSectionCard.title}</h3>
                        <p className="mt-0.5 text-xs leading-5 text-slate-500">{currentModelSectionCard.description}</p>
                      </div>
                      <span className="omni-model-section-count rounded-full bg-slate-100 px-2 py-1 text-[11px] text-slate-600">{currentModelSectionCard.count} 项</span>
                    </div>
                  </div>

                  {modelSection === "chat" ? (
                    <ModelSettingsSection
                      apiKey={apiKey}
                      availableModels={availableModels}
                      baseUrl={baseUrl}
                      currentModel={resolvedCurrentModel}
                      editingModel={editingModel}
                      endpointModels={endpointModels}
                      endpointName={endpointName}
                      endpoints={endpoints}
                      getRawApiKey={getRawApiKey}
                      isModelFormOpen={isModelFormOpen}
                      modelEndpointId={modelEndpointId}
                      modelId={modelId}
                      modelName={modelName}
                      modelStreaming={modelStreaming}
                      modelVision={modelVision}
                      modelUnsupportedParams={modelUnsupportedParams}
                      onChooseEndpoint={chooseEndpoint}
                      onCloseModelForm={() => setIsModelFormOpen(false)}
                      onModelChange={changeMainModel}
                      onOpenEditModelForm={openEditModelForm}
                      onOpenNewModelForm={openNewModelForm}
                      onRemoveModel={removeModel}
                      onSaveModel={saveModel}
                      onResetModelPrefs={resetModelPrefs}
                      onSetApiKey={setApiKey}
                      onSetBaseUrl={setBaseUrl}
                      onSetEndpointName={setEndpointName}
                      onSetModelEndpointId={setModelEndpointId}
                      onSetModelId={setModelId}
                      onSetModelName={setModelName}
                      onSetModelStreaming={setModelStreaming}
                      onSetModelVision={setModelVision}
                      onToggleModelUnsupportedParam={toggleModelUnsupportedParam}
                      onSetModelPrefs={updateModelPrefs}
                      onTestConnection={testConnection}
                      modelPrefs={modelPrefs}
                      testResult={testResult}
                      testingConnection={testingConnection}
                    />
                  ) : modelSection === "embedding" ? (
                    <KnowledgeEmbeddingSection
                      config={knowledgeEmbeddingConfig}
                      onChangeConfig={updateKnowledgeEmbeddingConfig}
                      providerEndpoints={endpoints}
                    />
                  ) : (
                    <KnowledgeMultimodalSection
                      config={knowledgeMultimodalConfig}
                      onChangeConfig={updateKnowledgeMultimodalConfig}
                      providerEndpoints={endpoints}
                    />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
