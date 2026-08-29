import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export type OmniSelectOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

type OmniSelectProps = {
  value: string;
  options: OmniSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
};

type MenuPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

function getFirstEnabledIndex(options: OmniSelectOption[]) {
  return options.findIndex((option) => !option.disabled);
}

function getNextEnabledIndex(options: OmniSelectOption[], startIndex: number, direction: 1 | -1) {
  if (options.length === 0) {
    return -1;
  }

  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (startIndex + direction * offset + options.length) % options.length;
    if (!options[index]?.disabled) {
      return index;
    }
  }

  return -1;
}

function getMenuPosition(trigger: HTMLButtonElement): MenuPosition {
  const rect = trigger.getBoundingClientRect();
  const viewportPadding = 12;
  const gap = 6;
  const availableBelow = window.innerHeight - rect.bottom - viewportPadding - gap;
  const availableAbove = rect.top - viewportPadding - gap;
  const opensAbove = availableBelow < 180 && availableAbove > availableBelow;
  const maxHeight = Math.max(132, Math.min(280, opensAbove ? availableAbove : availableBelow));

  return {
    top: opensAbove ? Math.max(viewportPadding, rect.top - gap - maxHeight) : rect.bottom + gap,
    left: Math.min(Math.max(viewportPadding, rect.left), window.innerWidth - rect.width - viewportPadding),
    width: rect.width,
    maxHeight,
  };
}

export default function OmniSelect({
  value,
  options,
  onChange,
  placeholder = "请选择",
  ariaLabel,
  className,
  disabled = false,
}: OmniSelectProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;
  const [activeIndex, setActiveIndex] = useState(selectedIndex >= 0 ? selectedIndex : getFirstEnabledIndex(options));

  const menuId = useMemo(() => `omni-select-${Math.random().toString(36).slice(2)}`, []);
  const enabled = !disabled && options.some((option) => !option.disabled);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    setMenuPosition(getMenuPosition(trigger));
  }, []);

  const openMenu = useCallback(() => {
    if (!enabled) {
      return;
    }
    const nextActiveIndex = selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : getFirstEnabledIndex(options);
    setActiveIndex(nextActiveIndex);
    updatePosition();
    setIsOpen(true);
  }, [enabled, options, selectedIndex, updatePosition]);

  const closeMenu = useCallback(() => {
    setIsOpen(false);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    updatePosition();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      closeMenu();
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [closeMenu, isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    setActiveIndex(selectedIndex >= 0 && !options[selectedIndex]?.disabled ? selectedIndex : getFirstEnabledIndex(options));
  }, [isOpen, options, selectedIndex]);

  const chooseOption = (option: OmniSelectOption) => {
    if (option.disabled) {
      return;
    }
    onChange(option.value);
    closeMenu();
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!isOpen) {
        openMenu();
        return;
      }
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => getNextEnabledIndex(options, current >= 0 ? current : 0, direction));
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!isOpen) {
        openMenu();
        return;
      }
      const option = options[activeIndex];
      if (option) {
        chooseOption(option);
      }
      return;
    }

    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      closeMenu();
    }
  };

  return (
    <div className={`omni-select${className ? ` ${className}` : ""}`} data-open={isOpen ? "true" : "false"}>
      <button
        ref={triggerRef}
        type="button"
        className="omni-select__trigger"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={menuId}
        aria-label={ariaLabel}
        disabled={!enabled}
        onClick={() => (isOpen ? closeMenu() : openMenu())}
        onKeyDown={handleKeyDown}
      >
        <span className={`omni-select__value${selectedOption ? "" : " omni-select__value--placeholder"}`}>
          {selectedOption?.label ?? placeholder}
        </span>
        <ChevronDown className="omni-select__chevron" size={15} strokeWidth={2} aria-hidden="true" />
      </button>

      {isOpen && menuPosition
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="listbox"
              className="omni-select__menu"
              style={{
                top: menuPosition.top,
                left: menuPosition.left,
                width: menuPosition.width,
                maxHeight: menuPosition.maxHeight,
              }}
            >
              {options.map((option, index) => {
                const isSelected = option.value === value;
                const isActive = index === activeIndex;
                return (
                  <button
                    key={`${option.value}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={option.disabled}
                    className={`omni-select__option${isSelected ? " omni-select__option--selected" : ""}${
                      isActive ? " omni-select__option--active" : ""
                    }`}
                    onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                    onClick={() => chooseOption(option)}
                  >
                    <span className="omni-select__option-text">
                      <span className="omni-select__option-label">{option.label}</span>
                      {option.description ? (
                        <span className="omni-select__option-description">{option.description}</span>
                      ) : null}
                    </span>
                    {isSelected ? <Check size={14} strokeWidth={2.2} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
