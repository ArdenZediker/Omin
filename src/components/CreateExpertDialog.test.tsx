import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CreateExpertDialog from "./CreateExpertDialog";
import { pluginRegistry } from "../plugins/registry";

describe("CreateExpertDialog", () => {
  it("名称与角色提示词必填；创建后注册为本地 expert 插件", () => {
    const onCreated = vi.fn();
    const before = pluginRegistry.list({ kind: "expert" }).length;

    render(<CreateExpertDialog open onClose={vi.fn()} onCreated={onCreated} />);

    // 未填写时创建按钮禁用
    const submit = screen.getByRole("button", { name: "创建" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("如：周报专家、代码评审专家"), {
      target: { value: "周报专家" },
    });
    fireEvent.change(screen.getByPlaceholderText(/专家的系统提示词/), {
      target: { value: "你负责收集本周进展并输出周报。" },
    });
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);

    expect(onCreated).toHaveBeenCalledTimes(1);
    const created = onCreated.mock.calls[0][0];
    expect(created.kind).toBe("expert");
    expect(created.name).toBe("周报专家");
    expect(created.templatePrompt).toContain("周报");
    expect(created.id).not.toBe("dev-expert");

    // 注册表可见且非内置（进入「我的专家」）
    const experts = pluginRegistry.list({ kind: "expert" });
    expect(experts.length).toBe(before + 1);
    expect(experts.some((m) => m.id === created.id)).toBe(true);
    expect(pluginRegistry.isBuiltin(created.id)).toBe(false);
  });

  it("选择工具与技能后写入 defaultToolIds/defaultSkillIds", () => {
    pluginRegistry.load();
    const onCreated = vi.fn();
    render(<CreateExpertDialog open onClose={vi.fn()} onCreated={onCreated} />);

    fireEvent.change(screen.getByPlaceholderText("如：周报专家、代码评审专家"), {
      target: { value: "检索专家" },
    });
    fireEvent.change(screen.getByPlaceholderText(/专家的系统提示词/), {
      target: { value: "你负责检索与汇总。" },
    });

    // 点选两个工具 chip（按钮形态的 chip，取前两个）
    const toolChips = screen
      .getAllByRole("button")
      .filter((button) => button.className.includes("omni-dialog__plugin-chip"));
    expect(toolChips.length).toBeGreaterThan(2);
    fireEvent.click(toolChips[0]);
    fireEvent.click(toolChips[1]);

    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    const created = onCreated.mock.calls[0][0];
    expect(created.defaultToolIds.length).toBe(2);
  });

  it("编辑模式：预填已有档案，保存走 updateManifest 且 id/启用状态不变", () => {
    pluginRegistry.load();
    const original = {
      id: "expert-editable-test",
      name: "可编辑专家",
      description: "原始描述",
      version: "1.0.0",
      author: "用户",
      kind: "expert" as const,
      templatePrompt: "原始提示词",
      defaultToolIds: ["read_file"],
      defaultSkillIds: [],
    };
    pluginRegistry.install(original, { type: "local", path: "user" });
    const installedBefore = pluginRegistry.listInstalled().find((item) => item.id === original.id)?.entry;

    const onCreated = vi.fn();
    render(<CreateExpertDialog open editing={original} onClose={vi.fn()} onCreated={onCreated} />);

    // 预填断言
    expect((screen.getByPlaceholderText("如：周报专家、代码评审专家") as HTMLInputElement).value).toBe("可编辑专家");
    expect((screen.getByPlaceholderText(/专家的系统提示词/) as HTMLTextAreaElement).value).toBe("原始提示词");

    // 标题与按钮为编辑态
    expect(screen.getByText("编辑专家")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/专家的系统提示词/), {
      target: { value: "修改后的提示词" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onCreated).toHaveBeenCalledTimes(1);
    const saved = onCreated.mock.calls[0][0];
    expect(saved.id).toBe("expert-editable-test");
    expect(saved.templatePrompt).toBe("修改后的提示词");

    const updated = pluginRegistry.getManifest("expert-editable-test");
    expect(updated?.templatePrompt).toBe("修改后的提示词");
    const installedAfter = pluginRegistry.listInstalled().find((item) => item.id === original.id)?.entry;
    expect(installedAfter?.installedAt).toBe(installedBefore?.installedAt);
    expect(installedAfter?.enabled).toBe(true);
  });

  it("绑定 MCP：只列出无 provider 的连接器，选中后写入 defaultMcpConnectorIds", () => {
    pluginRegistry.load();
    // 无 provider = MCP 连接器；有 provider 的是模型连接器（走「模型设置」），不该出现在这里
    pluginRegistry.install(
      {
        id: "mcp-test-connector",
        name: "测试 MCP 连接器",
        description: "仅用于测试的 MCP 连接器",
        version: "1.0.0",
        author: "测试",
        kind: "connector",
      },
      { type: "local", path: "user" }
    );
    pluginRegistry.install(
      {
        id: "model-test-connector",
        name: "测试模型连接器",
        description: "带 provider，属模型连接器",
        version: "1.0.0",
        author: "测试",
        kind: "connector",
        provider: "openai",
      },
      { type: "local", path: "user" }
    );

    const onCreated = vi.fn();
    render(<CreateExpertDialog open onClose={vi.fn()} onCreated={onCreated} />);

    // MCP 连接器进入候选，模型连接器被排除
    expect(screen.getByText("测试 MCP 连接器")).toBeTruthy();
    expect(screen.queryByText("测试模型连接器")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("如：周报专家、代码评审专家"), {
      target: { value: "数据专家" },
    });
    fireEvent.change(screen.getByPlaceholderText(/专家的系统提示词/), {
      target: { value: "你负责数据检索。" },
    });

    const chip = screen.getByText("测试 MCP 连接器").closest("button") as HTMLButtonElement;
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    const created = onCreated.mock.calls[0][0];
    expect(created.defaultMcpConnectorIds).toEqual(["mcp-test-connector"]);
  });
});
