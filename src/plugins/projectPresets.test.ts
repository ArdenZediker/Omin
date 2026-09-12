import { afterEach, describe, expect, it } from "vitest";
import { pluginRegistry } from "./registry";
import { USER_PRESET_ID_PREFIX, saveProjectPreset, userPresetId } from "./projectPresets";

/**
 * 项目预设的**自建通道**（项目设置 →「另存为预设」）。
 *
 * 锁定四条口径：
 * 1. 存完立刻出现在预设列表里（新建项目对话框与扩展中心都读它），instruction 原样；
 * 2. **同名即覆盖**（「另存为」的语义），换名字才新增 —— 否则用户每调一次指令就多一条；
 * 3. 空指令直接拒绝，不留「套用后什么都没发生」的空预设；
 * 4. id 带 `user-preset-` 前缀且由名字决定 —— 前缀保证永不撞内置/市场的 id，
 *    名字决定则保证「同名覆盖」能找到上一条。
 */
describe("项目预设自建通道（另存为预设）", () => {
  const createdIds: string[] = [];

  const save = (name: string, instruction: string, description?: string) => {
    const result = saveProjectPreset({ name, instruction, description });
    if (result.ok) createdIds.push(result.manifest.id);
    return result;
  };

  afterEach(() => {
    while (createdIds.length > 0) {
      const id = createdIds.pop();
      if (id) pluginRegistry.uninstall(id);
    }
  });

  it("保存后立刻能在预设列表里找到，且 instruction 原样写入", () => {
    pluginRegistry.load();
    const before = pluginRegistry.listTemplates().length;
    const instruction = "本项目统一按周报口径输出：本周完成 / 风险 / 下周计划。";

    const result = save("周报口径", instruction, "每周五出周报");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.manifest.id.startsWith(USER_PRESET_ID_PREFIX)).toBe(true);
    // 自建的不能是内置：内置不可卸载，一旦误判就删不掉了
    expect(pluginRegistry.isBuiltin(result.manifest.id)).toBe(false);
    expect(pluginRegistry.isUserCreated(result.manifest.id)).toBe(true);

    const listed = pluginRegistry.listTemplates();
    expect(listed).toHaveLength(before + 1);
    const saved = listed.find((manifest) => manifest.id === result.manifest.id);
    expect(saved?.instruction).toBe(instruction);
    expect(saved?.name).toBe("周报口径");
    expect(saved?.description).toBe("每周五出周报");
    // 自建预设没有起手句 —— 「插入输入框」按钮以 starterPrompt 存在为前提，不造假数据
    expect(saved?.starterPrompt).toBeUndefined();
    // 也不写 defaultToolIds（内置工具无条件可用，写了是空操作）
    expect(saved?.defaultToolIds).toBeUndefined();
  });

  it("同名再存一次是覆盖而不是新增；换个名字才新增一条", () => {
    pluginRegistry.load();
    save("覆盖用例", "第一版指令");
    const afterFirst = pluginRegistry.listTemplates().length;

    const second = save("覆盖用例", "第二版指令");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(pluginRegistry.listTemplates()).toHaveLength(afterFirst);
    expect(pluginRegistry.getManifest(userPresetId("覆盖用例"))?.instruction).toBe("第二版指令");

    const third = save("覆盖用例-另存", "第三版指令");
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.created).toBe(true);
    expect(pluginRegistry.listTemplates()).toHaveLength(afterFirst + 1);
  });

  it("指令为空（或只有空白）时拒绝保存，注册表不留痕迹", () => {
    pluginRegistry.load();
    const before = pluginRegistry.listTemplates().length;

    const result = saveProjectPreset({ name: "空指令", instruction: "   \n  " });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("指令为空");
    expect(pluginRegistry.listTemplates()).toHaveLength(before);
    expect(pluginRegistry.isInstalled(userPresetId("空指令"))).toBe(false);
  });

  it("名称为空时拒绝保存（不能靠首尾空格蒙过去）", () => {
    pluginRegistry.load();
    const before = pluginRegistry.listTemplates().length;

    const result = saveProjectPreset({ name: "  ", instruction: "有内容但没名字" });

    expect(result.ok).toBe(false);
    expect(pluginRegistry.listTemplates()).toHaveLength(before);
  });

  it("id 由名字决定：首尾空格不影响，异名必然异 id（同名覆盖的基础）", () => {
    expect(userPresetId("  周报口径  ")).toBe(userPresetId("周报口径"));
    expect(userPresetId("周报口径")).not.toBe(userPresetId("周报"));
    expect(userPresetId("周报口径").startsWith(USER_PRESET_ID_PREFIX)).toBe(true);
  });
});
