import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CompactQueryPanel from "./CompactQueryPanel";

describe("CompactQueryPanel 快速提问", () => {
  it("显示明确的提问入口，并将输入交给上层", () => {
    const onChange = vi.fn();
    render(
      <CompactQueryPanel
        compactQuery=""
        isCharacterAppearance={false}
        onChange={onChange}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />
    );

    const input = screen.getByRole("textbox", { name: "快速提问" });
    expect(input).toHaveAttribute("placeholder", "问 Omni 一个问题");
    expect(input).toHaveFocus();
    expect(screen.queryByRole("button", { name: "默认查询" })).toBeNull();
    fireEvent.change(input, { target: { value: "你好" } });
    expect(onChange).toHaveBeenCalledWith("你好");
  });

  it("回车就地提问，Alt+回车带到主窗口，Escape 关闭", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(
      <CompactQueryPanel
        compactQuery="你好"
        isCharacterAppearance={false}
        onChange={vi.fn()}
        onClose={onClose}
        onSubmit={onSubmit}
      />
    );

    const input = screen.getByRole("textbox", { name: "快速提问" });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", altKey: true });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onSubmit).toHaveBeenNthCalledWith(1, false);
    expect(onSubmit).toHaveBeenNthCalledWith(2, true);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("输入条内的关闭按钮能返回悬浮球", () => {
    const onClose = vi.fn();
    render(
      <CompactQueryPanel compactQuery="" isCharacterAppearance={false} onChange={vi.fn()} onClose={onClose} onSubmit={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭快速提问" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
