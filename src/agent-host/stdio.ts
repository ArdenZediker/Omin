import type { AgentHost } from "./host";
import type {
  HostRequest,
  HostResponse,
  HostServerMessage,
} from "./protocol";

export type LineWriter = (line: string) => void | Promise<void>;

/**
 * Newline-delimited JSON Host transport.
 *
 * Input is read line-by-line. Requests are dispatched as soon as a complete
 * line arrives, while output writes are serialized so concurrent commands
 * cannot interleave half a frame.
 */
export class HostStdioServer {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly host: AgentHost,
    private readonly write: LineWriter,
  ) {
    this.host.subscribe((message) => {
      void this.send(message);
    });
  }

  async run(input: AsyncIterable<string>): Promise<void> {
    for await (const line of input) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Preserve command order on one connection. Commands that only enqueue
      // work still return before the driver finishes; `when-idle` and
      // cancellation remain safe to send after the enqueue response.
      await this.handleLine(trimmed);
    }
    await this.writeTail;
  }

  private async handleLine(line: string): Promise<void> {
    let request: HostRequest;
    try {
      request = JSON.parse(line) as HostRequest;
    } catch {
      await this.send({
        kind: "response",
        id: "",
        ok: false,
        error: { message: "Host request must be valid JSON", code: "PARSE_ERROR" },
      });
      return;
    }
    if (
      request?.kind !== "request"
      || typeof request.id !== "string"
      || typeof request.command !== "string"
    ) {
      await this.send({
        kind: "response",
        id: typeof request?.id === "string" ? request.id : "",
        ok: false,
        error: { message: "Invalid Host request envelope", code: "INVALID_REQUEST" },
      });
      return;
    }
    const response: HostResponse = await this.host.handle(request);
    await this.send(response);
  }

  private send(message: HostServerMessage): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    const write = this.writeTail.then(() => this.write(line));
    this.writeTail = write.catch(() => undefined);
    return write;
  }
}
