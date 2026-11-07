import { Channel, invoke } from "@tauri-apps/api/core";

type Event = { type: "headers"; status: number; headers: Record<string, string> } | { type: "chunk"; data: number[] } | { type: "end" } | { type: "error"; message: string };

export function isLoopbackHttpUrl(raw: string) {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch { return false; }
}

export function shouldProxyLoopbackHttp(raw: string) {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && isLoopbackHttpUrl(raw);
}

export async function fetchLoopbackHttp(url: string, init: RequestInit, signal?: AbortSignal, timeoutMs = 60_000): Promise<Response> {
  if (!shouldProxyLoopbackHttp(url)) throw new Error("URL is not an eligible Tauri loopback request");
  if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
  const requestId = crypto.randomUUID();
  const channel = new Channel<Event>();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let headersReceived = false;
  let settled = false;
  let resolveResponse!: (response: Response) => void;
  let rejectResponse!: (error: unknown) => void;
  const ready = new Promise<Response>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  const cancel = () => {
    signal?.removeEventListener("abort", cancel);
    void invoke("cancel_loopback_http_request", { requestId }).catch(() => {});
    const error = new DOMException("Request aborted", "AbortError");
    if (!headersReceived && !settled) { settled = true; rejectResponse(error); }
    else controller?.error(error);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  channel.onmessage = (event) => {
    if (event.type === "chunk") { controller?.enqueue(Uint8Array.from(event.data)); return; }
    if (event.type === "headers") {
      headersReceived = true;
      const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
      settled = true;
      resolveResponse(new Response(body, { status: event.status, headers: event.headers }));
    } else if (event.type === "end") {
      signal?.removeEventListener("abort", cancel);
      controller?.close();
    }
    else {
      signal?.removeEventListener("abort", cancel);
      const error = new Error(event.message);
      if (!headersReceived && !settled) { settled = true; rejectResponse(error); }
      else controller?.error(error);
    }
  };
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  void invoke("loopback_http_request", { request: { requestId, url, method: init.method ?? "GET", headers, body: typeof init.body === "string" ? init.body : undefined, timeoutMs }, onEvent: channel })
    .catch((error: unknown) => { if (!settled) { settled = true; rejectResponse(error); } else controller?.error(error); });
  try { return await ready; }
  catch (error) { signal?.removeEventListener("abort", cancel); throw error; }
}
