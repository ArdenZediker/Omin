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

/**
 * 流式读取的空闲超时（毫秒）：两个 chunk 之间的最长间隔。
 * 推理模型可能长时间「只思考不吐字」，给足 3 分钟避免误杀。
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000;

/** 流式读取的总时长上限（毫秒）：防止无限流长期占用会话。 */
export const DEFAULT_STREAM_TOTAL_TIMEOUT_MS = 15 * 60_000;

export interface StreamIterateOptions {
  signal?: AbortSignal;
  /** 空闲超时（毫秒） */
  idleTimeoutMs?: number;
  /** 总时长上限（毫秒） */
  totalTimeoutMs?: number;
}

const WAKE = "__wake__";

/**
 * 带超时与取消的流式 body 读取迭代器。
 *
 * 关键背景：`fetch` 在**响应头到达**时就 resolve，此时 `fetchWithTimeout` 的定时器
 * 已在 finally 中被清理，后续 body 读取完全没有超时保护。一旦服务端连上后不再发数据
 * （代理挂起、推理模型卡住、连接半开），`reader.read()` 会永久 pending，
 * 表现为 UI 永远停在「正在思考」且只能手动停止。这里补上空闲超时 + 总超时兜底。
 *
 * 超时/取消时主动 `reader.cancel()`，让挂起的 read 立刻落定，避免 Promise 永远悬挂。
 */
export async function* iterateStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  opts: StreamIterateOptions = {}
): AsyncGenerator<Uint8Array, void, void> {
  const {
    signal,
    idleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    totalTimeoutMs = DEFAULT_STREAM_TOTAL_TIMEOUT_MS,
  } = opts;

  let stopReason: "idle" | "total" | "aborted" | null = null;
  let lastReadError: unknown = null;
  let wake: (() => void) | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    idleTimer = undefined;
    totalTimer = undefined;
  };

  const stop = (reason: "idle" | "total" | "aborted") => {
    if (stopReason) return;
    stopReason = reason;
    void reader.cancel().catch(() => {});
    wake?.();
  };

  const onAbort = () => stop("aborted");

  if (signal) {
    if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    totalTimer = setTimeout(() => stop("total"), totalTimeoutMs);

    for (;;) {
      if (stopReason) break;

      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop("idle"), idleTimeoutMs);

      // 竞态下 pending 可能在唤醒之后才 reject（流已被 cancel），吞掉避免 unhandled rejection
      const settled = reader.read().catch((error: unknown) => {
        lastReadError = error;
        return undefined;
      });

      let wakeFn: () => void = () => {};
      const wakePromise = new Promise<typeof WAKE>((resolve) => {
        wakeFn = () => resolve(WAKE);
      });
      wake = wakeFn;

      const result = await Promise.race([settled, wakePromise]);

      if (result === WAKE || result === undefined) {
        // 被超时/取消唤醒：等真正的 read 落定后退出，由下面的 stopReason 统一抛出语义化错误
        await settled;
        break;
      }

      const { done, value } = result;
      if (done) break;
      if (value && value.byteLength > 0) yield value;
    }
  } finally {
    clearTimers();
    signal?.removeEventListener("abort", onAbort);
    wake = null;
  }

  if (stopReason === "aborted") {
    throw new DOMException("Request aborted", "AbortError");
  }
  if (stopReason === "idle") {
    throw new Error(`响应中断：超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有收到新数据，已停止等待`);
  }
  if (stopReason === "total") {
    throw new Error(`响应超时：单次生成超过 ${Math.round(totalTimeoutMs / 60000)} 分钟，已停止等待`);
  }
  // 无超时、无取消：读取本身出错，原样抛出（网络错误等）
  if (lastReadError) {
    throw lastReadError;
  }
}
