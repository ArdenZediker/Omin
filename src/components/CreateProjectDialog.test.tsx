import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CreateProjectDialog from "./CreateProjectDialog";
import { pluginRegistry } from "../plugins/registry";

/**
 * 回归锁：项目预设的选项与「持久项目指令」必须来自**同一份**注册表，且写进去的
 * 必须是 `instruction`，不能是起手句 `starterPrompt`。
 *
 * 曾经下拉选项读 `config/manifests/projects.ts::RECOMMENDED_PROJECT_PRESETS`
 * （与内置预设同名、同描述的第二份硬编码副本），而正文却去
 * `pluginRegistry.listTemplates()` 取，并保留「取不到就退回 presets.description」
 * 的兜底 —— 两份定义靠手工同步，改一侧就静默失配。
 * 同一时期 `instruction` 与 `starterPrompt` 还挤在一个 `templatePrompt` 字段里，
 * 结果是**一次性用户问句**被当成**每轮生效的项目系统指令**写进项目。
 */
const instructionField = () =>
  screen.getByPlaceholderText(/提供当前项目的背景信息/) as HTMLTextAreaElement;

describe("CreateProjectDialog 项目预设", () => {
  it("下拉选项来自注册表，且选中后写入该预设自己的 instruction（不是起手句、不是描述）", () => {
    const templates = pluginRegistry.listTemplates();
    expect(templates.length).toBeGreaterThan(0);

    render(<CreateProjectDialog open onClose={vi.fn()} onCreate={vi.fn()} />);

    // 每个内置预设都应能在下拉里找到（选项名 = manifest.name）
    for (const template of templates) {
      expect(
        screen.getByRole("button", { name: template.name }),
      ).toBeTruthy();
    }

    const target = templates.find((m) => m.id === "code-debugger");
    expect(target).toBeTruthy();
    expect(target?.instruction?.trim()).toBeTruthy();
    expect(target?.starterPrompt?.trim()).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: target!.name }));

    expect(instructionField().value).toBe(target!.instruction);
    // 起手句与描述都不得混进来
    expect(instructionField().value).not.toBe(target!.starterPrompt);
    expect(instructionField().value).not.toBe(target!.description);

    // 「无预设」清空
    fireEvent.click(screen.getByRole("button", { name: "无预设" }));
    expect(instructionField().value).toBe("");
  });

  it("带 initialTemplateId 打开时，预设与指令已就绪（扩展中心「用它新建项目」的入口）", () => {
    const target = pluginRegistry
      .listTemplates()
      .find((m) => m.id === "command-helper");
    expect(target).toBeTruthy();

    render(
      <CreateProjectDialog
        open
        initialTemplateId="command-helper"
        onClose={vi.fn()}
        onCreate={vi.fn()}
      />,
    );

    expect(instructionField().value).toBe(target!.instruction);
  });

  it("不带 initialTemplateId 时不预选任何预设（指令为空）", () => {
    render(<CreateProjectDialog open onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(instructionField().value).toBe("");
  });
});
