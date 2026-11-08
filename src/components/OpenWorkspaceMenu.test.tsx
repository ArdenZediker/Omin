import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getWorkspaceOpenAppIconMock,
  listWorkspaceOpenAppsMock,
  openWorkspaceWithMock,
} = vi.hoisted(() => ({
  getWorkspaceOpenAppIconMock: vi.fn(),
  listWorkspaceOpenAppsMock: vi.fn(),
  openWorkspaceWithMock: vi.fn(),
}));

vi.mock("../app/storageApi", () => ({
  getWorkspaceOpenAppIcon: getWorkspaceOpenAppIconMock,
  listWorkspaceOpenApps: listWorkspaceOpenAppsMock,
  openWorkspaceWith: openWorkspaceWithMock,
}));

import OpenWorkspaceMenu from "./OpenWorkspaceMenu";

const APPS = [
  { id: "explorer", name: "文件资源管理器" },
  { id: "vscode", name: "VS Code" },
  { id: "intellij", name: "IntelliJ IDEA" },
  { id: "pycharm", name: "PyCharm" },
];

describe("OpenWorkspaceMenu", () => {
  beforeEach(() => {
    localStorage.clear();
    getWorkspaceOpenAppIconMock.mockReset();
    getWorkspaceOpenAppIconMock.mockResolvedValue(null);
    listWorkspaceOpenAppsMock.mockReset();
    listWorkspaceOpenAppsMock.mockResolvedValue(APPS);
    openWorkspaceWithMock.mockReset();
    openWorkspaceWithMock.mockResolvedValue(undefined);
  });

  it("主按钮使用系统应用目录的首项打开工作目录", async () => {
    render(
      <OpenWorkspaceMenu workspacePath="D:/Code/omni" onError={vi.fn()} />,
    );

    const button = await screen.findByRole("button", {
      name: "用 文件资源管理器 打开项目",
    });
    fireEvent.click(button);

    await waitFor(() =>
      expect(openWorkspaceWithMock).toHaveBeenCalledWith(
        "D:/Code/omni",
        "explorer",
      ),
    );
  });

  it("下拉菜单来自后端检测出的已安装应用", async () => {
    render(
      <OpenWorkspaceMenu workspacePath="D:/Code/omni" onError={vi.fn()} />,
    );

    const toggle = await screen.findByRole("button", {
      name: "选择打开方式",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "IntelliJ IDEA" }),
    );

    await waitFor(() =>
      expect(openWorkspaceWithMock).toHaveBeenCalledWith(
        "D:/Code/omni",
        "intellij",
      ),
    );
    expect(localStorage.getItem("omni.open-workspace.choice")).toBe(
      "intellij",
    );
  });

  it("主按钮跟随上次选择的应用", async () => {
    localStorage.setItem("omni.open-workspace.choice", "intellij");
    render(
      <OpenWorkspaceMenu workspacePath="D:/Code/omni" onError={vi.fn()} />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "用 IntelliJ IDEA 打开项目",
      }),
    );

    await waitFor(() =>
      expect(openWorkspaceWithMock).toHaveBeenCalledWith(
        "D:/Code/omni",
        "intellij",
      ),
    );
  });

  it("启动失败时把后端错误交给页面提示", async () => {
    const onError = vi.fn();
    openWorkspaceWithMock.mockRejectedValueOnce("未检测到 PyCharm");
    render(
      <OpenWorkspaceMenu workspacePath="D:/Code/omni" onError={onError} />,
    );

    const toggle = await screen.findByRole("button", {
      name: "选择打开方式",
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("menuitem", { name: "PyCharm" }));

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("未检测到 PyCharm"),
    );
  });
});
