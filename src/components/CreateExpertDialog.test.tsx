import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
