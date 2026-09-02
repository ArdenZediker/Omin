import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  requestConfirmation,
  resolveConfirmation,
  setConfirmationTimeout,
  subscribeConfirmation,
  type ConfirmationRequest,
} from "./confirmationGate";

const baseRequest: ConfirmationRequest = {
  source: "test",
  title: "T",
  summary: "S",
  riskLevel: "destructive",
  details: [],
  targets: [],
  warning: "W",
};

describe("confirmationGate", () => {
  beforeEach(() => setConfirmationTimeout(1000));
  afterEach(() => setConfirmationTimeout(5 * 60 * 1000));

  it("无监听器时直接拒绝（安全优先于可用性）", async () => {
    await expect(requestConfirmation(baseRequest)).resolves.toBe(false);
  });

  it("用户确认后放行", async () => {
    let captured: { id: string } | null = null;
    const unsub = subscribeConfirmation((req) => {
      captured = req;
    });
    const promise = requestConfirmation(baseRequest);
    expect(captured).not.toBeNull();
    resolveConfirmation(captured!.id, true);
    await expect(promise).resolves.toBe(true);
    unsub();
  });

  it("用户取消后拒绝", async () => {
    let captured: { id: string } | null = null;
    const unsub = subscribeConfirmation((req) => {
      captured = req;
    });
    const promise = requestConfirmation(baseRequest);
    resolveConfirmation(captured!.id, false);
    await expect(promise).resolves.toBe(false);
    unsub();
  });

  it("已有待确认请求时新请求直接拒绝（不排队）", async () => {
    let captured: { id: string } | null = null;
    const unsub = subscribeConfirmation((req) => {
      captured = req;
    });
    const first = requestConfirmation(baseRequest);
    const second = requestConfirmation(baseRequest);
    await expect(second).resolves.toBe(false);
    resolveConfirmation(captured!.id, true);
    await expect(first).resolves.toBe(true);
    unsub();
  });

  it("超时未响应自动拒绝（防止工具循环永久挂起）", async () => {
    setConfirmationTimeout(50);
    subscribeConfirmation(() => {});
    await expect(requestConfirmation(baseRequest)).resolves.toBe(false);
    setConfirmationTimeout(5 * 60 * 1000);
  });
});
