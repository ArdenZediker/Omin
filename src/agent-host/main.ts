import { createInterface } from "node:readline";
import { AgentToolRegistry } from "../agent-core";
import { createPersistentAgentHost } from "./bootstrap";
import {
  NativeStdioBridge,
  NativeToolController,
} from "./native-bridge";
import { HostStdioServer } from "./stdio";

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const dataDir = argumentValue("--data-dir") ?? process.env.OMNI_AGENT_DATA_DIR;
  if (!dataDir) {
    process.stderr.write("omni-agent-host: --data-dir or OMNI_AGENT_DATA_DIR is required\n");
    process.exitCode = 2;
    return;
  }

  const tools = new AgentToolRegistry();
  const nativeTools = new NativeToolController(tools);
  const app = createPersistentAgentHost({
    dataDir,
    tools,
    toolConfigurator: nativeTools,
  });
  let server: HostStdioServer;
  const nativeBridge = new NativeStdioBridge((message) => (
    server.sendProtocolMessage(message)
  ));
  nativeTools.attachBridge(nativeBridge);
  server = new HostStdioServer(app.host, async (line) => {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(line, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }, (message) => nativeTools.receive(message));
  const input = createInterface({
    input: process.stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    input.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await server.run(input);
  } finally {
    nativeTools.close("agent Host input closed");
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `omni-agent-host: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
