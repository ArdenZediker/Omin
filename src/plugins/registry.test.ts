import { describe, expect, it, vi } from "vitest";
import { pluginRegistry } from "./registry";
import type { PluginManifest } from "./types";

/**
 * 注册表变更订阅（2026-09-12）。
 *
 * 锁定的是一条「UI 与注册表同步」的红线：插件是渲染进程模块级单例，UI 只能靠
 * 订阅感知变更。一旦订阅漏发，就会出现「装好了但「我的技能」里看不见」
 * ——安装动作成功、列表却停在旧快照上。
 */
const makeSkill = (id: string, name = id): PluginManifest => ({
  id,
  name,
  description: "订阅测试用技能",
  version: "1.0.0",
  kind: "skill",
  systemPrompt: "echo hello",
});

describe("pluginRegistry 变更订阅", () => {
  it("install 触发订阅者并把版本号推进", () => {
    pluginRegistry.load();
    const id = "test-subscribe-skill";
    const listener = vi.fn();
    const unsubscribe = pluginRegistry.subscribe(listener);
    const before = pluginRegistry.getVersion();

    pluginRegistry.install(makeSkill(id), { type: "local", path: "user" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(pluginRegistry.getVersion()).toBeGreaterThan(before);
    expect(pluginRegistry.getManifest(id)?.name).toBe(id);

    unsubscribe();
    pluginRegistry.uninstall(id);
  });

  it("开关 / 更新 manifest / 卸载都会广播", () => {
    pluginRegistry.load();
    const id = "test-subscribe-mutations";
    pluginRegistry.install(makeSkill(id), { type: "local", path: "user" });

    const listener = vi.fn();
    const unsubscribe = pluginRegistry.subscribe(listener);

    pluginRegistry.setEnabled(id, false);
    pluginRegistry.updateManifest(makeSkill(id, "改名后"));
    pluginRegistry.uninstall(id);

    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("取消订阅后不再收到通知", () => {
    pluginRegistry.load();
    const id = "test-subscribe-cancel";
    const listener = vi.fn();
    const unsubscribe = pluginRegistry.subscribe(listener);
    unsubscribe();

    pluginRegistry.install(makeSkill(id), { type: "local", path: "user" });
    expect(listener).not.toHaveBeenCalled();

    pluginRegistry.uninstall(id);
  });

  it("订阅者自身抛错不影响安装结果，也不影响其它订阅者", () => {
    pluginRegistry.load();
    const id = "test-subscribe-throw";
    const healthy = vi.fn();
    const unsubscribeBad = pluginRegistry.subscribe(() => {
      throw new Error("订阅者炸了");
    });
    const unsubscribeGood = pluginRegistry.subscribe(healthy);

    expect(() => pluginRegistry.install(makeSkill(id), { type: "local", path: "user" })).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    expect(pluginRegistry.getManifest(id)).toBeTruthy();

    unsubscribeBad();
    unsubscribeGood();
    pluginRegistry.uninstall(id);
  });

  it("未获信任连接器的配置写入同样广播（信任状态影响工具暴露）", () => {
    pluginRegistry.load();
    const id = "test-subscribe-connector";
    pluginRegistry.install(
      { id, name: id, description: "连接器", version: "1.0.0", kind: "connector" },
      { type: "local", path: "user" },
    );

    const listener = vi.fn();
    const unsubscribe = pluginRegistry.subscribe(listener);
    pluginRegistry.setConnectorConfig(id, { trusted: true });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(pluginRegistry.getConnectorConfig(id)?.trusted).toBe(true);

    unsubscribe();
    pluginRegistry.uninstall(id);
  });
});
