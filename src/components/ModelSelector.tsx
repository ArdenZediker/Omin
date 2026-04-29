import { useEffect, useRef, useState } from "react";
import { ChevronDown, Eye } from "lucide-react";
import { modelRegistry } from "../adapters/registry";
import { BUILTIN_MODELS, type ModelConfig } from "../adapters/types";

interface ModelSelectorProps {
  currentModel: string;
  onModelChange: (modelId: string) => void;
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: "from-green-400 to-emerald-600",
  claude: "from-orange-400 to-amber-600",
  gemini: "from-blue-400 to-cyan-600",
  ollama: "from-purple-400 to-violet-600",
  deepseek: "from-indigo-400 to-blue-600",
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
    const status = JSON.parse(localStorage.getItem(MODEL_CONNECTION_STATUS_KEY) || "{}") as Record<string, boolean>;
    return status[modelId];
  } catch {
    return undefined;
  }
}

export default function ModelSelector({ currentModel, onModelChange }: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const models = modelRegistry.getAvailableModels();
  const currentConfig = modelRegistry.getModelConfig(currentModel);
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

  if (models.length === 0) {
    return <div className="model-selector-empty">未配置模型</div>;
  }

  return (
    <div className="model-selector" ref={dropdownRef}>
      <button onClick={() => setIsOpen(!isOpen)} className="model-selector__trigger" type="button">
        {currentConfig && (
          <div
            className={`w-2 h-2 rounded-full ${
              currentStatus === true
                ? "bg-emerald-400"
                : currentStatus === false
                  ? "bg-red-400"
                  : `bg-gradient-to-br ${PROVIDER_COLORS[currentConfig.provider] || "from-gray-400 to-gray-600"}`
            }`}
          />
        )}
        <span>{currentConfig?.name || currentModel}</span>
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
                  >
                    <div
                      className={`w-1.5 h-1.5 rounded-full ${
                        connectionStatus === true
                          ? "bg-emerald-400"
                          : connectionStatus === false
                            ? "bg-red-400"
                            : `bg-gradient-to-br ${PROVIDER_COLORS[provider] || "from-gray-400 to-gray-600"}`
                      }`}
                    />
                    <span>{model.name}</span>

                    {isCustom && <span className="model-selector__badge">Custom</span>}

                    {model.supportsVision && <Eye className="model-selector__vision" aria-label="支持视觉" strokeWidth={1.5} />}
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
