import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PluginMarketplace from "./PluginMarketplace";
import { pluginRegistry } from "../../plugins/registry";

/**
 * 回归：「我的技能」列表必须随注册表变更实时刷新。
 *
 * 原缺陷：列表来自 `useMemo([kind, query, refreshKey])`，而 `refreshKey` 只在本组件的
 * 处理函数里自增。安装如果发生在别处（SkillHub 子面板、远程技能、技能创作、对话里
 * 模型调用 /install_skill），组件收不到任何回调 —— 且切换 tab 也不会重算
 * （source 不在 memo 依赖里），表现为「已安装但列表里看不见」。
 */
describe("PluginMarketplace「我的技能」实时刷新", () => {
  it("外部安装技能后，列表无需切 tab 就出现该技能", async () => {
    pluginRegistry.load();
    const id = "test-live-refresh-skill";
    const name = "实时刷新测试技能";

    render(
      <PluginMarketplace
        mainView
        embedded
        source="local"
        onSourceChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByText(name)).toBeNull();

    act(() => {
      pluginRegistry.install(
        {
          id,
          name,
          description: "用于验证「我的技能」实时刷新的测试技能",
          version: "1.0.0",
          kind: "skill",
          systemPrompt: "echo live-refresh",
        },
        { type: "local", path: "user" },
      );
    });

    expect(await screen.findByText(name)).toBeTruthy();

    act(() => {
      pluginRegistry.uninstall(id);
    });
    expect(screen.queryByText(name)).toBeNull();
  });
});
