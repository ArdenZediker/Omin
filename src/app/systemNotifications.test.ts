import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendSystemNotification } from "./systemNotifications";

const { invokeMock, permissionGranted, requestPermission } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  permissionGranted: vi.fn(),
  requestPermission: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: permissionGranted,
  requestPermission,
}));

describe("sendSystemNotification", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    permissionGranted.mockResolvedValue(true);
    requestPermission.mockResolvedValue("granted");
    invokeMock.mockResolvedValue(undefined);
  });

  it("awaits the native notification command", async () => {
    await sendSystemNotification("标题", "正文");
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("plugin:notification|notify", {
      options: { title: "标题", body: "正文" },
    });
  });

  it("does not send when permission is denied", async () => {
    permissionGranted.mockResolvedValue(false);
    requestPermission.mockResolvedValue("denied");
    await expect(sendSystemNotification("标题", "正文")).rejects.toThrow("系统通知权限未获允许");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("propagates native delivery failures to the reminder scheduler", async () => {
    invokeMock.mockRejectedValue(new Error("native notification failed"));
    await expect(sendSystemNotification("标题", "正文")).rejects.toThrow("native notification failed");
  });
});
