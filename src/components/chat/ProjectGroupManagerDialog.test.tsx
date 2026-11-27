import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProjectGroupManagerDialog from "./ProjectGroupManagerDialog";

function renderDialog() {
  const onClose = vi.fn();
  render(
    <ProjectGroupManagerDialog
      groupNames={[]}
      draft=""
      onDraftChange={vi.fn()}
      createMode={false}
      onCreateModeChange={vi.fn()}
      editingGroupName={null}
      onEditingGroupNameChange={vi.fn()}
      editingDraft=""
      onEditingDraftChange={vi.fn()}
      onCreateGroup={vi.fn()}
      onRenameGroup={vi.fn()}
      onDeleteGroup={vi.fn()}
      onClose={onClose}
    />,
  );
  return { onClose };
}

describe("ProjectGroupManagerDialog", () => {
  it("exposes modal semantics and closes on Escape", () => {
    const { onClose } = renderDialog();
    const dialog = screen.getByRole("dialog", { name: "分组管理" });

    expect(dialog).toHaveAttribute("aria-modal", "true");
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });
});
