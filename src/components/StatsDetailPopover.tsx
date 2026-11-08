import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const VIEWPORT_GAP = 12;
const TRIGGER_GAP = 8;

type StatsDetailPopoverProps = {
  triggerClassName: string;
  triggerLabel: string;
  triggerContent: ReactNode;
  panelLabel: string;
  panelWidth?: number;
  panelClassName?: string;
  children: ReactNode;
};

type PanelPosition = {
  left: number;
  bottom: number;
  width: number;
};

export default function StatsDetailPopover({
  triggerClassName,
  triggerLabel,
  triggerContent,
  panelLabel,
  panelWidth = 300,
  panelClassName,
  children,
}: StatsDetailPopoverProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(panelWidth, Math.max(220, window.innerWidth - VIEWPORT_GAP * 2));
    const centeredLeft = rect.left + rect.width / 2 - width / 2;
    const left = Math.max(
      VIEWPORT_GAP,
      Math.min(centeredLeft, window.innerWidth - width - VIEWPORT_GAP),
    );
    const aboveBottom = window.innerHeight - rect.top + TRIGGER_GAP;
    const panelHeight = panelRef.current?.offsetHeight ?? 0;
    const bottom = panelHeight > 0
      ? Math.max(
          VIEWPORT_GAP,
          Math.min(aboveBottom, window.innerHeight - panelHeight - VIEWPORT_GAP),
        )
      : aboveBottom;
    setPosition({ left, bottom, width });
  }, [panelWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    updatePosition();
    const panel = panelRef.current;
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updatePosition);
    if (panel) resizeObserver?.observe(panel);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        triggerRef.current?.contains(target)
        || panelRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const panel = open && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={panelRef}
          className={panelClassName
            ? `stats-detail-popover__panel ${panelClassName}`
            : "stats-detail-popover__panel"}
          role="dialog"
          aria-label={panelLabel}
          style={{
            left: position?.left ?? 0,
            bottom: position?.bottom ?? 0,
            width: position?.width ?? panelWidth,
            visibility: position ? "visible" : "hidden",
          } as CSSProperties}
        >
          {children}
        </div>,
        document.body,
      )
    : null;

  return (
    <span className="stats-detail-popover">
      <button
        ref={triggerRef}
        type="button"
        className={`stats-detail-popover__trigger ${triggerClassName}`}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {triggerContent}
      </button>
      {panel}
    </span>
  );
}

export function StatsDetailTitle({
  icon,
  title,
  value,
}: {
  icon: ReactNode;
  title: string;
  value?: ReactNode;
}) {
  return (
    <div className="stats-detail-popover__title">
      <span className="stats-detail-popover__title-label">
        {icon}
        {title}
      </span>
      {value !== undefined && (
        <span className="stats-detail-popover__title-value">{value}</span>
      )}
    </div>
  );
}
