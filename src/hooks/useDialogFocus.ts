import { useLayoutEffect } from "react";
import type { RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function getFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && !element.matches(":disabled") && element.getAttribute("aria-hidden") !== "true",
  );
}

export function useDialogFocus(dialogRef: RefObject<HTMLElement | null>, active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const previousFocus = dialog.ownerDocument.activeElement;
    const focusInitialTarget = () => {
      const target =
        dialog.querySelector<HTMLElement>("[data-dialog-initial-focus], [autofocus]") ??
        getFocusableElements(dialog)[0] ??
        dialog;
      target.focus({ preventScroll: true });
    };

    focusInitialTarget();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = getFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = dialog.ownerDocument.activeElement;
      if (event.shiftKey && (current === first || !dialog.contains(current))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (current === last || !dialog.contains(current))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    dialog.addEventListener("keydown", handleKeyDown);
    return () => {
      dialog.removeEventListener("keydown", handleKeyDown);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [active, dialogRef]);
}
