import { createInterface } from "node:readline";
import { createPersistentAgentHost } from "./bootstrap";
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

  const app = createPersistentAgentHost({ dataDir });
  const server = new HostStdioServer(app.host, async (line) => {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(line, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
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

  await server.run(input);
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `omni-agent-host: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
