import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CreateExpertDialog from "./CreateExpertDialog";
import { pluginRegistry } from "../plugins/registry";

function fillExpertForm(name = "周报专家") {
  fireEvent.change(screen.getByPlaceholderText("如：周报分析顾问"), { target: { value: name } });
  fireEvent.change(screen.getByPlaceholderText("说明专家解决什么问题、适用于什么场景"), { target: { value: "负责把工作信息整理为可执行的周报。" } });
  fireEvent.change(screen.getByPlaceholderText("用顿号或逗号分隔，例如：复盘、改进、团队协作"), { target: { value: "周报、复盘、项目管理" } });
  fireEvent.change(screen.getByPlaceholderText("这个专家是谁，擅长解决什么类型的问题？"), { target: { value: "你是一名结构化周报分析顾问。" } });
  fireEvent.change(screen.getByPlaceholderText("描述专家如何分析、判断和推进任务。"), { target: { value: "先收集事实，再按完成事项、风险和下一步行动整理信息。" } });
  fireEvent.change(screen.getByPlaceholderText("说明不能臆造什么、遇到信息不足如何处理。"), { target: { value: "不臆造未提供的数据；信息不足时列出待确认项。" } });
  fireEvent.change(screen.getByPlaceholderText("说明最终应该输出什么结果。"), { target: { value: "输出结构清晰、可核验的周报和行动项。" } });
  const exampleFields = screen.getAllByPlaceholderText("用户会怎样向这个专家提问？");
  fireEvent.change(exampleFields[0], { target: { value: "请根据这些进展整理本周周报，并列出风险和下一步。" } });
  fireEvent.change(exampleFields[1], { target: { value: "请帮我把这份工作记录转成可执行的周报。" } });
}

describe("CreateExpertDialog", () => {
  it("焦点位于关闭按钮时仍可用 Escape 关闭", () => {
    const onClose = vi.fn();
    render(<CreateExpertDialog open onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "关闭" }), { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("完整 DSH 专家定义必填；创建后注册为统一 expert 插件", () => {
    const onCreated = vi.fn();
    const before = pluginRegistry.list({ kind: "expert" }).length;

    render(<CreateExpertDialog open onClose={vi.fn()} onCreated={onCreated} />);

    // 未填写时创建按钮禁用
    const submit = screen.getByRole("button", { name: "创建专家" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fillExpertForm();
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);

    expect(onCreated).toHaveBeenCalledTimes(1);
    const created = onCreated.mock.calls[0][0];
    expect(created.kind).toBe("expert");
    expect(created.name).toBe("周报专家");
    expect(created.templatePrompt).toContain("## 角色定位");
    expect(created.expertProfile.role).toContain("结构化周报");
    expect(created.expertProfile.examples).toHaveLength(2);

    // 注册表可见且非内置（进入「我的专家」）—— 这一条同时覆盖了「不是内置专家」
    const experts = pluginRegistry.list({ kind: "expert" });
    expect(experts.length).toBe(before + 1);
    expect(experts.some((m) => m.id === created.id)).toBe(true);
    expect(pluginRegistry.isBuiltin(created.id)).toBe(false);
  });

  it("同名专家可重复创建：id 不撞车，后建的不会静默覆盖先建的", () => {
    pluginRegistry.load();
    const before = pluginRegistry.list({ kind: "expert" }).length;
    const onCreated = vi.fn();

    const createOnce = () => {
      const { unmount } = render(<CreateExpertDialog open onClose={vi.fn()} onCreated={onCreated} />);
      fillExpertForm();
      fireEvent.click(screen.getByRole("button", { name: "创建专家" }));
      unmount();
    };

    // 冻住时钟：两次创建必须落在同一毫秒 —— 这是 id 撞车的唯一触发条件。
    // 不冻的话两次 render+填表天然跨毫秒，断言会「因为错误的理由」通过。
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      createOnce();
      createOnce();
    } finally {
      nowSpy.mockRestore();
    }

    const [first, second] = onCreated.mock.calls.map((call) => call[0]);
    expect(first.name).toBe("周报专家");
    expect(second.name).toBe("周报专家");
    expect(second.id).not.toBe(first.id);

    // 关键：是两份档案，而不是后者把前者覆盖掉
    expect(pluginRegistry.list({ kind: "expert" }).length).toBe(before + 2);
    expect(pluginRegistry.getManifest(first.id)?.name).toBe("周报专家");
    expect(pluginRegistry.getManifest(second.id)?.name).toBe("周报专家");
  });

  it("选择工具与技能后写入 defaultToolIds/defaultSkillIds", () => {
    pluginRegistry.load();
    const onCreated = vi.fn();
    render(<CreateExpertDialog open onClose={vi.fn()} onCreated={onCreated} />);

    fillExpertForm("检索专家");

    // 点选两个工具 chip（按钮形态的 chip，取前两个）
    const toolChips = screen
      .getAllByRole("button")
      .filter((button) => button.className.includes("omni-dialog__plugin-chip"));
    expect(toolChips.length).toBeGreaterThan(2);
    fireEvent.click(toolChips[0]);
    fireEvent.click(toolChips[1]);

    fireEvent.click(screen.getByRole("button", { name: "创建专家" }));

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
      tags: ["测试"],
      expertProfile: {
        role: "原始角色",
        methodology: "原始方法",
        boundaries: "原始边界",
        deliverables: "原始交付物",
        examples: [
          { id: "example-1", title: "示例一", prompt: "原始示例一" },
          { id: "example-2", title: "示例二", prompt: "原始示例二" },
        ],
      },
    };
    pluginRegistry.install(original, { type: "local", path: "user" });
    const installedBefore = pluginRegistry.listInstalled().find((item) => item.id === original.id)?.entry;

    const onCreated = vi.fn();
    render(<CreateExpertDialog open editing={original} onClose={vi.fn()} onCreated={onCreated} />);

    // 预填断言
    expect((screen.getByPlaceholderText("如：周报分析顾问") as HTMLInputElement).value).toBe("可编辑专家");
    expect((screen.getByPlaceholderText("这个专家是谁，擅长解决什么类型的问题？") as HTMLTextAreaElement).value).toBe("原始角色");

    // 标题与按钮为编辑态
    expect(screen.getByText("编辑专家")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("这个专家是谁，擅长解决什么类型的问题？"), { target: { value: "修改后的角色" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(onCreated).toHaveBeenCalledTimes(1);
    const saved = onCreated.mock.calls[0][0];
    expect(saved.id).toBe("expert-editable-test");
    expect(saved.expertProfile.role).toBe("修改后的角色");

    const updated = pluginRegistry.getManifest("expert-editable-test");
    expect(updated?.expertProfile?.role).toBe("修改后的角色");
    const installedAfter = pluginRegistry.listInstalled().find((item) => item.id === original.id)?.entry;
    expect(installedAfter?.installedAt).toBe(installedBefore?.installedAt);
    expect(installedAfter?.enabled).toBe(true);
  });

  it("复制模式：从完整专家档案带入能力配置并创建独立档案", () => {
    const source = {
      id: "source-expert",
      name: "代码排查专家",
      description: "定位问题根因",
      version: "2.0.0",
      author: "Omni",
      kind: "expert" as const,
      category: "开发编程",
      templatePrompt: "你是代码排查专家。",
      instruction: "先复现，再定位。",
      defaultToolIds: ["read_file", "search_files"],
      defaultSkillIds: ["code-review"],
      defaultMcpConnectorIds: ["repo-search"],
      expertProfile: {
        role: "用于验证复制的专家角色。",
        methodology: "先确认事实再评估。",
        boundaries: "不臆造材料外事实。",
        deliverables: "问题清单与建议。",
        examples: [
          { id: "example-1", title: "评审", prompt: "请评审这份文档。" },
          { id: "example-2", title: "定位问题", prompt: "请指出这份文档中最需要修复的问题。" },
        ],
      },
      tags: ["代码", "排查"],
    };
    const onCreated = vi.fn();

    render(<CreateExpertDialog open copying={source} onClose={vi.fn()} onCreated={onCreated} />);

    expect(screen.getByText("复制专家")).toBeTruthy();
    expect((screen.getByPlaceholderText("如：周报分析顾问") as HTMLInputElement).value)
      .toBe("代码排查专家（自定义）");
    expect((screen.getByPlaceholderText("描述专家如何分析、判断和推进任务。") as HTMLTextAreaElement).value)
      .toBe("先确认事实再评估。");
    fireEvent.click(screen.getByRole("button", { name: "创建副本" }));

    const copy = onCreated.mock.calls[0][0];
    expect(copy.id).not.toBe(source.id);
    expect(copy.kind).toBe("expert");
    expect(copy.templatePrompt).toContain("## 角色定位");
    expect(copy.templatePrompt).toContain(source.expertProfile.role);
    expect(copy.defaultToolIds).toEqual(source.defaultToolIds);
    expect(copy.defaultSkillIds).toEqual(source.defaultSkillIds);
    expect(copy.defaultMcpConnectorIds).toEqual(source.defaultMcpConnectorIds);
    expect(copy.expertProfile).toEqual(source.expertProfile);
    expect(source.name).toBe("代码排查专家");
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

    fillExpertForm("数据专家");

    const chip = screen.getByText("测试 MCP 连接器").closest("button") as HTMLButtonElement;
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("button", { name: "创建专家" }));

    const created = onCreated.mock.calls[0][0];
    expect(created.defaultMcpConnectorIds).toEqual(["mcp-test-connector"]);
  });
});
