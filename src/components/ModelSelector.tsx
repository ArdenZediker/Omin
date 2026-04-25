import { useEffect, useRef, useState } from "react";
import { BUILTIN_MODELS, type ModelConfig } from "../adapters/types";
import { modelRegistry } from "../adapters/registry";

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
    if (!acc[model.provider]) acc[model.provider] = [];
    acc[model.provider].push(model);
    return acc;
  }, {});

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (models.length === 0) {
    return (
      <div className="model-selector-empty">
        未配置模型
      </div>
    );
  }

  return (
    <div className="model-selector" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="model-selector__trigger"
        type="button"
      >
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
        <svg
          className={`model-selector__chevron ${isOpen ? "model-selector__chevron--open" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && (
        <div className="model-selector__dropdown animate-fade-in">
          {Object.entries(grouped).map(([provider, providerModels]) => (
            <div key={provider}>
              <div className="model-selector__group-label">
                {PROVIDER_LABELS[provider] || provider}
              </div>

              {providerModels.map((model) => {
                const isCustom = !BUILTIN_MODELS.find((b) => b.id === model.id);
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

                    {isCustom && (
                      <span className="model-selector__badge">
                        Custom
                      </span>
                    )}

                    {model.supportsVision && (
                      <svg
                        className="model-selector__vision"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-label="Vision supported"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                      </svg>
                    )}
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
