import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CreateProjectDialog from "./CreateProjectDialog";
import { pluginRegistry } from "../plugins/registry";

/**
 * 回归锁：模板选项与指令正文必须来自**同一份**注册表。
 *
 * 曾经下拉选项读 `config/manifests/projects.ts::RECOMMENDED_PROJECT_PRESETS`
 * （与内置模板同名、同描述的第二份硬编码副本），而正文却去
 * `pluginRegistry.listTemplates()` 取，并保留「取不到就退回 presets.description」
 * 的兜底 —— 两份定义靠手工同步，改一侧就静默失配：下拉还列着这一项，
 * 点下去指令变成一句描述而不是提示词。
 */
describe("CreateProjectDialog 模板选项", () => {
  it("下拉选项来自注册表，且选中后写入该模板自己的 templatePrompt", () => {
    const templates = pluginRegistry.listTemplates();
    expect(templates.length).toBeGreaterThan(0);

    render(<CreateProjectDialog open onClose={vi.fn()} onCreate={vi.fn()} />);

    const instruction = screen.getByPlaceholderText(
      /提供当前项目的背景信息/,
    ) as HTMLTextAreaElement;

    // 每个内置模板都应能在下拉里找到（选项名 = manifest.name）
    for (const template of templates) {
      expect(screen.getByRole("button", { name: template.name })).toBeTruthy();
    }

    const target = templates.find((m) => m.id === "code-debugger");
    expect(target).toBeTruthy();
    expect(target?.templatePrompt?.trim()).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: target!.name }));

    // 关键断言：写入的是模板正文，而不是任何「描述」
    expect(instruction.value).toBe(target!.templatePrompt);
    expect(instruction.value).not.toBe(target!.description);

    // 「无模板」清空
    fireEvent.click(screen.getByRole("button", { name: "无模板" }));
    expect(instruction.value).toBe("");
  });
});
