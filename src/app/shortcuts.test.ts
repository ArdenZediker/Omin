import { describe, expect, it } from "vitest";
import {
  canonicalizeShortcut,
  classifyInAppShortcut,
  shortcutFromEvent,
} from "./shortcuts";

type ShortcutEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">;

function keyEvent(partial: Partial<ShortcutEvent> & { key: string }): ShortcutEvent {
  return { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...partial };
}

describe("shortcutFromEvent", () => {
  it("把空格键规范为 Space", () => {
    // 历史实现直接用 event.key，空格会产出单个空格，导致与默认值 "Ctrl+Shift+Space" 永不相等。
    expect(shortcutFromEvent(keyEvent({ key: " ", ctrlKey: true, shiftKey: true }))).toBe(
      "Ctrl+Shift+Space"
    );
  });

  it("只按修饰键时返回空串", () => {
    expect(shortcutFromEvent(keyEvent({ key: "Control", ctrlKey: true }))).toBe("");
    expect(shortcutFromEvent(keyEvent({ key: "Shift", shiftKey: true }))).toBe("");
  });

  it("字母键转大写，修饰键顺序固定", () => {
    expect(shortcutFromEvent(keyEvent({ key: "k", shiftKey: true, ctrlKey: true }))).toBe(
      "Ctrl+Shift+K"
    );
  });
});

describe("canonicalizeShortcut", () => {
  it("未设置与空值视为未绑定", () => {
    expect(canonicalizeShortcut("")).toBe("");
    expect(canonicalizeShortcut("未设置")).toBe("");
    // 只有修饰键、没有主键 → 不成组合
    expect(canonicalizeShortcut("Ctrl+Shift")).toBe("");
  });

  it("修正历史遗留的空格键写法", () => {
    expect(canonicalizeShortcut("Ctrl+Shift+ ")).toBe("Ctrl+Shift+Space");
  });

  it("统一修饰键顺序与别名", () => {
    expect(canonicalizeShortcut("Shift+Ctrl+K")).toBe("Ctrl+Shift+K");
    expect(canonicalizeShortcut("Command+Space")).toBe("Meta+Space");
  });
});

describe("classifyInAppShortcut", () => {
  const settings = {
    openMainShortcut: "Ctrl+Shift+Space",
    switchPreviousModelShortcut: "Ctrl+Alt+P",
  };

  it("全局热键已接管时，DOM 不再响应「唤起主界面」", () => {
    expect(
      classifyInAppShortcut("Ctrl+Shift+Space", settings, {
        openMainHandledGlobally: true,
        hasPreviousModel: true,
      })
    ).toBeNull();
  });

  it("全局注册失败时回落到 DOM 响应", () => {
    expect(
      classifyInAppShortcut("Ctrl+Shift+Space", settings, {
        openMainHandledGlobally: false,
        hasPreviousModel: false,
      })
    ).toBe("open-main");
  });

  it("没有上一个模型时不触发切换", () => {
    expect(
      classifyInAppShortcut("Ctrl+Alt+P", settings, {
        openMainHandledGlobally: true,
        hasPreviousModel: false,
      })
    ).toBeNull();
  });

  it("匹配时返回对应动作 id", () => {
    expect(
      classifyInAppShortcut("Ctrl+Alt+P", settings, {
        openMainHandledGlobally: true,
        hasPreviousModel: true,
      })
    ).toBe("switch-previous-model");
  });

  it("空按键串不匹配任何动作", () => {
    expect(
      classifyInAppShortcut("", settings, { openMainHandledGlobally: false, hasPreviousModel: true })
    ).toBeNull();
  });
});
