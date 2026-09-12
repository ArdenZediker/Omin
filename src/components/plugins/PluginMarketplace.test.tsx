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

/**
 * 回归：属于已安装专家团的子技能不能在「我的技能」里平铺。
 *
 * 用户要的是「按专家团一套展示，不散开」—— 子技能只在套件卡片内出现。
 * 但**不能顺手把子技能永久藏起来**：套件卸载后它们必须重新成为独立卡片，
 * 否则这些技能会在 UI 上凭空消失（磁盘上还在、斜杠命令也还能用）。
 */
describe("PluginMarketplace「我的技能」按专家团归组", () => {
  const renderMySkills = () =>
    render(
      <PluginMarketplace
        mainView
        embedded
        source="local"
        onSourceChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

  const installSuite = (suiteId: string, suiteName: string, slug: string) =>
    pluginRegistry.install(
      {
        id: suiteId,
        name: suiteName,
        description: "成套展示测试用专家团",
        version: "1.0.0",
        kind: "skill",
      },
      { type: "marketplace", repository: `skillset/${slug}` },
    );

  const installChild = (childId: string, childName: string, slug: string) =>
    pluginRegistry.install(
      {
        id: childId,
        name: childName,
        description: "成套展示测试用子技能",
        version: "1.0.0",
        kind: "skill",
      },
      {
        type: "marketplace",
        repository: `skillhub/${childId}`,
        skillsetSlug: slug,
      },
    );

  it("已装子技能收进套件卡片不平铺；套件卸载后重新出现", async () => {
    pluginRegistry.load();
    const suiteId = "test-skillset-parent";
    const suiteName = "归组测试专家团";
    const childId = "ns-group/child-skill";
    const childName = "归组测试子技能";

    act(() => {
      installSuite(suiteId, suiteName, "test-suite");
      installChild(childId, childName, "test-suite");
    });

    renderMySkills();

    // 套件本体渲染为套件卡片（带「套件」徽标）
    expect(await screen.findByText(suiteName)).toBeTruthy();
    expect(screen.getByText("套件")).toBeTruthy();
    // 子技能不在平铺列表里 —— 它只该出现在套件卡片的展开态
    expect(screen.queryByText(childName)).toBeNull();

    // 套件卸载后子技能必须回到平铺列表
    act(() => {
      pluginRegistry.uninstall(suiteId);
    });
    expect(await screen.findByText(childName)).toBeTruthy();

    act(() => {
      pluginRegistry.uninstall(childId);
    });
  });
});
