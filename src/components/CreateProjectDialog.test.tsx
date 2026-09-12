import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CreateProjectDialog from "./CreateProjectDialog";
import { pluginRegistry } from "../plugins/registry";
import { saveProjectPreset, userPresetId } from "../plugins/projectPresets";

// 「确定」要求工作目录非空，而工作目录只能由系统目录选择器写入 —— 挡成一个固定路径，
// 测试才走得到 handleConfirm（此前本文件没有能真正提交表单的用例）。
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => "D:/tmp/omni-test-ws"),
}));

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
 *
 * 第二层回归锁：预设下拉必须能用。旧实现是自绘的 `:hover` 弹出层，
 * 触发器与菜单之间隔着 6px（`top: calc(100% + 6px)`），鼠标从触发器移向菜单时
 * 穿过死区，两边都不处于 :hover，菜单当场 `display:none` —— 用户报的
 * 「鼠标一脱焦，下拉框就消失」就是它。现在换成 `OmniSelect`（点击开合），
 * 菜单的存亡只由 React state 决定，与 hover 无关。
 */
const instructionField = () =>
  screen.getByPlaceholderText(/提供当前项目的背景信息/) as HTMLTextAreaElement;

const presetTrigger = () => screen.getByRole("button", { name: "选择项目预设" });

const openPresetMenu = () => {
  fireEvent.click(presetTrigger());
};

describe("CreateProjectDialog 项目预设", () => {
  it("下拉选项来自注册表，且选中后写入该预设自己的 instruction（不是起手句、不是描述）", () => {
    const templates = pluginRegistry.listTemplates();
    expect(templates.length).toBeGreaterThan(0);

    render(<CreateProjectDialog open onClose={vi.fn()} onCreate={vi.fn()} />);

    // 菜单是按需渲染的（OmniSelect 点开才有），所以先展开再断言选项
    openPresetMenu();

    // 每个内置预设都应能在下拉里找到（选项名 = manifest.name）
    for (const template of templates) {
      expect(screen.getByRole("option", { name: template.name })).toBeTruthy();
    }

    const target = templates.find((m) => m.id === "code-debugger");
    expect(target).toBeTruthy();
    expect(target?.instruction?.trim()).toBeTruthy();
    expect(target?.starterPrompt?.trim()).toBeTruthy();

    fireEvent.click(screen.getByRole("option", { name: target!.name }));

    expect(instructionField().value).toBe(target!.instruction);
    // 起手句与描述都不得混进来
    expect(instructionField().value).not.toBe(target!.starterPrompt);
    expect(instructionField().value).not.toBe(target!.description);

    // 「无预设」清空（选完菜单已收起，重新展开）
    openPresetMenu();
    fireEvent.click(screen.getByRole("option", { name: "无预设" }));
    expect(instructionField().value).toBe("");
  });

  it("预设下拉点击开合：未点开不渲染菜单，点开后把指针移到选项上也不消失", () => {
    render(<CreateProjectDialog open onClose={vi.fn()} onCreate={vi.fn()} />);

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(presetTrigger().getAttribute("aria-expanded")).toBe("false");

    openPresetMenu();

    expect(presetTrigger().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("listbox")).toBeTruthy();

    // 关键回归点：菜单的存亡只由 state 决定。触发器和菜单在 DOM 上根本不相邻
    // （菜单 portal 到 body），任何「靠祖先 :hover 撑住」的写法在这里都会立刻消失。
    fireEvent.mouseOver(screen.getByRole("option", { name: "无预设" }));
    fireEvent.mouseOut(presetTrigger());
    expect(screen.getByRole("listbox")).toBeTruthy();
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
    // 预选值也要反映在下拉触发器上，不能只有正文变了而触发器还写着「无预设」
    expect(presetTrigger().textContent).toContain(target!.name);
  });

  it("不带 initialTemplateId 时不预选任何预设（指令为空）", () => {
    render(<CreateProjectDialog open onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(instructionField().value).toBe("");
  });

  /**
   * 闭环：项目设置里「另存为预设」存下的东西，必须能在**新建项目**的下拉里选到。
   *
   * 两件事一起锁：①两个对话框读的是同一份注册表（都走 `listTemplates()`）；
   * ②预设是在**组件之外**写入的（另一个对话框），所以这里刻意先 render 再 save ——
   * 靠的正是注册表的订阅广播，而不是「本组件自己触发的刷新」。
   */
  describe("与「另存为预设」的闭环", () => {
    const createdIds: string[] = [];

    afterEach(async () => {
      // 清理必须包在 act 里：本 hook 比 RTL 的自动 cleanup **先**执行，此刻对话框
      // 还挂着 `useSyncExternalStore` 的订阅；`uninstall` → `registry.save()` 会同步
      // 广播，订阅者当场 setState 就会落在 act 之外 → React 报
      // 「update not wrapped in act」。这也是「只有存过预设的用例才报警」的原因。
      await act(async () => {
        while (createdIds.length > 0) {
          const id = createdIds.pop();
          if (id) pluginRegistry.uninstall(id);
        }
      });
    });

    it("外部存入的预设实时出现在下拉里，选中后写进指令", () => {
      pluginRegistry.load();
      const instruction = "自建预设口径：只输出结论，不写过程。";

      render(<CreateProjectDialog open onClose={vi.fn()} onCreate={vi.fn()} />);
      openPresetMenu();
      expect(screen.queryByRole("option", { name: "自建预设-闭环" })).toBeNull();

      act(() => {
        saveProjectPreset({ name: "自建预设-闭环", instruction });
      });
      createdIds.push(userPresetId("自建预设-闭环"));

      fireEvent.click(screen.getByRole("option", { name: "自建预设-闭环" }));
      expect(instructionField().value).toBe(instruction);
    });
  });
});

/**
 * 项目级连接器白名单。
 *
 * 锁三件事：
 * 1. 候选集**只列 MCP 连接器**（无 `provider`）—— 模型连接器在「模型设置」里配，
 *    不暴露 `mcp__*` 工具，勾进来只会写下一个永不生效的 id（这正是这一行过去的问题）；
 * 2. 勾选写进 `allowedConnectorIds`，**不是** `allowedToolIds` —— MCP 工具名是运行时
 *    算出的 `mcp__{连接器id}__{工具}`，不在工具 manifest 表里，写进工具白名单必然空转；
 * 3. **不勾 = 不限制**，落库写 `undefined` 而不是 `[]`，让「未设置」只有一种表示。
 */
describe("CreateProjectDialog 连接器白名单", () => {
  const installedIds: string[] = [];

  afterEach(async () => {
    await act(async () => {
      while (installedIds.length > 0) {
        const id = installedIds.pop();
        if (id) pluginRegistry.uninstall(id);
      }
    });
  });

  const installConnector = (id: string, name: string, provider?: string) => {
    pluginRegistry.install(
      { id, name, description: "测试用连接器", version: "1.0.0", author: "测试", kind: "connector", provider },
      { type: "local", path: "user" },
    );
    installedIds.push(id);
  };

  /** 填满必填项（名称 + 工作目录）让「确定」可点。 */
  const fillRequiredFields = async () => {
    fireEvent.change(screen.getByPlaceholderText("请输入项目名称"), { target: { value: "连接器项目" } });
    fireEvent.click(screen.getByRole("button", { name: "选择目录" }));
    await screen.findByDisplayValue("D:/tmp/omni-test-ws");
  };

  it("只列 MCP 连接器（排除模型连接器），勾选后写进 allowedConnectorIds", async () => {
    const onCreate = vi.fn();
    pluginRegistry.load();
    installConnector("mcp-create-a", "新建页 MCP A");
    installConnector("model-create-x", "新建页模型连接器", "openai");

    render(<CreateProjectDialog open onClose={vi.fn()} onCreate={onCreate} />);

    expect(screen.getByText("新建页 MCP A")).toBeTruthy();
    expect(screen.queryByText("新建页模型连接器")).toBeNull();

    fireEvent.click(screen.getByText("新建页 MCP A").closest("button") as HTMLButtonElement);
    await fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    const draft = onCreate.mock.calls[0][0];
    expect(draft.allowedConnectorIds).toEqual(["mcp-create-a"]);
    // 绝不能写进工具白名单：那条路对 MCP 工具是空转的（见本 describe 顶部注释）
    expect(draft.allowedToolIds).toBeUndefined();
  });

  it("一个连接器都不勾时写 undefined（= 不限制，而不是「一个都不用」）", async () => {
    const onCreate = vi.fn();
    pluginRegistry.load();
    installConnector("mcp-create-b", "新建页 MCP B");

    render(<CreateProjectDialog open onClose={vi.fn()} onCreate={onCreate} />);
    await fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: "确定" }));

    expect(onCreate.mock.calls[0][0].allowedConnectorIds).toBeUndefined();
  });
});

/**
 * 专家行说明文案。
 *
 * 两个对话框的「绑定专家」行文案有**必须逐字一致**的硬约束（历史上出现过新建页只说
 * 「专家（可选）」、编辑页才说「委派白名单」，同一个 `boundExpertIds` 两套说法）。
 * 这里与 `ProjectSettingsDialog.test.tsx` 钉的是同一个字面量 —— 只改一处必红一处。
 */
describe("CreateProjectDialog 专家行说明", () => {
  it("文案与 ProjectSettingsDialog 逐字一致，且写明「空 = 谁都不派」", () => {
    render(<CreateProjectDialog open onClose={vi.fn()} onCreate={vi.fn()} />);

    const hint =
      "agent 委派白名单：只派给这些专家；留空 = 模型不自动委派任何专家（手动 @专家 不受限）";
    expect(screen.getByText(`（${hint}）`)).toBeTruthy();
  });
});
