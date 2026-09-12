import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PluginMarketplace from "./PluginMarketplace";
import { pluginRegistry } from "../../plugins/registry";

// ensureMcpConnector 的真实实现会 invoke Tauri 命令；这里只关心「连接中」这段 UI，
// 用手动 resolve 的 promise 把连接悬停在飞行中，才能断言中间态。
const mcpMocks = vi.hoisted(() => ({ ensureMcpConnector: vi.fn() }));

vi.mock("../../plugins/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/mcp")>();
  return { ...actual, ensureMcpConnector: mcpMocks.ensureMcpConnector };
});

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

/**
 * 「连接」按钮必须有中间态。
 *
 * MCP 拉起要 spawn 子进程或走完整 HTTP 握手（initialize + tools/list），
 * 慢的时候数秒没有任何反馈，用户会以为按钮没点上而反复点 —— 按钮必须锁住
 * 并显示「连接中…」。这条用例把连接悬停在飞行中，断言按钮确实被锁住。
 */
describe("PluginMarketplace MCP 连接中间态", () => {
  it("点击连接后按钮显示「连接中…」并禁用，完成后恢复", async () => {
    pluginRegistry.load();
    const id = "test-mcp-connecting";
    act(() => {
      pluginRegistry.install(
        {
          id,
          name: "连接中间态测试连接器",
          description: "用于验证连接中间态的测试连接器",
          version: "1.0.0",
          kind: "connector",
        },
        { type: "local", path: "user" },
      );
      pluginRegistry.setConnectorConfig(id, {
        url: "https://example.invalid/mcp",
        trusted: true,
      });
    });

    let release: () => void = () => {};
    mcpMocks.ensureMcpConnector.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
    );

    render(
      <PluginMarketplace
        mainView
        embedded
        source="my"
        initialFilter={{ kind: "connector" }}
        onSourceChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const button = (await screen.findByText("连接")).closest("button");
    expect(button).toBeTruthy();

    fireEvent.click(button!);

    await waitFor(() => expect(screen.getByText("连接中…")).toBeTruthy());
    expect(button!.disabled).toBe(true);
    // 飞行中不能被重复触发
    expect(mcpMocks.ensureMcpConnector).toHaveBeenCalledTimes(1);

    act(() => release());

    await waitFor(() => expect(screen.getByText("连接")).toBeTruthy());
    expect(button!.disabled).toBe(false);

    act(() => {
      pluginRegistry.uninstall(id);
    });
  });
});

/**
 * 回归：连接器卡片必须带 `plugin-card--connector` 修饰类。
 *
 * 该类在 plugins.css 里承载「连接器卡片的紧凑布局」：不参与描述区 3 行预留
 * （卡片底部不再空一大片）、底部按钮按内容宽度右对齐（不再 flex:1 等分拉满
 * 整行）、内边距 12px。少了它，连接器卡片会静默退回 8b29f15 的统一高度预留，
 * 而这正是用户 2026-09-12「卡片大小排版调整」要修掉的表现。
 * 技能卡片必须**不带**这个类 —— 它们仍需要预留行来保证同行等高。
 */
describe("PluginMarketplace 连接器卡片紧凑布局", () => {
  it("连接器卡片带 plugin-card--connector，技能卡片不带", async () => {
    pluginRegistry.load();
    const connectorId = "test-compact-connector";
    const skillId = "test-compact-skill";
    act(() => {
      pluginRegistry.install(
        {
          id: connectorId,
          name: "紧凑布局测试连接器",
          description: "位置信息",
          version: "1.0.0",
          kind: "connector",
        },
        { type: "local", path: "user" },
      );
      pluginRegistry.install(
        {
          id: skillId,
          name: "紧凑布局测试技能",
          description: "审阅改动",
          version: "1.0.0",
          kind: "skill",
          systemPrompt: "echo compact-layout",
        },
        { type: "local", path: "user" },
      );
    });

    const connectorView = render(
      <PluginMarketplace
        mainView
        embedded
        source="my"
        initialFilter={{ kind: "connector" }}
        onSourceChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const connectorCard = (await screen.findByText("紧凑布局测试连接器")).closest(
      ".plugin-card",
    );
    expect(connectorCard?.className ?? "").toContain("plugin-card--connector");
    connectorView.unmount();

    render(
      <PluginMarketplace
        mainView
        embedded
        source="local"
        initialFilter={{ kind: "skill" }}
        onSourceChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const skillCard = (await screen.findByText("紧凑布局测试技能")).closest(
      ".plugin-card",
    );
    expect(skillCard?.className ?? "").not.toContain("plugin-card--connector");

    act(() => {
      pluginRegistry.uninstall(connectorId);
      pluginRegistry.uninstall(skillId);
    });
  });
});
