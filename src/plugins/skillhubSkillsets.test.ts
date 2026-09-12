import { describe, expect, it, vi } from "vitest";
import { pluginRegistry } from "./registry";
import { installSkillhubSkill } from "./skillhub";
import { installSkillsetChildren } from "./skillhubSkillsets";

/**
 * 「一键安装 / 补装子技能」的两条红线：
 *
 *  ① **已装的子技能不重装** —— `registry.install()` 会把 entry 整个换掉、
 *     `enabled` 重置为 true，用户手工关掉的子技能会被悄悄打开。重复点
 *     「一键安装」必须安全，否则它就成了一个会改开关的隐藏副作用。
 *  ② 归属关系（`source.skillsetSlug`）必须落到子技能自己身上 —— 这是
 *     「我的技能」把子技能收进套件卡片、不平铺的唯一依据。
 */
vi.mock("./skillhub", () => ({
  installSkillhubSkill: vi.fn(async (slug: string) => ({
    slug,
    path: `/tmp/${slug}`,
    manifest: { id: slug },
  })),
  uninstallSkillhubSkill: vi.fn(async () => {}),
}));

const mockedInstall = vi.mocked(installSkillhubSkill);

/** SkillsetChildDetail 的最小形状（只有 slug / namespace 是必填）。 */
const child = (slug: string, namespace: string) => ({ slug, namespace });

const sourceOf = (id: string) =>
  pluginRegistry.listInstalled().find((e) => e.id === id)?.entry.source;

const manifestOf = (id: string) => ({
  id,
  name: id,
  description: "归组测试子技能",
  version: "1.0.0",
  kind: "skill" as const,
});

describe("installSkillsetChildren", () => {
  it("未装过的逐个安装，且都带上 skillsetSlug", async () => {
    pluginRegistry.load();
    mockedInstall.mockClear();

    const res = await installSkillsetChildren(
      [child("alpha", "ns-a"), child("beta", "ns-b")],
      "suite-x",
    );

    expect(res).toEqual({ claimed: 0, installed: 2, failed: 0 });
    expect(mockedInstall).toHaveBeenCalledTimes(2);
    // 第 4 个实参是 options —— 漏了它子技能就没有归属，「我的技能」归不了组
    expect(mockedInstall.mock.calls[0][3]).toEqual({ skillsetSlug: "suite-x" });
    expect(mockedInstall.mock.calls[1][3]).toEqual({ skillsetSlug: "suite-x" });
  });

  it("已装的只认领归属，不重装、不动开关", async () => {
    pluginRegistry.load();
    const id = "ns-a/existing-child";
    pluginRegistry.install(manifestOf(id), {
      type: "marketplace",
      repository: `skillhub/${id}`,
    });
    pluginRegistry.setEnabled(id, false);

    mockedInstall.mockClear();
    const res = await installSkillsetChildren([child("existing-child", "ns-a")], "suite-x");

    expect(res).toEqual({ claimed: 1, installed: 0, failed: 0 });
    expect(mockedInstall).not.toHaveBeenCalled();

    const source = sourceOf(id);
    expect(source && source.type === "marketplace" ? source.skillsetSlug : undefined).toBe(
      "suite-x",
    );
    // 认领不能是破坏性操作：用户手工关掉的开关必须原样保留
    expect(pluginRegistry.isEnabled(id)).toBe(false);

    pluginRegistry.uninstall(id);
  });

  it("老数据只有裸 slug（无 namespace 前缀）时也能认领", async () => {
    pluginRegistry.load();
    const id = "legacy-child";
    pluginRegistry.install(manifestOf(id), {
      type: "marketplace",
      repository: `skillhub/${id}`,
    });

    mockedInstall.mockClear();
    const res = await installSkillsetChildren([child("legacy-child", "ns-z")], "suite-x");

    expect(res.claimed).toBe(1);
    expect(mockedInstall).not.toHaveBeenCalled();

    pluginRegistry.uninstall(id);
  });

  it("单个子技能失败不阻断其余项", async () => {
    pluginRegistry.load();
    mockedInstall.mockClear();
    mockedInstall.mockRejectedValueOnce(new Error("下载失败"));

    const res = await installSkillsetChildren(
      [child("gamma", "ns-c"), child("delta", "ns-d")],
      "suite-y",
    );

    expect(res.installed).toBe(1);
    expect(res.failed).toBe(1);
    expect(mockedInstall).toHaveBeenCalledTimes(2);
  });
});
