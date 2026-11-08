import {
  AgentRuntime,
  AgentToolRegistry,
  JsonlSessionEventStore,
  type SessionEventStore,
} from "../agent-core";
import { AdapterModelProvider } from "./adapter-model-provider";
import { AgentHost } from "./host";
import { FileEventLogPort } from "./node-event-log";

export interface PersistentAgentHostOptions {
  dataDir: string;
  tools?: AgentToolRegistry;
  store?: SessionEventStore;
}

export interface PersistentAgentHost {
  host: AgentHost;
  providers: AdapterModelProvider;
  runtime: AgentRuntime;
  store: SessionEventStore;
}

export function createPersistentAgentHost(
  options: PersistentAgentHostOptions,
): PersistentAgentHost {
  const store = options.store
    ?? new JsonlSessionEventStore(new FileEventLogPort(options.dataDir));
  const providers = new AdapterModelProvider();
  const runtime = new AgentRuntime({
    store,
    model: providers,
    tools: options.tools ?? new AgentToolRegistry(),
  });
  return {
    host: new AgentHost(runtime, providers),
    providers,
    runtime,
    store,
  };
}
