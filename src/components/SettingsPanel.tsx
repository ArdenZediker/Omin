import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { showCompactWindow } from "../app/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Cuboid, MessageSquareText, Settings } from "lucide-react";
import { modelRegistry, saveProviderConfigs } from "../adapters/registry";
import type { CustomModelConfig } from "../adapters/types";
import { BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS, THEME_MODE_STORAGE_KEY } from "../app/constants";
import {
  loadCodexPetLibraryState,
  loadCodexPetPackages,
  createCodexPetPackage,
  saveCodexPetLibraryState,
} from "../app/pets/codexPetStore";
import { getPetWindowScale } from "../app/compactPetScale";
import { setCompactPetHidden } from "../app/compactVisibility";
import {
  DEFAULT_CODEX_PET_LIBRARY_STATE,
  type CodexPetLibraryState,
  type CodexPetPackage,
} from "../app/pets/codexPetTypes";
import type { BasicSettings } from "../app/types";
import { applyThemeMode, getInitialThemeMode, type ThemeMode } from "../app/settings";
import { COMPACT_WINDOW_LABEL } from "../app/constants";
import { saveSqliteBackedValue } from "../app/sqliteStorage";
import {
  loadBasicSettings,
  loadUsagePreferences,
  removeModelConnectionStatus,
  saveBasicSettings,
  saveUsagePreferences,
  saveModelConnectionStatus,
} from "../app/settingsStore";
import {
  loadKnowledgeEmbeddingConfig,
  saveKnowledgeEmbeddingConfig,
  type KnowledgeEmbeddingConfig,
} from "../chat/knowledgeEmbedding";
import BasicSettingsSection from "./settings/BasicSettingsSection";
import KnowledgeEmbeddingSection from "./settings/KnowledgeEmbeddingSection";
import ModelSettingsSection from "./settings/ModelSettingsSection";
import TitleBar from "./TitleBar";

interface SettingsPanelProps {
  onClose: () => void;
  onBackToMain: () => void | Promise<void>;
  onModelChange: (modelId: string) => void;
}
type SettingsSection = "basic" | "models";
type ModelConfigSection = "chat" | "embedding";
type ModelSectionCard = {
  title: string;
  description: string;
  icon: typeof Settings;
  count: number;
};
type ModelSectionCards = Record<ModelConfigSection, ModelSectionCard>;
type RawRegistry = { configs: Map<string, { apiKey: string; baseUrl?: string; name?: string; customModels?: CustomModelConfig[] }> };
const DEFAULT_ENDPOINTS = [
  { id: "openai", name: "OpenAI 官方", baseUrl: "https://api.openai.com/v1" },
  { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "siliconflow", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1" },
  { id: "moonshot", name: "Moonshot", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "dashscope", name: "阿里百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
];

function getRawApiKey(id: string) {
  return (modelRegistry as unknown as RawRegistry).configs.get(id)?.apiKey || "";
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
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialThemeMode(THEME_MODE_STORAGE_KEY));
  const [basicSettings, setBasicSettings] = useState<BasicSettings>(
    loadBasicSettings(BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS)
  );
  const [codexPetPackages, setCodexPetPackages] = useState<CodexPetPackage[]>([]);
  const [codexPetLibraryState, setCodexPetLibraryState] = useState<CodexPetLibraryState>(DEFAULT_CODEX_PET_LIBRARY_STATE);
  const [codexPetHome, setCodexPetHome] = useState("");
  const [isDesktopPetAwake, setIsDesktopPetAwake] = useState(false);
  const [prefs, setPrefs] = useState(loadUsagePreferences);
  const [prefsSaveStatus, setPrefsSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [knowledgeEmbeddingConfig, setKnowledgeEmbeddingConfig] = useState<KnowledgeEmbeddingConfig>(loadKnowledgeEmbeddingConfig);
  const [recordingShortcut, setRecordingShortcut] = useState<"openMainShortcut" | "switchPreviousModelShortcut" | null>(null);
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

  const createCodexPet = async () => {
    const created = await createCodexPetPackage();
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
    applyThemeMode(THEME_MODE_STORAGE_KEY, mode);
  };

  const captureShortcut = (
    event: KeyboardEvent<HTMLButtonElement>,
    keyName: keyof Pick<BasicSettings, "openMainShortcut" | "switchPreviousModelShortcut">
  ) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Backspace" || event.key === "Delete" || event.key === "Escape") {
      updateBasicSettings({ [keyName]: "未设置" });
      setRecordingShortcut(null);
      return;
    }
    if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) return;

    const keys = [
      event.ctrlKey ? "Ctrl" : "",
      event.shiftKey ? "Shift" : "",
      event.altKey ? "Alt" : "",
      event.metaKey ? "Meta" : "",
      event.key.length === 1 ? event.key.toUpperCase() : event.key,
    ].filter(Boolean);

    updateBasicSettings({ [keyName]: keys.join("+") });
    setRecordingShortcut(null);
  };

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
    setModelId("");
    setModelName("");
    setModelVision(false);
    setModelStreaming(true);
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
    setModelId(model.requestModelId || model.id.replace(`${model.endpointId}:`, ""));
    setModelName(model.name);
    setModelVision(model.supportsVision ?? false);
    setModelStreaming(model.supportsStreaming ?? true);
    setTestResult(null);
    setIsModelFormOpen(true);
  };

  const validateCurrentEndpoint = async () => {
    const id = modelEndpointId.trim();
    if (!id || !endpointName.trim() || !baseUrl.trim() || !getRawApiKey(id)) return null;

    const existingModels = modelRegistry.getCustomModels(id);
    modelRegistry.registerProvider(id, {
      apiKey: getRawApiKey(id),
      name: endpointName.trim(),
      baseUrl: baseUrl.trim(),
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
    if (!id || !endpointName.trim() || !baseUrl.trim() || !getRawApiKey(id) || !rawId) return;

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
      apiKey: getRawApiKey(id),
      name: endpointName.trim(),
      baseUrl: baseUrl.trim(),
      customModels: existingModels.length ? existingModels : undefined,
    });

    const model: CustomModelConfig = {
      id: `${id}:${rawId}`,
      requestModelId: rawId,
      name: modelName.trim() || rawId,
      supportsVision: modelVision,
      supportsStreaming: modelStreaming,
    };

    modelRegistry.addCustomModel(id, model);
    await saveProviderConfigs();
    onModelChange(model.id);
    setEditingModel(null);
    setIsModelFormOpen(false);
    setModelId("");
    setModelName("");
    setTestResult(null);
    setVersion((value) => value + 1);
  };

  const removeModel = (endpointId: string, id: string) => {
    modelRegistry.removeCustomModel(endpointId, id);
    void removeModelConnectionStatus(id);
    void saveProviderConfigs();
    setVersion((value) => value + 1);
  };

  const saveCurrentPrefs = () => {
    try {
      saveUsagePreferences(prefs);
      setPrefsSaveStatus("saved");
      window.setTimeout(() => setPrefsSaveStatus("idle"), 1600);
    } catch {
      setPrefsSaveStatus("error");
    }
  };

  const updateKnowledgeEmbeddingConfig = (config: KnowledgeEmbeddingConfig) => {
    setKnowledgeEmbeddingConfig(config);
    saveKnowledgeEmbeddingConfig(config);
    void emit("omni-knowledge-embedding-profile-changed", { config });
  };

  useEffect(() => {
    if (section === "models") {
      return;
    }
    setModelSection("chat");
  }, [section]);

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
        </div>
      </aside>

      <section className="omni-settings-main flex min-w-0 flex-1 flex-col bg-white">
        <header className="omni-settings-header flex h-12 shrink-0 items-center justify-between border-b border-slate-200 px-5 select-none" onMouseDown={handleHeaderMouseDown}>
          <div className="drag-region min-w-0 flex-1 pr-3">
            <h2 className="omni-settings-title text-sm font-semibold text-slate-950">{section === "basic" ? "基本设置" : "模型配置"}</h2>
            <p className="omni-settings-muted text-[11px] text-slate-500">
              {section === "basic" ? "管理 Omni 的通用基础选项。" : "通过模型列表新增或编辑 OpenAI 兼容模型。"}
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
                onCreateCodexPet={createCodexPet}
                onRefreshCodexPets={refreshCodexPets}
                onCaptureShortcut={captureShortcut}
                onChangeThemeMode={changeThemeMode}
                onUpdateBasicSettings={updateBasicSettings}
                themeMode={themeMode}
                recordingShortcut={recordingShortcut}
              />
            ) : (
              <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[240px_minmax(0,1fr)] gap-6">
                <aside className="min-w-0 self-start rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <div className="px-2 pb-3">
                    <div className="text-xs font-semibold text-slate-500">模型分类</div>
                    <div className="mt-1 text-[11px] leading-5 text-slate-400">聊天模型和向量模型分开配置，切换不会互相干扰。</div>
                  </div>
                  <div className="space-y-1">
                    {(["chat", "embedding"] as const).map((key) => {
                      const item = modelSectionCards[key];
                      const isActive = modelSection === key;
                      const Icon = item.icon;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setModelSection(key)}
                          className={`flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors ${
                            isActive
                              ? "bg-white text-slate-950 shadow-sm ring-1 ring-slate-200"
                              : "text-slate-600 hover:bg-white/70 hover:text-slate-900"
                          }`}
                        >
                          <span className={`mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg ${isActive ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`}>
                            <Icon size={15} strokeWidth={1.8} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2">
                              <span className="text-sm font-medium">{item.title}</span>
                              <span className={`rounded-full px-2 py-0.5 text-[11px] ${isActive ? "bg-slate-100 text-slate-700" : "bg-slate-100 text-slate-500"}`}>
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
                  <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-slate-900">{currentModelSectionCard.title}</h3>
                        <p className="mt-0.5 text-xs leading-5 text-slate-500">{currentModelSectionCard.description}</p>
                      </div>
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] text-slate-600">{currentModelSectionCard.count} 项</span>
                    </div>
                  </div>

                  {modelSection === "chat" ? (
                    <ModelSettingsSection
                      apiKey={apiKey}
                      baseUrl={baseUrl}
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
                      onChooseEndpoint={chooseEndpoint}
                      onCloseModelForm={() => setIsModelFormOpen(false)}
                      onOpenEditModelForm={openEditModelForm}
                      onOpenNewModelForm={openNewModelForm}
                      onRemoveModel={removeModel}
                      onSaveModel={saveModel}
                      onSavePrefs={saveCurrentPrefs}
                      onSetApiKey={setApiKey}
                      onSetBaseUrl={setBaseUrl}
                      onSetEndpointName={setEndpointName}
                      onSetModelEndpointId={setModelEndpointId}
                      onSetModelId={setModelId}
                      onSetModelName={setModelName}
                      onSetModelStreaming={setModelStreaming}
                      onSetModelVision={setModelVision}
                      onSetPrefs={setPrefs}
                      onTestConnection={testConnection}
                      prefs={prefs}
                      prefsSaveStatus={prefsSaveStatus}
                      testResult={testResult}
                      testingConnection={testingConnection}
                    />
                  ) : (
                    <KnowledgeEmbeddingSection config={knowledgeEmbeddingConfig} onChangeConfig={updateKnowledgeEmbeddingConfig} />
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
