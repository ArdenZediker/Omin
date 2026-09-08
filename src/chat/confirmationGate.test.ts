import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  requestConfirmation,
  resolveConfirmation,
  setConfirmationTimeout,
  subscribeConfirmation,
  type ConfirmationRequest,
} from "./confirmationGate";
import { canGrantSessionPermission, clearSessionPermissions, getPermissionMode, grantSessionPermission, isSessionGranted, setPermissionMode } from "./permissionMode";

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
  beforeEach(() => {
    setConfirmationTimeout(1000);
    if (getPermissionMode() !== "default") {
      setPermissionMode("default");
    }
  });
  afterEach(() => {
    setConfirmationTimeout(5 * 60 * 1000);
    setPermissionMode("default");
  });

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

  it("完全访问模式下跳过确认直接放行", async () => {
    setPermissionMode("full-access");
    await expect(requestConfirmation(baseRequest)).resolves.toBe(true);
  });
});

describe("会话临时授权（本次使用期间同类操作免重复确认）", () => {
  beforeEach(() => {
    setConfirmationTimeout(1000);
    setPermissionMode("default");
    clearSessionPermissions();
  });
  afterEach(() => {
    setConfirmationTimeout(5 * 60 * 1000);
    setPermissionMode("default");
    clearSessionPermissions();
  });

  function requestOf(source: string, riskLevel: ConfirmationRequest["riskLevel"]): ConfirmationRequest {
    return { ...baseRequest, source, riskLevel };
  }

  it("授权后同来源直接放行，不同来源仍走确认", async () => {
    let captured: { id: string } | null = null;
    const unsub = subscribeConfirmation((req) => {
      captured = req;
    });

    const first = requestConfirmation(requestOf("bash", "write"));
    resolveConfirmation(captured!.id, true, true);
    await expect(first).resolves.toBe(true);
    expect(isSessionGranted("bash")).toBe(true);

    // 同来源：直接放行，不再挂 pending
    await expect(requestConfirmation(requestOf("bash", "write"))).resolves.toBe(true);

    // 不同来源：仍需确认
    const second = requestConfirmation(requestOf("write_file", "write"));
    expect(captured!.id).toBeDefined();
    resolveConfirmation(captured!.id, true);
    await expect(second).resolves.toBe(true);
    expect(isSessionGranted("write_file")).toBe(false);

    unsub();
  });

  it("destructive / irreversible 来源即使误传 grant 也不会被授权", async () => {
    let captured: { id: string } | null = null;
    const unsub = subscribeConfirmation((req) => {
      captured = req;
    });

    const promise = requestConfirmation(requestOf("ui:delete_chat_session", "destructive"));
    resolveConfirmation(captured!.id, true, true);
    await expect(promise).resolves.toBe(true);
    expect(isSessionGranted("ui:delete_chat_session")).toBe(false);

    unsub();
  });

  it("canGrantSessionPermission：write/read 可授予，destructive/irreversible 与 ui: 动作不可", () => {
    expect(canGrantSessionPermission({ source: "bash", riskLevel: "write" })).toBe(true);
    expect(canGrantSessionPermission({ source: "read_out_of_workspace", riskLevel: "read" })).toBe(true);
    expect(canGrantSessionPermission({ source: "git_commit", riskLevel: "destructive" })).toBe(false);
    expect(canGrantSessionPermission({ source: "git_pr", riskLevel: "irreversible" })).toBe(false);
    expect(canGrantSessionPermission({ source: "ui:delete_project", riskLevel: "write" })).toBe(false);
  });

  it("切换权限模式时清空全部临时授权", () => {
    grantSessionPermission("bash");
    expect(isSessionGranted("bash")).toBe(true);
    setPermissionMode("full-access");
    setPermissionMode("default");
    expect(isSessionGranted("bash")).toBe(false);
  });
});
