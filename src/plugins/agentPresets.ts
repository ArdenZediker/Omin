import { pluginRegistry } from "./registry";
import { canonicalizeExpertManifest } from "./expertProfiles";
import type { PluginManifest } from "./types";

/**
 * 统一专家预设的项目指令保存入口（项目设置 →「保存为专家预设」）。
 *
 * 背景：预设此前只有内置那 4 条，定义在 `plugins/builtins.ts` 里 —— 想加一条只能改源码。
 * 当前项目指令会沉淀为统一专家预设；该条目既可应用于项目，也可用于委派，并可在专家编辑器
 * 中继续配置角色提示词、工具和技能。
 *
 * 三条口径：
 * 1. **同名即覆盖**：「另存为」的语义就是「叫这个名字的预设 = 这份内容」。名字不变 →
 *    更新那一条（保留 installedAt）；换个名字 → 新增一条。因此在预设列表里看不到重复项，
 *    但也不做「自动去重同名」这种魔法 —— 重名就是覆盖，符合「另存为」的直觉。
 * 2. **id 由名字哈希得出且带前缀**：`user-preset-<hash>`。前缀保证永远不会撞上内置/市场的
 *    id（那些都是 kebab 英文名）；哈希保证同一个名字永远落到同一个 id（覆盖语义的基础）。
 *    哈希理论上会撞，所以落库前还有一道「同 id 不同名 → 换后缀」的兜底。
 * 3. 项目长期指令存入 `instruction`，角色指导另存于 `templatePrompt`；二者作用范围不同。
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

export type SaveAgentPresetInput = {
  /** 预设名称（同时是覆盖判据）。 */
  name: string;
  /** 一句话说明，展示在预设列表里。留空则给一句兜底文案。 */
  description?: string;
  /** 持久项目指令，即 `project.systemPrompt`。空指令会被拒绝。 */
  instruction: string;
};

export type SaveAgentPresetResult =
  | { ok: true; manifest: PluginManifest; created: boolean }
  | { ok: false; error: string };

/**
 * 把项目指令保存为统一专家预设（同名覆盖）。
 */
export function saveAgentPreset(input: SaveAgentPresetInput): SaveAgentPresetResult {
  const name = input.name.trim();
  const instruction = input.instruction.trim();

  if (!name) return { ok: false, error: "预设名称不能为空" };
  if (!instruction) return { ok: false, error: "指令为空，没有可保存的内容" };

  const id = resolvePresetId(name);
  const existing = pluginRegistry.getManifest(id);
  const manifest: PluginManifest = canonicalizeExpertManifest({
    ...existing,
    id,
    name,
    description: input.description?.trim() || `由项目指令保存的专家预设：${name}`,
    version: existing?.version ?? "1.0.0",
    author: existing?.author ?? "我",
    kind: "expert",
    templatePrompt: existing?.templatePrompt ||
      `你是「${name}」专家。依据项目指令开展工作，专注于完成分配给你的任务并给出清晰、可核验的结果。`,
    category: existing?.category ?? "AI Agent",
    instruction,
  });

  if (pluginRegistry.isInstalled(id)) {
    pluginRegistry.updateManifest(manifest);
    return { ok: true, manifest, created: false };
  }
  pluginRegistry.install(manifest, { type: "user" });
  return { ok: true, manifest, created: true };
}
