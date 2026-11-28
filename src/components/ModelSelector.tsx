import { useEffect, useRef, useState } from "react";
import { ChevronDown, Eye } from "lucide-react";
import { modelRegistry } from "../adapters/registry";
import { BUILTIN_MODELS, type ModelConfig } from "../adapters/types";
import { readSqliteBackedJson } from "../app/sqliteStorage";

interface ModelSelectorProps {
  currentModel: string | null;
  label?: string;
  title?: string;
  onModelChange: (modelId: string) => void;
  openSignal?: number;
}

const PROVIDER_STATUS_CLASSES: Record<string, string> = {
  openai: "model-selector__status-dot--openai",
  claude: "model-selector__status-dot--claude",
  gemini: "model-selector__status-dot--gemini",
  ollama: "model-selector__status-dot--ollama",
  deepseek: "model-selector__status-dot--deepseek",
};

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI",
  claude: "Claude",
  gemini: "Gemini",
  ollama: "Ollama",
  deepseek: "DeepSeek",
};

const MODEL_CONNECTION_STATUS_KEY = "omni_model_connection_status";

function getModelConnectionStatus(modelId: string) {
  try {
    const status = readSqliteBackedJson<Record<string, boolean>>(MODEL_CONNECTION_STATUS_KEY, {});
    return status[modelId];
  } catch {
    return undefined;
  }
}

function getStatusDotClass(status: boolean | undefined, provider: string) {
  if (status === true) return "model-selector__status-dot--connected";
  if (status === false) return "model-selector__status-dot--disconnected";
  return PROVIDER_STATUS_CLASSES[provider] || "model-selector__status-dot--unknown";
}

function getStatusLabel(status: boolean | undefined, provider: string) {
  if (status === true) return "已连接";
  if (status === false) return "连接失败";
  return `${PROVIDER_LABELS[provider] || provider} 模型`;
}

function formatContextWindow(tokens: number) {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return `${tokens}`;
}

export default function ModelSelector({ currentModel, label, title, onModelChange, openSignal }: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const models = modelRegistry.getAvailableModels();
  const currentConfig = currentModel ? modelRegistry.getModelConfig(currentModel) : undefined;
  const currentStatus = currentConfig ? getModelConnectionStatus(currentConfig.id) : undefined;

  const grouped = models.reduce<Record<string, ModelConfig[]>>((acc, model) => {
    if (!acc[model.provider]) {
      acc[model.provider] = [];
    }
    acc[model.provider].push(model);
    return acc;
  }, {});

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (typeof openSignal === "number" && openSignal > 0) {
      setIsOpen(true);
    }
  }, [openSignal]);

  if (models.length === 0) {
    return <div className="model-selector-empty">未配置模型</div>;
  }

  return (
    <div className="model-selector" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="model-selector__trigger"
        type="button"
        title={title}
        aria-expanded={isOpen}
      >
        {currentConfig && (
          <span
            className={`model-selector__status-dot ${getStatusDotClass(currentStatus, currentConfig.provider)}`}
            role="img"
            aria-label={`模型状态：${getStatusLabel(currentStatus, currentConfig.provider)}`}
          />
        )}
        <span>{label ? `${label}：${currentConfig?.name || "未选择模型"}` : currentConfig?.name || "未选择模型"}</span>
        <ChevronDown className={`model-selector__chevron ${isOpen ? "model-selector__chevron--open" : ""}`} strokeWidth={2} />
      </button>

      {isOpen && (
        <div className="model-selector__dropdown animate-fade-in">
          {Object.entries(grouped).map(([provider, providerModels]) => (
            <div key={provider}>
              <div className="model-selector__group-label">{PROVIDER_LABELS[provider] || provider}</div>

              {providerModels.map((model) => {
                const isCustom = !BUILTIN_MODELS.find((builtInModel) => builtInModel.id === model.id);
                const connectionStatus = getModelConnectionStatus(model.id);

                return (
                  <button
                    key={model.id}
                    onClick={() => {
                      onModelChange(model.id);
                      setIsOpen(false);
                    }}
                    className={`model-selector__option ${model.id === currentModel ? "model-selector__option--active" : ""}`}
                    type="button"
                    aria-pressed={model.id === currentModel}
                  >
                    <span
                      className={`model-selector__status-dot model-selector__status-dot--small ${getStatusDotClass(connectionStatus, provider)}`}
                      role="img"
                      aria-label={`模型状态：${getStatusLabel(connectionStatus, provider)}`}
                    />
                    <span className="model-selector__model-name">{model.name}</span>

                    {isCustom && <span className="model-selector__badge">Custom</span>}

                    {model.thinking && (
                      <span className="model-selector__badge model-selector__badge--thinking" title="推理模型：带思考链输出">
                        深度思考
                      </span>
                    )}

                    {model.toolCalling === false && (
                      <span className="model-selector__badge model-selector__badge--danger" title="该模型不支持工具调用">
                        无工具
                      </span>
                    )}

                    <span className="model-selector__window" title={`上下文窗口 ${model.maxTokens.toLocaleString()} tokens`}>
                      {formatContextWindow(model.maxTokens)}
                    </span>

                    {model.supportsVision && <Eye className="model-selector__vision" aria-label="支持视觉" strokeWidth={1.8} />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
