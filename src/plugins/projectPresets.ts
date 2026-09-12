import { pluginRegistry } from "./registry";
import type { PluginManifest } from "./types";

/**
 * 项目预设的**自建通道**（项目设置 →「另存为预设」）。
 *
 * 背景：预设此前只有内置那 4 条，定义在 `plugins/builtins.ts` 里 —— 想加一条只能改源码。
 * 而用户真正手上有价值的东西是**自己调好的那个项目的指令**，所以入口做成「把当前项目的
 * 指令另存为一条预设」，而不是再给一张空白表单。
 *
 * 三条口径：
 * 1. **同名即覆盖**：「另存为」的语义就是「叫这个名字的预设 = 这份内容」。名字不变 →
 *    更新那一条（保留 installedAt）；换个名字 → 新增一条。因此在预设列表里看不到重复项，
 *    但也不做「自动去重同名」这种魔法 —— 重名就是覆盖，符合「另存为」的直觉。
 * 2. **id 由名字哈希得出且带前缀**：`user-preset-<hash>`。前缀保证永远不会撞上内置/市场的
 *    id（那些都是 kebab 英文名）；哈希保证同一个名字永远落到同一个 id（覆盖语义的基础）。
 *    哈希理论上会撞，所以落库前还有一道「同 id 不同名 → 换后缀」的兜底。
 * 3. **只存 `instruction`**：预设 =「持久项目指令」。不写 `starterPrompt`，因此自建预设
 *    没有「插入输入框」按钮（该按钮本来就以 `manifest.starterPrompt` 存在为前提）；
 *    也不写 `defaultToolIds` —— 内置工具无条件可用，写了是空操作（见 `builtins.ts` 同处注释）。
 */

/** 自建预设 id 前缀。判别「这条是用户自建还是内置/市场来的」只看它。 */
export const USER_PRESET_ID_PREFIX = "user-preset-";

/** djb2 → base36：把用户填的名字压成一个稳定、纯 ASCII 的 id 后缀。 */
function hashName(name: string): string {
  let hash = 5381;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 33) ^ name.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

/** 名字 → 预设 id。纯函数：同一个名字永远同一个 id（覆盖语义靠它）。 */
export function userPresetId(name: string): string {
  return `${USER_PRESET_ID_PREFIX}${hashName(name.trim())}`;
}

/**
 * 找出该名字应该用的 id。
 *
 * 正常情况就是 `userPresetId(name)`。只有哈希撞车（同 id 但名字不同）时才往后顺延后缀 ——
 * 宁可多出一条，也不能把别人的预设悄悄覆盖掉。
 */
function resolvePresetId(name: string): string {
  const base = userPresetId(name);
  let candidate = base;
  let suffix = 2;
  for (;;) {
    const existing = pluginRegistry.getManifest(candidate);
    if (!existing) return candidate;
    if (existing.name.trim() === name.trim()) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
}

export type SaveProjectPresetInput = {
  /** 预设名称（同时是覆盖判据）。 */
  name: string;
  /** 一句话说明，展示在预设列表里。留空则给一句兜底文案。 */
  description?: string;
  /** 持久项目指令，即 `project.systemPrompt`。空指令会被拒绝。 */
  instruction: string;
};

export type SaveProjectPresetResult =
  | { ok: true; manifest: PluginManifest; created: boolean }
  | { ok: false; error: string };

/**
 * 把一段项目指令保存为项目预设（同名覆盖）。写注册表 → 广播 → 新建项目对话框的下拉、
 * 扩展中心的「项目预设」tab 都会立刻反映出来。
 */
export function saveProjectPreset(input: SaveProjectPresetInput): SaveProjectPresetResult {
  const name = input.name.trim();
  const instruction = input.instruction.trim();

  if (!name) return { ok: false, error: "预设名称不能为空" };
  if (!instruction) return { ok: false, error: "指令为空，没有可保存的内容" };

  const id = resolvePresetId(name);
  const manifest: PluginManifest = {
    id,
    name,
    description: input.description?.trim() || `由项目指令保存的预设：${name}`,
    version: "1.0.0",
    author: "我",
    kind: "template",
    // 独立分类：让它在内置预设（商业运营 / 开发编程 / 内容创作）之外自成一档，
    // 用户一眼能认出哪几条是自己存的。
    category: "我的预设",
    instruction,
  };

  if (pluginRegistry.isInstalled(id)) {
    pluginRegistry.updateManifest(manifest);
    return { ok: true, manifest, created: false };
  }
  pluginRegistry.install(manifest, { type: "user" });
  return { ok: true, manifest, created: true };
}
