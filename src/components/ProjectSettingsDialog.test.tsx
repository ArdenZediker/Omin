import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectSettingsDialog from "./ProjectSettingsDialog";
import { PromptDialogProvider } from "./PromptDialog";
import { pluginRegistry } from "../plugins/registry";
import { userPresetId } from "../plugins/projectPresets";
import type { Project } from "../chat/types";

/**
 * 项目设置（改）与新建项目（建）是同一件事的两个入口，字段口径必须对齐。
 *
 * 锁四件事：
 * 1. 「另存为预设」：指令为空时禁用；存的是 **textarea 里当前编辑的内容**（不要求先保存项目）；
 * 2. **技能白名单可增可删**，且是**全量**而非「本次新挑的」—— 打开设置直接点保存
 *    绝不能把新建时勾的技能整批抹掉（这是本次对齐最容易踩的坑）；
 * 3. 「选择预设」是**覆盖式套用**（有常驻提示），与新建项目对话框一致；
 * 4. 专家行的文案与新建那边逐字一致（同一个 `boundExpertIds`：委派白名单）。
 *
 * 2026-09-13 追加两条锁（连接器/专家/技能三行统一为 `PluginToggleRow` 平铺开关）：
 * 5. 「添加 → 扩展中心挑选」弹层已删除 —— 它只列本地已有项、装不了任何东西，纯重复；
 * 6. 技能候选**只列内置技能**：`allowedSkillIds` 管不到用户自装技能（那些走
 *    `listEnabledUserSkills()` 绕过白名单），列出来勾了也是永不生效的 id。
 */
const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: "project-settings-test",
  kind: "custom",
  title: "周报项目",
  description: "",
  workspacePath: "",
  systemPrompt: "",
  allowedToolIds: [],
  allowedSkillIds: [],
  memoryScope: "session",
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

const renderDialog = (overrides: Partial<Project> = {}) => {
  const onUpdate = vi.fn();
  render(
    <PromptDialogProvider>
      <ProjectSettingsDialog
        open
        project={makeProject(overrides)}
        onClose={vi.fn()}
        onUpdate={onUpdate}
      />
    </PromptDialogProvider>,
  );
  return { onUpdate };
};

const instructionField = () => screen.getByLabelText("指令") as HTMLTextAreaElement;
const saveButton = () => screen.getByRole("button", { name: /另存为预设/ });
const saveSubmit = () => screen.getByRole("button", { name: "保存" });

/** 按行标题定位插件行（三行的 chips 形态相同，只能先定位行）。 */
const pluginRow = (label: string) => {
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".omni-dialog__plugin-row"));
  const row = rows.find((candidate) => candidate.textContent?.includes(label));
  if (!row) throw new Error(`找不到「${label}」这一行`);
  return row;
};

/** 「技能」行里某个技能 chip —— 它是按钮形态的开关，点一下即切换勾选。 */
const skillChip = (name: string) =>
  within(pluginRow("技能")).getByText(name).closest("button") as HTMLButtonElement;

describe("ProjectSettingsDialog「另存为预设」", () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    // 必须包 act：本 hook 早于 RTL 自动 cleanup 执行，此刻对话框仍挂着注册表订阅，
    // `uninstall` 的同步广播会让订阅者当场 setState —— 落在 act 外即触发
    // 「update not wrapped in act」。
    await act(async () => {
      while (createdIds.length > 0) {
        const id = createdIds.pop();
        if (id) pluginRegistry.uninstall(id);
      }
    });
  });

  it("指令为空时按钮禁用", () => {
    renderDialog({ systemPrompt: "" });

    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("存的是 textarea 里当前编辑的内容（不要求先保存项目），并落进注册表", async () => {
    pluginRegistry.load();
    const edited = "刚改过的新指令：只输出结论，不写过程。";

    renderDialog({ systemPrompt: "项目里原来存的旧指令" });

    // 用户在这个对话框里改了指令，但还没点「保存」——「另存为」要存的是眼前这一份
    fireEvent.change(instructionField(), { target: { value: edited } });
    fireEvent.click(saveButton());

    const nameInput = await screen.findByLabelText("预设名称");
    // 名称默认取项目名，避免用户从零开始打字
    expect((nameInput as HTMLInputElement).value).toBe("周报项目");
    fireEvent.change(nameInput, { target: { value: "周报口径" } });
    fireEvent.change(screen.getByLabelText(/一句话说明/), {
      target: { value: "每周五出周报" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存预设" }));

    createdIds.push(userPresetId("周报口径"));

    await waitFor(() => {
      expect(pluginRegistry.getManifest(userPresetId("周报口径"))?.instruction).toBe(edited);
    });
    expect(pluginRegistry.isUserCreated(userPresetId("周报口径"))).toBe(true);
    // 反馈必须告诉用户去哪儿找，否则「存了但找不到」等于没存
    expect(await screen.findByText(/新建项目时可在「选择预设」里找到/)).toBeTruthy();
  });

  it("同名再存一次提示「已覆盖」，不产生第二条", async () => {
    pluginRegistry.load();

    renderDialog({ systemPrompt: "同名覆盖用例指令。" });
    createdIds.push(userPresetId("同名用例"));

    for (const expected of [/新建项目时可在「选择预设」里找到/, /已覆盖同名预设/]) {
      fireEvent.click(saveButton());
      const nameInput = await screen.findByLabelText("预设名称");
      fireEvent.change(nameInput, { target: { value: "同名用例" } });
      fireEvent.click(screen.getByRole("button", { name: "保存预设" }));
      expect(await screen.findByText(expected)).toBeTruthy();
    }

    expect(pluginRegistry.listTemplates().filter((m) => m.name === "同名用例")).toHaveLength(1);
  });

  it("取消名称输入时不写注册表", async () => {
    pluginRegistry.load();
    const before = pluginRegistry.listTemplates().length;

    renderDialog({ systemPrompt: "这段指令不应该被存下来。" });
    fireEvent.click(saveButton());
    await screen.findByLabelText("预设名称");
    // 必须限定在提示弹窗内取「取消」：项目设置自己的 footer 里也有一个「取消」
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "另存为项目预设" })).getByRole("button", {
        name: "取消",
      }),
    );

    await waitFor(() => {
      expect(screen.queryByLabelText("预设名称")).toBeNull();
    });
    expect(pluginRegistry.listTemplates()).toHaveLength(before);
  });
});

describe("ProjectSettingsDialog 能力集与预设选择", () => {
  const installedSkillIds: string[] = [];

  afterEach(async () => {
    await act(async () => {
      while (installedSkillIds.length > 0) {
        const id = installedSkillIds.pop();
        if (id) pluginRegistry.uninstall(id);
      }
    });
  });

  it("技能行渲染的是**当前白名单**：直接保存不会把它抹掉", () => {
    pluginRegistry.load();
    const existing = ["plan", "code-review"];
    const { onUpdate } = renderDialog({ allowedSkillIds: existing });

    // chips 与白名单一一对应
    for (const id of existing) {
      const name = pluginRegistry.getManifest(id)?.name ?? id;
      expect(within(pluginRow("技能")).getByText(name)).toBeTruthy();
    }

    fireEvent.click(saveSubmit());

    expect(onUpdate).toHaveBeenCalledTimes(1);
    // 最容易踩的坑：把 chips 当成「本次新挑的那几个」，保存一次就把已有白名单清空
    expect(onUpdate.mock.calls[0][1].allowedSkillIds).toEqual(existing);
  });

  it("取消勾选一个技能后保存，白名单里就没它了", () => {
    pluginRegistry.load();
    const { onUpdate } = renderDialog({ allowedSkillIds: ["plan", "code-review"] });
    const planName = pluginRegistry.getManifest("plan")?.name ?? "plan";

    // chips 现在是开关：点一下 = 取消勾选（不再有单独的「移除 X」按钮，
    // 也不再需要开扩展中心弹层）
    fireEvent.click(skillChip(planName));
    fireEvent.click(saveSubmit());

    expect(onUpdate.mock.calls[0][1].allowedSkillIds).toEqual(["code-review"]);
  });

  it("勾选一个内置技能后保存，追加进白名单", () => {
    pluginRegistry.load();
    const { onUpdate } = renderDialog({ allowedSkillIds: [] });

    const builtin = pluginRegistry
      .list({ kind: "skill" })
      .find((manifest) => pluginRegistry.isBuiltin(manifest.id));
    expect(builtin).toBeTruthy();

    fireEvent.click(skillChip(builtin!.name));
    fireEvent.click(saveSubmit());

    expect(onUpdate.mock.calls[0][1].allowedSkillIds).toEqual([builtin!.id]);
    // 选中态要留在界面上（渲染的是白名单全量，不是「本次新挑的」）
    expect(within(pluginRow("技能")).getByText(builtin!.name)).toBeTruthy();
  });

  it("技能候选只列**内置**技能：自装技能绕过白名单，列出来勾了也不生效", () => {
    pluginRegistry.load();
    pluginRegistry.install(
      {
        id: "user-skill-candidate",
        name: "自装技能候选",
        description: "用户自己装的技能",
        version: "1.0.0",
        kind: "skill",
      },
      { type: "local", path: "user" },
    );
    installedSkillIds.push("user-skill-candidate");

    renderDialog();
    expect(within(pluginRow("技能")).queryByText("自装技能候选")).toBeNull();
  });

  it("「选择预设」是覆盖式套用，并给出提示", async () => {
    pluginRegistry.load();
    const target = pluginRegistry.listTemplates().find((m) => m.id === "code-debugger");
    expect(target?.instruction).toBeTruthy();

    renderDialog({ systemPrompt: "原来自己写的指令" });

    fireEvent.click(screen.getByRole("button", { name: "选择项目预设" }));
    fireEvent.click(screen.getByRole("option", { name: target!.name }));

    expect(instructionField().value).toBe(target!.instruction);
    expect(await screen.findByText(new RegExp(`已套用预设「${target!.name}」`))).toBeTruthy();
    // 覆盖是有代价的动作，常驻提示必须一直在（不能只靠一次性 notice）
    expect(screen.getByText(/套用预设会覆盖/)).toBeTruthy();
  });

  it("专家行与新建项目对话框口径一致：明说这是委派白名单，并写明「空 = 谁都不派」", () => {
    renderDialog();

    const row = within(pluginRow("绑定专家"));
    // 逐字钉住整句：两个对话框有「文案必须逐字一致」的硬约束，CreateProjectDialog.test.tsx
    // 钉的是同一个字面量 —— 只改一处必红一处。
    const hint =
      "agent 委派白名单：只派给这些专家；留空 = 模型不自动委派任何专家（手动 @专家 不受限）";
    expect(row.getByText(`（${hint}）`)).toBeTruthy();
    // 不能退回「留空则不限制」：实现里空列表 ⇒ isExpertBound 全 false ⇒ 名册为空
    // （buildExpertAgentHint 直接写 "EXPERTS: none available right now"）。
    // 两者相反，文案写反过一次，加负向断言防复发。
    expect(row.queryByText(/留空则不限制/)).toBeNull();
  });
});

/**
 * 项目级连接器白名单。
 *
 * 锁四件事：
 * 1. 候选集**只列 MCP 连接器**（无 `provider`）—— 模型连接器在「模型设置」里配，
 *    不暴露 `mcp__*` 工具，勾进来只会写下一个永不生效的 id；
 * 2. 渲染的是**当前白名单全量**（不是本次新挑的增量）—— 直接点保存不得抹掉已有选择；
 * 3. 只有勾了才收窄；清空要写 `undefined` 而不是 `[]`（`{...project, ...patch}` 下
 *    `[]` 会落成空数组，「未设置」就有两种表示）；
 * 4. 与 `Project.allowedConnectorIds` 的语义一致：**空 / 缺省 = 不限制**。
 */
describe("ProjectSettingsDialog 连接器白名单", () => {
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

  const connectorChip = (name: string) =>
    within(pluginRow("连接器")).getByText(name).closest("button") as HTMLButtonElement;

  it("只列 MCP 连接器，且渲染当前白名单的选中态", () => {
    pluginRegistry.load();
    installConnector("mcp-settings-a", "设置页 MCP A");
    installConnector("mcp-settings-b", "设置页 MCP B");
    installConnector("model-settings-x", "设置页模型连接器", "openai");

    renderDialog({ allowedConnectorIds: ["mcp-settings-a"] });

    expect(connectorChip("设置页 MCP A")).toBeTruthy();
    expect(connectorChip("设置页 MCP B")).toBeTruthy();
    expect(within(pluginRow("连接器")).queryByText("设置页模型连接器")).toBeNull();

    expect(connectorChip("设置页 MCP A").className).toContain("omni-dialog__plugin-chip--active");
    expect(connectorChip("设置页 MCP B").className).not.toContain("omni-dialog__plugin-chip--active");
  });

  it("直接保存不会抹掉已有白名单（渲染全量、不是增量）", () => {
    pluginRegistry.load();
    installConnector("mcp-settings-c", "设置页 MCP C");
    const { onUpdate } = renderDialog({ allowedConnectorIds: ["mcp-settings-c"] });

    fireEvent.click(saveSubmit());

    expect(onUpdate.mock.calls[0][1].allowedConnectorIds).toEqual(["mcp-settings-c"]);
  });

  it("勾选一个新连接器后保存，写进白名单", () => {
    pluginRegistry.load();
    installConnector("mcp-settings-e", "设置页 MCP E");
    const { onUpdate } = renderDialog({ allowedConnectorIds: [] });

    fireEvent.click(connectorChip("设置页 MCP E"));
    fireEvent.click(saveSubmit());

    expect(onUpdate.mock.calls[0][1].allowedConnectorIds).toEqual(["mcp-settings-e"]);
  });

  it("取消最后一个勾选后保存，写 undefined（= 清掉限制，回到「不限」）", () => {
    pluginRegistry.load();
    installConnector("mcp-settings-d", "设置页 MCP D");
    const { onUpdate } = renderDialog({ allowedConnectorIds: ["mcp-settings-d"] });

    fireEvent.click(connectorChip("设置页 MCP D"));
    fireEvent.click(saveSubmit());

    // 省略这个字段是不够的：`updateProjectProfile` 是 `{...project, ...patch}`，
    // 键不在 patch 里就会保留旧白名单，等于「取消了却依然被限制」。
    expect(onUpdate.mock.calls[0][1].allowedConnectorIds).toBeUndefined();
  });
});
