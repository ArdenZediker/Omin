/**
 * 适配器共享 HTTP 助手：请求超时 + 指数退避重试。
 * 所有 fetch 必须透传 signal（取消 = 立即中断在途请求），并带超时防永久挂起。
 */

/** 默认请求超时（毫秒） */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** 429/5xx/网络错误最多重试次数（指数退避，含抖动） */
const MAX_RETRIES = 3;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发起带超时与取消的 fetch。
 * - 外部 signal 中止 → 立即中断在途请求
 * - 超时 → 抛「请求超时」错误
 * - 监听与定时器在请求结束后清理
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      throw new DOMException("Request aborted", "AbortError");
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      if (signal?.aborted) {
        throw error; // 用户取消
      }
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export interface RetryOptions {
  /** 超时（毫秒） */
  timeoutMs?: number;
  /** 是否允许重试（流式请求不重试，避免重复消费） */
  retryable?: boolean;
}

/**
 * POST JSON 并带指数退避重试。
 * 重试条件：429 / 408 / 409 / 5xx / 网络错误；用户取消与超时不重试。
 */
export async function postJsonWithRetry(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  opts: RetryOptions = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retryable = true } = opts;
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        { method: "POST", headers, body: JSON.stringify(body) },
        signal,
        timeoutMs
      );
    } catch (error) {
      // 网络错误 / 超时：非流式场景可重试（超时重试需谨慎，这里只重试网络错误）
      if (retryable && attempt < MAX_RETRIES && !(error instanceof DOMException && error.name === "AbortError")) {
        const isTimeout = error instanceof Error && error.message.startsWith("请求超时");
        if (!isTimeout) {
          attempt += 1;
          await sleep(300 * 2 ** attempt + Math.random() * 200);
          continue;
        }
      }
      throw error;
    }

    if (!response.ok) {
      const status = response.status;
      const retriable = retryable && (status >= 500 || status === 429 || status === 408 || status === 409);
      if (retriable && attempt < MAX_RETRIES) {
        const retryAfter = Number(response.headers.get("retry-after")) || 0;
        await response.body?.cancel().catch(() => {});
        attempt += 1;
        await sleep(Math.max(retryAfter * 1000, 300 * 2 ** attempt + Math.random() * 200));
        continue;
      }
      const err = await response.text().catch(() => "");
      throw new Error(`HTTP ${status}${err ? ` - ${err.slice(0, 500)}` : ""}`);
    }
    return response;
  }
}

/** 流式请求统一入口：带超时与取消，不做重试。 */
export async function postJsonStream(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  return fetchWithTimeout(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    signal,
    timeoutMs
  );
}
