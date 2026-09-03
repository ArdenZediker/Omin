import { describe, it, expect, vi } from "vitest";
import { iterateStream } from "./http";

type ReaderChunk = { done: boolean; value?: Uint8Array };

/** 正常结束的 reader：chunk 发完后返回 done=true */
function createEndingReader(chunks: Uint8Array[]): ReadableStreamDefaultReader<Uint8Array> {
  let index = 0;
  return {
    read: vi.fn(async (): Promise<ReaderChunk> =>
      index < chunks.length
        ? { done: false, value: chunks[index++] }
        : { done: true, value: undefined }
    ),
    cancel: vi.fn(async () => {}),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

/** 挂起的 reader：发完部分 chunk 后永久 pending，模拟「服务端连上后不再发数据」 */
function createHangingReader(chunks: Uint8Array[]): {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  cancelSpy: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  let cancelled = false;
  let pendingResolve: ((r: ReaderChunk) => void) | null = null;
  const cancelSpy = vi.fn(async () => {
    cancelled = true;
    pendingResolve?.({ done: true, value: undefined });
  });
  const reader = {
    read: vi.fn(
      (): Promise<ReaderChunk> => {
        if (cancelled) return Promise.resolve({ done: true, value: undefined });
        if (index < chunks.length) {
          return Promise.resolve({ done: false, value: chunks[index++] });
        }
        // 之后永久挂起
        return new Promise<ReaderChunk>((resolve) => {
          pendingResolve = resolve;
        });
      }
    ),
    cancel: cancelSpy,
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
  return { reader, cancelSpy };
}

const enc = (text: string) => new TextEncoder().encode(text);

describe("iterateStream 超时与取消兜底", () => {
  it("正常流：逐块 yield 全部数据，并在 done 后结束", async () => {
    const reader = createEndingReader([enc("a"), enc("b"), enc("c")]);
    const collected: Uint8Array[] = [];
    for await (const value of iterateStream(reader, { idleTimeoutMs: 10_000, totalTimeoutMs: 10_000 })) {
      collected.push(value);
    }
    expect(collected).toHaveLength(3);
    expect(new TextDecoder().decode(collected[1])).toBe("b");
  });

  it("空闲超时：服务端连上后不再发数据 → 抛「响应中断」错误而非永久挂起", async () => {
    const { reader, cancelSpy } = createHangingReader([enc("first")]);
    const collected: Uint8Array[] = [];
    await expect(
      (async () => {
        for await (const value of iterateStream(reader, { idleTimeoutMs: 40, totalTimeoutMs: 10_000 })) {
          collected.push(value);
        }
      })()
    ).rejects.toThrow(/响应中断/);
    expect(collected).toHaveLength(1);
    // 超时时主动 cancel，避免挂起的 read 永久 pending
    expect(cancelSpy).toHaveBeenCalled();
  });

  it("总时长超时：从未返回任何数据 → 抛「响应超时」错误", async () => {
    const { reader, cancelSpy } = createHangingReader([]);
    await expect(
      (async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _value of iterateStream(reader, { idleTimeoutMs: 10_000, totalTimeoutMs: 40 })) {
          /* noop */
        }
      })()
    ).rejects.toThrow(/响应超时/);
    expect(cancelSpy).toHaveBeenCalled();
  });

  it("外部 signal 中止：立即抛 AbortError", async () => {
    const { reader } = createHangingReader([enc("x")]);
    const controller = new AbortController();
    const promise = (async () => {
      for await (const _value of iterateStream(reader, {
        signal: controller.signal,
        idleTimeoutMs: 10_000,
        totalTimeoutMs: 10_000,
      })) {
        /* noop */
      }
    })();
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(DOMException);
  });

  it("signal 在开始前已中止：直接抛 AbortError，不读取任何数据", async () => {
    const reader = createEndingReader([enc("never")]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      (async () => {
        for await (const _value of iterateStream(reader, {
          signal: controller.signal,
          idleTimeoutMs: 10_000,
          totalTimeoutMs: 10_000,
        })) {
          /* noop */
        }
      })()
    ).rejects.toBeInstanceOf(DOMException);
  });
});
