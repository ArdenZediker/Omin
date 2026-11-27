import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useDialogFocus } from "./useDialogFocus";

function FocusManagedDialog({ open }: { open: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, open);
  if (!open) return null;

  return (
    <div ref={dialogRef} role="dialog" aria-label="测试弹窗" tabIndex={-1}>
      <button type="button">首个操作</button>
      <button type="button" data-dialog-initial-focus>初始操作</button>
      <button type="button">末个操作</button>
    </div>
  );
}

describe("useDialogFocus", () => {
  it("保留 autofocus 初始焦点，Tab 和 Shift+Tab 在弹窗内循环", () => {
    render(<FocusManagedDialog open />);

    const first = screen.getByRole("button", { name: "首个操作" });
    const initial = screen.getByRole("button", { name: "初始操作" });
    const last = screen.getByRole("button", { name: "末个操作" });
    expect(document.activeElement).toBe(initial);

    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("关闭后把焦点归还给打开弹窗前的控件", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "打开弹窗";
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(<FocusManagedDialog open />);

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "初始操作" }));
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("没有可聚焦操作时将焦点留在弹窗容器", () => {
    function EmptyDialog() {
      const dialogRef = useRef<HTMLDivElement>(null);
      useDialogFocus(dialogRef, true);
      return <div ref={dialogRef} role="dialog" aria-label="空弹窗" tabIndex={-1} />;
    }

    render(<EmptyDialog />);
    const dialog = screen.getByRole("dialog", { name: "空弹窗" });
    expect(document.activeElement).toBe(dialog);

    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    dialog.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });
});
