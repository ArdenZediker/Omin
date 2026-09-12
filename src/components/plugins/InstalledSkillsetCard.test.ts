import { describe, expect, it } from "vitest";
import {
  collectSkillsetChildIds,
  collectSkillsetSlugs,
} from "./InstalledSkillsetCard";
import { pluginRegistry } from "../../plugins/registry";

/**
 * 「我的技能」归组的两条红线：
 *
 *  ① 只按**子技能自己** `source.skillsetSlug` 归属，不做网络反查 ——
 *     否则每次渲染都要请求 skillset 详情，装了什么就得看到什么会被网络抖动破坏。
 *  ② 归属的套件一旦卸载，其子技能必须**重新回到平铺列表** —— 否则这些技能会在
 *     UI 上凭空消失（文件还在磁盘、斜杠命令也还能用，却哪儿都看不到）。
 */
const manifestOf = (id: string) => ({
  id,
  name: id,
  description: "归组测试",
  version: "1.0.0",
  kind: "skill" as const,
});

const suite = (id: string, slug: string) => [
  manifestOf(id),
  { type: "marketplace" as const, repository: `skillset/${slug}` },
] as const;

const childOf = (id: string, slug: string) => [
  manifestOf(id),
  {
    type: "marketplace" as const,
    repository: `skillhub/${id}`,
    skillsetSlug: slug,
  },
] as const;

const plain = (id: string) =>
  [manifestOf(id), { type: "marketplace" as const, repository: `skillhub/${id}` }] as const;

describe("专家团归组：collectSkillsetSlugs / collectSkillsetChildIds", () => {
  it("按 source 归属把子技能挂到对应套件下", () => {
    pluginRegistry.load();
    pluginRegistry.install(...suite("suite-one-plugin", "suite-one"));
    pluginRegistry.install(...childOf("ns-a/alpha", "suite-one"));
    pluginRegistry.install(...childOf("ns-b/beta", "suite-two"));
    pluginRegistry.install(...plain("ns-c/standalone"));

    expect(collectSkillsetSlugs().get("suite-one-plugin")).toBe("suite-one");

    // 真实调用口径：只把「当前仍安装着的套件」传进去
    const hidden = () => collectSkillsetChildIds(collectSkillsetSlugs().values());
    expect(hidden().has("ns-a/alpha")).toBe(true);
    // 归属别的套件（那个套件没装）→ 不算
    expect(hidden().has("ns-b/beta")).toBe(false);
    // 没有归属的独立技能 → 不算
    expect(hidden().has("ns-c/standalone")).toBe(false);
    // 套件本体自己不能被子技能过滤逻辑吃掉
    expect(hidden().has("suite-one-plugin")).toBe(false);

    for (const id of ["ns-a/alpha", "ns-b/beta", "ns-c/standalone"]) {
      pluginRegistry.uninstall(id);
    }

    // 套件卸载后，它的子技能必须重新出现在平铺列表里
    pluginRegistry.uninstall("suite-one-plugin");
    expect(hidden().size).toBe(0);
  });

  it("没有已安装套件时不做任何遍历（返回空集）", () => {
    pluginRegistry.load();
    expect(collectSkillsetChildIds([]).size).toBe(0);
  });
});
