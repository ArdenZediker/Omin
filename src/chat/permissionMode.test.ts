import { afterEach, describe, expect, it, vi } from "vitest";
import { getPermissionMode, isFullAccess, setPermissionMode, subscribePermissionMode } from "./permissionMode";

describe("permissionMode", () => {
  afterEach(() => {
    setPermissionMode("default");
  });

  it("默认状态为 default 且非完全访问", () => {
    expect(getPermissionMode()).toBe("default");
    expect(isFullAccess()).toBe(false);
  });

  it("切换为 full-access 后状态同步更新", () => {
    setPermissionMode("full-access");
    expect(getPermissionMode()).toBe("full-access");
    expect(isFullAccess()).toBe(true);
  });

  it("重复设置相同模式不会触发订阅回调", () => {
    const listener = vi.fn();
    subscribePermissionMode(listener);
    listener.mockClear();

    setPermissionMode("default");
    expect(listener).not.toHaveBeenCalled();
  });

  it("订阅者会立即收到当前模式，并在切换后收到通知", () => {
    setPermissionMode("default");
    const values: string[] = [];
    const unsub = subscribePermissionMode((mode) => values.push(mode));

    expect(values).toEqual(["default"]);

    setPermissionMode("full-access");
    expect(values).toEqual(["default", "full-access"]);

    unsub();
  });

  it("取消订阅后不再接收通知", () => {
    const listener = vi.fn();
    const unsub = subscribePermissionMode(listener);
    unsub();

    setPermissionMode("full-access");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
