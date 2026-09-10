import type { BasicSettings } from "./types";
import { UNSET_SHORTCUT } from "./constants";

/** 修饰键的固定输出顺序——保证不同来源产出的快捷键串可以直接做字符串比较。 */
const MODIFIER_ORDER = ["Ctrl", "Shift", "Alt", "Meta"] as const;

/** 修饰键别名归一表（含 macOS 常见写法与 Rust 侧 global-hotkey 的写法）。 */
const MODIFIER_ALIASES: Record<string, string> = {
  Control: "Ctrl",
  Ctrl: "Ctrl",
  Shift: "Shift",
  Alt: "Alt",
  Option: "Alt",
  Meta: "Meta",
  Cmd: "Meta",
  Command: "Meta",
  Super: "Meta",
};

/** 键名别名表。空串是历史遗留：早期把空格键存成了单个空格（`Ctrl+Shift+ `）。 */
const KEY_ALIASES: Record<string, string> = {
  "": "Space",
  " ": "Space",
};

type ShortcutSettingKey = "openMainShortcut" | "switchPreviousModelShortcut";

/**
 * 把一次键盘事件转成规范快捷键串（如 `Ctrl+Shift+Space`）。
 * 只按下修饰键时返回空串，表示「这还不是一个完整组合」。
 */
export function shortcutFromEvent(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">
): string {
  if (["Control", "Shift", "Alt", "Meta"].includes(event.key)) {
    return "";
  }

  return [
    event.ctrlKey ? "Ctrl" : "",
    event.shiftKey ? "Shift" : "",
    event.altKey ? "Alt" : "",
    event.metaKey ? "Meta" : "",
    normalizeKeyName(event.key),
  ]
    .filter(Boolean)
    .join("+");
}

function normalizeKeyName(key: string): string {
  if (key in KEY_ALIASES) {
    return KEY_ALIASES[key];
  }
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * 把已存储的快捷键串规范化成可比较形式：统一修饰键顺序与别名，并修正历史遗留的空格键写法。
 * 未设置 / 无法识别（如只剩修饰键）时返回空串，调用方据此判定「该快捷键未启用」。
 */
export function canonicalizeShortcut(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === UNSET_SHORTCUT) {
    return "";
  }

  const parts = trimmed.split("+").map((part) => part.trim());
  const keyPart = parts.filter((part) => !(part in MODIFIER_ALIASES)).pop();
  if (keyPart === undefined) {
    return "";
  }

  const key = normalizeKeyName(keyPart);
  const modifiers = MODIFIER_ORDER.filter((modifier) =>
    parts.some((part) => MODIFIER_ALIASES[part] === modifier)
  );

  return [...modifiers, key].join("+");
}

export type ShortcutActionId = "open-main" | "switch-previous-model";

export type InAppShortcutContext = {
  /** 「唤起主界面」是否已由 Rust 全局热键接管；接管后 DOM 不再响应，避免一次按键触发两次。 */
  openMainHandledGlobally: boolean;
  /** 是否存在可切换的上一个模型。 */
  hasPreviousModel: boolean;
};

type InAppShortcutRule = {
  id: ShortcutActionId;
  setting: ShortcutSettingKey;
  enabled: (ctx: InAppShortcutContext) => boolean;
};

/**
 * 应用内（窗口聚焦时）快捷键规则表。
 *
 * 新增快捷键只需在这里补一条规则——按键匹配（本文件）与副作用派发（调用方）分离，
 * 避免继续往 useEffect 里堆 `if`。判重、preventDefault 等公共逻辑由调用方统一处理。
 */
const IN_APP_SHORTCUT_RULES: InAppShortcutRule[] = [
  {
    id: "open-main",
    setting: "openMainShortcut",
    // 全局热键注册成功时由 Rust 处理，DOM 侧让位。
    enabled: (ctx) => !ctx.openMainHandledGlobally,
  },
  {
    id: "switch-previous-model",
    setting: "switchPreviousModelShortcut",
    enabled: (ctx) => ctx.hasPreviousModel,
  },
];

/**
 * 把一次按键归约成一个动作 id；无匹配返回 null。
 * 纯函数：不读全局状态、不产生副作用，便于单测。
 */
export function classifyInAppShortcut(
  pressed: string,
  settings: Pick<BasicSettings, ShortcutSettingKey>,
  ctx: InAppShortcutContext
): ShortcutActionId | null {
  if (!pressed) {
    return null;
  }

  for (const rule of IN_APP_SHORTCUT_RULES) {
    if (!rule.enabled(ctx)) {
      continue;
    }
    const bound = canonicalizeShortcut(settings[rule.setting]);
    if (bound && bound === pressed) {
      return rule.id;
    }
  }

  return null;
}
