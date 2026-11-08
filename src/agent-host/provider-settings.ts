import type { ModelProtocol } from "../adapters/types";

export interface AgentProviderSettings {
  provider: string;
  apiKey: string;
  baseUrl?: string;
  protocol?: ModelProtocol;
  customHeaders?: Record<string, string>;
}

export interface AgentProviderStatus {
  provider: string;
  protocol: ModelProtocol;
  baseUrl?: string;
  hasApiKey: boolean;
}

export interface AgentProviderRegistry {
  configureProvider(settings: AgentProviderSettings): AgentProviderStatus;
  removeProvider(provider: string): boolean;
  listProviders(): AgentProviderStatus[];
}
