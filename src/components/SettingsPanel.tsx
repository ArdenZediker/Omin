import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Bot, Settings } from "lucide-react";
import { modelRegistry, saveProviderConfigs } from "../adapters/registry";
import type { CustomModelConfig } from "../adapters/types";
import { BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS, THEME_MODE_STORAGE_KEY } from "../app/constants";
import type { BasicSettings } from "../app/types";
import { applyThemeMode, getInitialThemeMode, type ThemeMode } from "../app/settings";
import {
  loadBasicSettings,
  loadUsagePreferences,
  removeModelConnectionStatus,
  saveBasicSettings,
  saveUsagePreferences,
  saveModelConnectionStatus,
} from "../app/settingsStore";
import { loadKnowledgeEmbeddingProfile, saveKnowledgeEmbeddingProfile, type KnowledgeEmbeddingProfile } from "../chat/knowledgeEmbedding";
import BasicSettingsSection from "./settings/BasicSettingsSection";
import KnowledgeEmbeddingSection from "./settings/KnowledgeEmbeddingSection";
import ModelSettingsSection from "./settings/ModelSettingsSection";
import TitleBar from "./TitleBar";

interface SettingsPanelProps {
  onClose: () => void;
  onModelChange: (modelId: string) => void;
}
type SettingsSection = "basic" | "models";
type RawRegistry = { configs: Map<string, { apiKey: string; baseUrl?: string; name?: string; customModels?: CustomModelConfig[] }> };

const MASK = "********";
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

export default function SettingsPanel({ onClose, onModelChange }: SettingsPanelProps) {
  const [section, setSection] = useState<SettingsSection>("basic");
  const [version, setVersion] = useState(0);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialThemeMode(THEME_MODE_STORAGE_KEY));
  const [basicSettings, setBasicSettings] = useState<BasicSettings>(
    loadBasicSettings(BASIC_SETTINGS_STORAGE_KEY, DEFAULT_BASIC_SETTINGS)
  );
  const [prefs, setPrefs] = useState(loadUsagePreferences);
  const [prefsSaveStatus, setPrefsSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [knowledgeEmbeddingProfile, setKnowledgeEmbeddingProfile] = useState<KnowledgeEmbeddingProfile>(loadKnowledgeEmbeddingProfile);
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
      setApiKey("");
      setTestResult(null);
      return;
    }

    const endpoint = endpoints.find((item) => item.id === id);
    const cfg = modelRegistry.getProviderConfig(id);
    setModelEndpointId(id);
    setEndpointName(cfg?.name || endpoint?.name || id);
    setBaseUrl(cfg?.baseUrl || endpoint?.baseUrl || "");
    setApiKey(cfg?.hasApiKey ? MASK : "");
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
      setApiKey(cfg?.hasApiKey ? MASK : "");
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
    setApiKey(cfg?.hasApiKey ? MASK : "");
    setModelId(model.requestModelId || model.id.replace(`${model.endpointId}:`, ""));
    setModelName(model.name);
    setModelVision(model.supportsVision ?? false);
    setModelStreaming(model.supportsStreaming ?? true);
    setTestResult(null);
    setIsModelFormOpen(true);
  };

  const validateCurrentEndpoint = async () => {
    const id = modelEndpointId.trim();
    const resolvedApiKey = apiKey === MASK ? getRawApiKey(id) : apiKey.trim();
    if (!id || !endpointName.trim() || !baseUrl.trim() || !resolvedApiKey) return null;

    const existingModels = modelRegistry.getCustomModels(id);
    modelRegistry.registerProvider(id, {
      name: endpointName.trim(),
      apiKey: resolvedApiKey,
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
        setApiKey(MASK);
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
    const resolvedApiKey = apiKey === MASK ? getRawApiKey(id) : apiKey.trim();
    if (!id || !endpointName.trim() || !baseUrl.trim() || !resolvedApiKey || !rawId) return;

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
      name: endpointName.trim(),
      apiKey: resolvedApiKey,
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
    setApiKey(MASK);
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

  const updateKnowledgeEmbeddingProfile = (profile: KnowledgeEmbeddingProfile) => {
    setKnowledgeEmbeddingProfile(profile);
    saveKnowledgeEmbeddingProfile(profile);
    void emit("omni-knowledge-embedding-profile-changed", { profile });
  };

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
            <span className="omni-settings-nav-icon flex h-5 w-5 items-center justify-center rounded-md bg-slate-100 text-slate-600">
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
              <Bot size={13} strokeWidth={1.8} />
            </span>
            模型配置
          </button>
        </div>
      </aside>

      <section className="omni-settings-main flex min-w-0 flex-1 flex-col bg-white">
        <header className="omni-settings-header flex h-12 shrink-0 items-center justify-between border-b border-slate-200 px-5 select-none" onMouseDown={handleHeaderMouseDown}>
          <div className="min-w-0 flex-1 pr-3">
            <h2 className="omni-settings-title text-sm font-semibold text-slate-950">{section === "basic" ? "基本设置" : "模型配置"}</h2>
            <p className="omni-settings-muted text-[11px] text-slate-500">
              {section === "basic" ? "管理 Omni 的通用基础选项。" : "通过模型列表新增或编辑 OpenAI 兼容模型。"}
            </p>
          </div>          <TitleBar
            inline
            onMinimizeToCompact={handleMinimizeWindow}
            onClose={onClose}
            closeTitle="关闭设置"
            minimizeBehavior="taskbar"
          />
        </header>

        <div className="hide-scrollbar flex-1 overflow-y-auto overflow-x-hidden p-5">
          <div className="mx-auto w-full max-w-3xl space-y-6">
            {section === "basic" ? (
              <BasicSettingsSection
                basicSettings={basicSettings}
                onCaptureShortcut={captureShortcut}
                onChangeThemeMode={changeThemeMode}
                onUpdateBasicSettings={updateBasicSettings}
                themeMode={themeMode}
                recordingShortcut={recordingShortcut}
              />
            ) : (
              <div className="space-y-6">
                <KnowledgeEmbeddingSection profile={knowledgeEmbeddingProfile} onChangeProfile={updateKnowledgeEmbeddingProfile} />
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
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
