import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { modelRegistry, saveProviderConfigs } from "../adapters/registry";
import type { CustomModelConfig } from "../adapters/types";

interface SettingsPanelProps { onClose: () => void; onModelChange: (modelId: string) => void; }
type SettingsSection = "basic" | "models";
type ThemeMode = "auto" | "dark" | "light";
type MenuOpenMode = "hover" | "click";
type MinimizeBehavior = "taskbar" | "compact";
type WindowPositionMode = "center" | "remember";
type BasicSettings = {
  menuOpenMode: MenuOpenMode;
  autoLaunch: boolean;
  minimizeBehavior: MinimizeBehavior;
  mainWindowWidth: number;
  mainWindowHeight: number;
  settingsWindowWidth: number;
  settingsWindowHeight: number;
  mainWindowPositionMode: WindowPositionMode;
  showCompactBall: boolean;
  openMainShortcut: string;
  switchPreviousModelShortcut: string;
};
type RawRegistry = { configs: Map<string, { apiKey: string; baseUrl?: string; name?: string; customModels?: CustomModelConfig[] }> };
const MASK = "********";
const PREF_KEY = "omni_usage_preferences";
const MODEL_CONNECTION_STATUS_KEY = "omni_model_connection_status";
const THEME_MODE_STORAGE_KEY = "omni_theme_mode";
const BASIC_SETTINGS_STORAGE_KEY = "omni_basic_settings";
const defaultBasicSettings: BasicSettings = {
  menuOpenMode: "hover",
  autoLaunch: false,
  minimizeBehavior: "compact",
  mainWindowWidth: 920,
  mainWindowHeight: 820,
  settingsWindowWidth: 920,
  settingsWindowHeight: 820,
  mainWindowPositionMode: "remember",
  showCompactBall: true,
  openMainShortcut: "未设置",
  switchPreviousModelShortcut: "未设置",
};
const DEFAULT_ENDPOINTS = [
  ["openai", "OpenAI 官方", "https://api.openai.com/v1"],
  ["deepseek", "DeepSeek", "https://api.deepseek.com/v1"],
  ["openrouter", "OpenRouter", "https://openrouter.ai/api/v1"],
  ["siliconflow", "硅基流动", "https://api.siliconflow.cn/v1"],
  ["moonshot", "Moonshot", "https://api.moonshot.cn/v1"],
  ["dashscope", "阿里百炼", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  ["zhipu", "智谱 GLM", "https://open.bigmodel.cn/api/paas/v4"],
].map(([id, name, baseUrl]) => ({ id, name, baseUrl }));
const defaultPrefs = { enableStreaming: true, enableVisionInput: true, temperature: 0.7, maxOutputTokens: 4096 };
function loadPrefs() { try { return { ...defaultPrefs, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") }; } catch { return defaultPrefs; } }
function loadBasicSettings(): BasicSettings {
  try {
    return { ...defaultBasicSettings, ...JSON.parse(localStorage.getItem(BASIC_SETTINGS_STORAGE_KEY) || "{}") };
  } catch {
    return defaultBasicSettings;
  }
}
function saveBasicSettings(settings: BasicSettings) {
  localStorage.setItem(BASIC_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  window.dispatchEvent(new StorageEvent("storage", { key: BASIC_SETTINGS_STORAGE_KEY, newValue: JSON.stringify(settings) }));
}
function getInitialThemeMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_MODE_STORAGE_KEY);
  return saved === "dark" || saved === "light" ? saved : "auto";
}
function resolveThemeMode(mode: ThemeMode) {
  if (mode !== "auto") return mode;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
function applyThemeMode(mode: ThemeMode) {
  const resolved = resolveThemeMode(mode);
  document.documentElement.dataset.omniThemeMode = mode;
  document.documentElement.dataset.omniTheme = resolved;
  localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
}
function saveModelConnectionStatus(modelId: string, connected: boolean) {
  try {
    const status = JSON.parse(localStorage.getItem(MODEL_CONNECTION_STATUS_KEY) || "{}") as Record<string, boolean>;
    status[modelId] = connected;
    localStorage.setItem(MODEL_CONNECTION_STATUS_KEY, JSON.stringify(status));
  } catch {
    localStorage.setItem(MODEL_CONNECTION_STATUS_KEY, JSON.stringify({ [modelId]: connected }));
  }
}
function removeModelConnectionStatus(modelId: string) {
  try {
    const status = JSON.parse(localStorage.getItem(MODEL_CONNECTION_STATUS_KEY) || "{}") as Record<string, boolean>;
    delete status[modelId];
    localStorage.setItem(MODEL_CONNECTION_STATUS_KEY, JSON.stringify(status));
  } catch {
    localStorage.removeItem(MODEL_CONNECTION_STATUS_KEY);
  }
}

export default function SettingsPanel({ onClose, onModelChange }: SettingsPanelProps) {
  const [version, setVersion] = useState(0);
  const [section, setSection] = useState<SettingsSection>("basic");
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
  const [prefs, setPrefs] = useState(loadPrefs);
  const [prefsSaveStatus, setPrefsSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialThemeMode);
  const [basicSettings, setBasicSettings] = useState<BasicSettings>(loadBasicSettings);
  const [recordingShortcut, setRecordingShortcut] = useState<"openMainShortcut" | "switchPreviousModelShortcut" | null>(null);

  const endpoints = useMemo(() => {
    const map = new Map(DEFAULT_ENDPOINTS.map((e) => [e.id, e]));
    for (const id of modelRegistry.getRegisteredProviders()) {
      const cfg = modelRegistry.getProviderConfig(id);
      map.set(id, { id, name: cfg?.name || id, baseUrl: cfg?.baseUrl || "" });
    }
    return [...map.values()];
  }, [version]);
  const endpointModels = endpoints.flatMap((e) => modelRegistry.getCustomModels(e.id).map((m) => ({ ...m, endpointId: e.id, endpointName: e.name })));
  const getRawApiKey = (id: string) => (modelRegistry as unknown as RawRegistry).configs.get(id)?.apiKey || "";

  useEffect(() => {
    setIsModelFormOpen(false);
    setEditingModel(null);
  }, []);

  const changeThemeMode = (mode: ThemeMode) => {
    setThemeMode(mode);
    applyThemeMode(mode);
  };
  const updateBasicSettings = (patch: Partial<BasicSettings>) => {
    setBasicSettings((current) => {
      const next = { ...current, ...patch };
      saveBasicSettings(next);
      return next;
    });
  };
  const captureShortcut = (event: KeyboardEvent<HTMLButtonElement>, keyName: keyof Pick<BasicSettings, "openMainShortcut" | "switchPreviousModelShortcut">) => {
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
      setModelEndpointId(""); setEndpointName(""); setBaseUrl(""); setApiKey(""); setTestResult(null); return;
    }
    const e = endpoints.find((item) => item.id === id);
    const cfg = modelRegistry.getProviderConfig(id);
    setModelEndpointId(id); setEndpointName(cfg?.name || e?.name || id); setBaseUrl(cfg?.baseUrl || e?.baseUrl || ""); setApiKey(cfg?.hasApiKey ? MASK : ""); setTestResult(null);
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
        saveModelConnectionStatus(`${id}:${rawId}`, valid);
      }
      if (valid) {
        saveProviderConfigs();
        setApiKey(MASK);
        setVersion((v) => v + 1);
      }
    } catch {
      setTestResult(false);
      if (id && rawId) {
        saveModelConnectionStatus(`${id}:${rawId}`, false);
      }
    } finally {
      setTestingConnection(false);
    }
  };

  const saveModel = async () => {
    const id = modelEndpointId.trim();
    const resolvedApiKey = apiKey === MASK ? getRawApiKey(id) : apiKey.trim();
    if (!id || !endpointName.trim() || !baseUrl.trim() || !resolvedApiKey || !modelId.trim()) return;

    setTestingConnection(true);
    setTestResult(null);
    const rawId = modelId.trim();
    const nextModelId = `${id}:${rawId}`;
    let valid = false;
    try {
      valid = Boolean(await validateCurrentEndpoint());
    } catch {
      valid = false;
    }
    setTestingConnection(false);
    setTestResult(valid);
    saveModelConnectionStatus(nextModelId, valid);
    if (!valid) return;

    if (editingModel) modelRegistry.removeCustomModel(editingModel.endpointId, editingModel.id);
    const existingModels = modelRegistry.getCustomModels(id);
    modelRegistry.registerProvider(id, {
      name: endpointName.trim(),
      apiKey: resolvedApiKey,
      baseUrl: baseUrl.trim(),
      customModels: existingModels.length ? existingModels : undefined,
    });
    const model: CustomModelConfig = { id: nextModelId, requestModelId: rawId, name: modelName.trim() || rawId, supportsVision: modelVision, supportsStreaming: modelStreaming };
    modelRegistry.addCustomModel(id, model);
    saveProviderConfigs();
    onModelChange(model.id);
    setEditingModel(null);
    setIsModelFormOpen(false);
    setModelId("");
    setModelName("");
    setApiKey(MASK);
    setTestResult(null);
    setVersion((v) => v + 1);
  };
  const removeModel = (eid: string, id: string) => { modelRegistry.removeCustomModel(eid, id); removeModelConnectionStatus(id); saveProviderConfigs(); setVersion((v) => v + 1); };
  const savePrefs = () => {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
      setPrefsSaveStatus("saved");
      window.setTimeout(() => setPrefsSaveStatus("idle"), 1600);
    } catch {
      setPrefsSaveStatus("error");
    }
  };

  return <div className="omni-settings-root relative flex h-full bg-white text-slate-900">
    <aside className="omni-settings-sidebar w-36 shrink-0 border-r border-slate-200 bg-slate-50 py-3"><div className="omni-settings-muted px-3 pb-3 text-xs font-semibold text-slate-500">设置</div><div className="space-y-1 px-2"><button type="button" onClick={() => setSection("basic")} className={`omni-settings-nav flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs ${section === "basic" ? "omni-settings-nav--active bg-white text-slate-950 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:bg-white/70 hover:text-slate-800"}`}><span className="omni-settings-nav-icon flex h-5 w-5 items-center justify-center rounded-md bg-slate-100 text-[9px] font-semibold text-slate-600">B</span>基本设置</button><button type="button" onClick={() => setSection("models")} className={`omni-settings-nav flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs ${section === "models" ? "omni-settings-nav--active bg-white text-slate-950 shadow-sm ring-1 ring-slate-200" : "text-slate-500 hover:bg-white/70 hover:text-slate-800"}`}><span className="omni-settings-nav-icon flex h-5 w-5 items-center justify-center rounded-md bg-violet-100 text-[9px] font-semibold text-violet-700">AI</span>模型配置</button></div></aside>
    <section className="omni-settings-main flex min-w-0 flex-1 flex-col bg-white"><header className="omni-settings-header flex h-12 shrink-0 items-center justify-between border-b border-slate-200 px-5"><div><h2 className="omni-settings-title text-sm font-semibold text-slate-950">{section === "basic" ? "基本设置" : "模型配置"}</h2><p className="omni-settings-muted text-[11px] text-slate-500">{section === "basic" ? "管理 Omni 的通用基础选项。" : "通过模型列表新增或编辑 OpenAI 兼容模型。"}</p></div><button onClick={onClose} className="omni-settings-close flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100" type="button">×</button></header>
    <div className="hide-scrollbar flex-1 overflow-y-auto overflow-x-hidden p-5"><div className="mx-auto w-full max-w-3xl space-y-6">
      {section === "basic" ? (
        <section className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm omni-settings-card">
          <div className="border-b border-slate-100 pb-3">
            <h3 className="text-sm font-medium text-slate-900 omni-settings-title">主题设置</h3>
            <p className="mt-1 text-xs text-slate-500 omni-settings-muted">主题会同步影响主窗口、设置界面、悬浮窗和悬浮球。</p>
          </div>
          <div className="grid grid-cols-[120px_1fr] gap-4">
            <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">主题</label>
            <div className="inline-flex w-fit overflow-hidden rounded-lg border border-slate-300 bg-white omni-theme-toggle">
              {(["auto", "dark", "light"] as ThemeMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => changeThemeMode(mode)}
                  className={`px-5 py-2 text-sm transition-colors ${themeMode === mode ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"}`}
                >
                  {mode === "auto" ? "自动" : mode === "dark" ? "暗黑" : "明亮"}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-3 omni-theme-preview omni-theme-preview--light">
              <div className="mb-2 text-center text-sm font-semibold text-slate-900">毛玻璃亮色</div>
              <div className="rounded-lg bg-gradient-to-br from-sky-100 via-pink-100 to-amber-100 p-4">
                <div className="w-32 rounded-xl bg-white/78 p-2 shadow-lg backdrop-blur"><div className="mb-2 h-5 rounded bg-slate-200" /><div className="space-y-1"><div className="h-3 rounded bg-slate-300" /><div className="h-3 rounded bg-violet-200" /><div className="h-3 rounded bg-slate-200" /></div></div>
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-950 p-3 omni-theme-preview omni-theme-preview--dark">
              <div className="mb-2 text-center text-sm font-semibold text-white">毛玻璃暗色</div>
              <div className="rounded-lg bg-gradient-to-br from-slate-900 via-fuchsia-950 to-sky-950 p-4">
                <div className="w-32 rounded-xl bg-black/62 p-2 shadow-lg backdrop-blur"><div className="mb-2 h-5 rounded bg-white/15" /><div className="space-y-1"><div className="h-3 rounded bg-white/20" /><div className="h-3 rounded bg-violet-400/30" /><div className="h-3 rounded bg-white/10" /></div></div>
              </div>
            </div>
          </div>
          <div className="space-y-4 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-medium text-slate-900 omni-settings-title">悬浮与窗口</h3>
            <Field label="菜单打开"><select value={basicSettings.menuOpenMode} onChange={(e) => updateBasicSettings({ menuOpenMode: e.target.value as MenuOpenMode })} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"><option value="hover">悬停</option><option value="click">点击</option></select></Field>
            <Actions label="开机自启"><input type="checkbox" checked={basicSettings.autoLaunch} onChange={(e) => updateBasicSettings({ autoLaunch: e.target.checked })} /><span className="text-xs text-slate-500 omni-settings-muted">已保存开关，接入系统自启插件后生效。</span></Actions>
            <Field label="最小化按钮"><select value={basicSettings.minimizeBehavior} onChange={(e) => updateBasicSettings({ minimizeBehavior: e.target.value as MinimizeBehavior })} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"><option value="taskbar">最小化到任务栏</option><option value="compact">收起到悬浮球</option></select></Field>
            <Field label="打开主窗口"><select value={basicSettings.mainWindowPositionMode} onChange={(e) => updateBasicSettings({ mainWindowPositionMode: e.target.value as WindowPositionMode })} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"><option value="center">居中</option><option value="remember">记住上次位置</option></select></Field>
            <Actions label="悬浮球"><input type="checkbox" checked={basicSettings.showCompactBall} onChange={(e) => updateBasicSettings({ showCompactBall: e.target.checked })} /><span className="text-xs text-slate-500 omni-settings-muted">控制主窗口隐藏后是否显示悬浮球。</span></Actions>
          </div>
          <div className="space-y-4 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-medium text-slate-900 omni-settings-title">默认尺寸</h3>
            <div className="space-y-3">
              <div className="grid grid-cols-[120px_1fr] gap-4">
                <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">主窗口尺寸</label>
                <div className="flex items-center gap-2">
                  <input type="number" min="640" max="1800" value={basicSettings.mainWindowWidth} onChange={(e) => updateBasicSettings({ mainWindowWidth: Number(e.target.value) })} className="h-9 w-28 rounded-md border border-slate-300 px-3 text-sm" />
                  <span className="text-xs text-slate-500 omni-settings-muted">×</span>
                  <input type="number" min="480" max="1400" value={basicSettings.mainWindowHeight} onChange={(e) => updateBasicSettings({ mainWindowHeight: Number(e.target.value) })} className="h-9 w-28 rounded-md border border-slate-300 px-3 text-sm" />
                  <span className="text-xs text-slate-500 omni-settings-muted">宽 × 高</span>
                </div>
              </div>
              <div className="grid grid-cols-[120px_1fr] gap-4">
                <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">设置窗口尺寸</label>
                <div className="flex items-center gap-2">
                  <input type="number" min="640" max="1800" value={basicSettings.settingsWindowWidth} onChange={(e) => updateBasicSettings({ settingsWindowWidth: Number(e.target.value) })} className="h-9 w-28 rounded-md border border-slate-300 px-3 text-sm" />
                  <span className="text-xs text-slate-500 omni-settings-muted">×</span>
                  <input type="number" min="480" max="1400" value={basicSettings.settingsWindowHeight} onChange={(e) => updateBasicSettings({ settingsWindowHeight: Number(e.target.value) })} className="h-9 w-28 rounded-md border border-slate-300 px-3 text-sm" />
                  <span className="text-xs text-slate-500 omni-settings-muted">宽 × 高</span>
                </div>
              </div>
            </div>
          </div>
          <div className="space-y-4 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-medium text-slate-900 omni-settings-title">快捷键</h3>
            <Field label="打开主界面"><button type="button" onFocus={() => setRecordingShortcut("openMainShortcut")} onBlur={() => setRecordingShortcut(null)} onKeyDown={(e) => captureShortcut(e, "openMainShortcut")} onClick={(e) => e.currentTarget.focus()} className={`omni-shortcut-capture h-9 w-full rounded-md border px-3 text-left text-sm ${recordingShortcut === "openMainShortcut" ? "omni-shortcut-capture--active border-violet-500 text-violet-600 ring-2 ring-violet-500/20" : "border-slate-300"}`}><span>{recordingShortcut === "openMainShortcut" ? "请按快捷键..." : basicSettings.openMainShortcut}</span>{recordingShortcut === "openMainShortcut" && <span className="ml-2 rounded bg-violet-600 px-1.5 py-0.5 text-[10px] text-white">录入中</span>}</button></Field>
            <Field label="切换上个模型"><button type="button" onFocus={() => setRecordingShortcut("switchPreviousModelShortcut")} onBlur={() => setRecordingShortcut(null)} onKeyDown={(e) => captureShortcut(e, "switchPreviousModelShortcut")} onClick={(e) => e.currentTarget.focus()} className={`omni-shortcut-capture h-9 w-full rounded-md border px-3 text-left text-sm ${recordingShortcut === "switchPreviousModelShortcut" ? "omni-shortcut-capture--active border-violet-500 text-violet-600 ring-2 ring-violet-500/20" : "border-slate-300"}`}><span>{recordingShortcut === "switchPreviousModelShortcut" ? "请按快捷键..." : basicSettings.switchPreviousModelShortcut}</span>{recordingShortcut === "switchPreviousModelShortcut" && <span className="ml-2 rounded bg-violet-600 px-1.5 py-0.5 text-[10px] text-white">录入中</span>}</button></Field>
            <p className="pl-[136px] text-xs text-slate-500 omni-settings-muted">点击快捷键框后直接按键设置，Backspace / Delete / Esc 清空。</p>
          </div>
        </section>
      ) : (
        <>
      <section className="space-y-3">
        <div className="flex justify-end"><button onClick={openNewModelForm} className="rounded-md bg-slate-900 px-4 py-2 text-xs text-white" type="button">新增模型</button></div>
        <div className="space-y-2">{endpointModels.length === 0 ? <div className="rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-xs text-slate-400">暂无自定义模型，点击右上角新增。</div> : endpointModels.map((m) => <button key={m.id} onClick={() => openEditModelForm(m)} className="flex w-full items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs hover:border-violet-200 hover:bg-violet-50" type="button"><span className="font-medium text-slate-800">{m.name}</span><span className="text-slate-400">{m.requestModelId || m.id}</span><span className="ml-auto text-slate-400">{m.endpointName}</span>{m.supportsVision && <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700">Vision</span>}{m.supportsStreaming && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">Stream</span>}</button>)}</div>
      </section>
      <section className="space-y-4">
        <div className="border-b border-slate-100 pb-2"><h3 className="text-sm font-medium text-slate-900">使用偏好</h3><p className="mt-0.5 text-xs text-slate-500">控制默认请求参数，最终会与模型能力共同决定实际行为。</p></div>
        <Actions label="默认流式"><input type="checkbox" checked={prefs.enableStreaming} onChange={(e) => setPrefs({ ...prefs, enableStreaming: e.target.checked })} /></Actions>
        <Actions label="允许图片"><input type="checkbox" checked={prefs.enableVisionInput} onChange={(e) => setPrefs({ ...prefs, enableVisionInput: e.target.checked })} /></Actions>
        <Field label="Temperature"><input type="number" step="0.1" value={prefs.temperature} onChange={(e) => setPrefs({ ...prefs, temperature: Number(e.target.value) })} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" /></Field>
        <Field label="最大输出 Token">
          <div className="space-y-1">
            <input type="number" value={prefs.maxOutputTokens} onChange={(e) => setPrefs({ ...prefs, maxOutputTokens: Number(e.target.value) })} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" />
            <p className="omni-settings-muted text-[11px] text-slate-500">限制单次回复最多生成的 token 数，不等于模型上下文长度。</p>
          </div>
        </Field>
        <Actions>
          <div className="flex items-center gap-3">
            <button
              onClick={savePrefs}
              className={`rounded-md px-4 py-2 text-xs font-medium text-white transition-colors ${prefsSaveStatus === "saved" ? "bg-emerald-600" : prefsSaveStatus === "error" ? "bg-red-600" : "bg-violet-600 hover:bg-violet-500"}`}
              type="button"
            >
              {prefsSaveStatus === "saved" ? "已保存" : prefsSaveStatus === "error" ? "保存失败" : "保存偏好"}
            </button>
            {prefsSaveStatus === "saved" && <span className="text-xs text-emerald-600">偏好已生效</span>}
            {prefsSaveStatus === "error" && <span className="text-xs text-red-500">请重试</span>}
          </div>
        </Actions>
      </section>
        </>
      )}
    </div></div></section>
    {isModelFormOpen && <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/25 px-6">
      <div className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3"><div><h3 className="text-sm font-semibold text-slate-900">{editingModel ? "编辑模型" : "新增模型"}</h3><p className="mt-0.5 text-xs text-slate-500">配置完成后保存并返回模型列表。</p></div><button onClick={() => setIsModelFormOpen(false)} className="text-slate-400 hover:text-slate-700" type="button">×</button></div>
        <div className="space-y-4">
          <Field label="所属接口"><select value={endpoints.some((e) => e.id === modelEndpointId) ? modelEndpointId : "__new__"} onChange={(e) => chooseEndpoint(e.target.value)} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"><option value="__new__">新建自定义接口</option>{endpoints.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
          {!endpoints.some((e) => e.id === modelEndpointId) && (
            <Field label="接口 ID"><input value={modelEndpointId} onChange={(e) => setModelEndpointId(e.target.value)} placeholder="my-gateway" className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" /></Field>
          )}
          <Field label="接口名称"><input value={endpointName} onChange={(e) => setEndpointName(e.target.value)} placeholder="公司网关" className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" /></Field>
          <Field label="Base URL"><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://example.com/v1" className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" /></Field>
          <Field label="API Key"><input type="password" value={apiKey} onFocus={() => apiKey === MASK && setApiKey("")} onChange={(e) => setApiKey(e.target.value)} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" /></Field>
          <Field label="模型 ID"><input value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="gpt-4o / deepseek-chat" className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" /></Field>
          <Field label="显示名称"><input value={modelName} onChange={(e) => setModelName(e.target.value)} className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm" /></Field>
          <Actions><label className="text-sm"><input type="checkbox" checked={modelVision} onChange={(e) => setModelVision(e.target.checked)} /> Vision</label><label className="text-sm"><input type="checkbox" checked={modelStreaming} onChange={(e) => setModelStreaming(e.target.checked)} /> Streaming</label></Actions>
          <Actions><button onClick={testConnection} disabled={testingConnection || !modelEndpointId.trim() || !endpointName.trim() || !baseUrl.trim() || (!apiKey.trim() && !getRawApiKey(modelEndpointId.trim()))} className="rounded-md border border-slate-200 px-4 py-2 text-xs text-slate-600 disabled:opacity-40" type="button">{testingConnection ? "测试中..." : "测试连接"}</button><button onClick={saveModel} disabled={testingConnection || !modelEndpointId.trim() || !endpointName.trim() || !baseUrl.trim() || !modelId.trim() || (!apiKey.trim() && !getRawApiKey(modelEndpointId.trim()))} className="rounded-md bg-violet-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-40" type="button">{testingConnection ? "检测中..." : "保存模型"}</button><button onClick={() => setIsModelFormOpen(false)} className="rounded-md border border-slate-200 px-4 py-2 text-xs text-slate-600" type="button">取消</button>{editingModel && <button onClick={() => { removeModel(editingModel.endpointId, editingModel.id); setEditingModel(null); setIsModelFormOpen(false); }} className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-xs text-red-600" type="button">删除模型</button>}{testResult === true && <span className="text-xs text-emerald-600">连接成功</span>}{testResult === false && <span className="text-xs text-red-600">连接失败</span>}</Actions>
        </div>
      </div>
    </div>}
    </div>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="grid grid-cols-[120px_1fr] gap-4"><label className="pt-2 text-right text-sm text-slate-700">{label}</label>{children}</div>; }
function Actions({ label, children }: { label?: string; children: React.ReactNode }) { return <div className="grid grid-cols-[120px_1fr] gap-4"><span className="pt-1 text-right text-sm text-slate-700">{label}</span><div className="flex items-center gap-3">{children}</div></div>; }
