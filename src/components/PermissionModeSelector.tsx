import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { getPermissionMode, isFullAccess, setPermissionMode, subscribePermissionMode, type PermissionMode } from "../chat/permissionMode";

const MODE_LABELS: Record<PermissionMode, string> = {
  default: "默认权限",
  "full-access": "完全访问",
};

export default function PermissionModeSelector() {
  const [mode, setModeState] = useState<PermissionMode>(getPermissionMode);
  const [isOpen, setIsOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribePermissionMode((next) => {
      setModeState(next);
    });
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen]);

  const toggleMode = () => {
    const next = isFullAccess() ? "default" : "full-access";
    setPermissionMode(next);
  };

  const fullAccess = mode === "full-access";

  return (
    <div className="permission-mode-selector" ref={panelRef}>
      <button
        type="button"
        className={`permission-mode-selector__trigger ${fullAccess ? "permission-mode-selector__trigger--active" : ""}`}
        title={`权限控制：${MODE_LABELS[mode]}`}
        onClick={() => setIsOpen((open) => !open)}
      >
        <Check size={15} strokeWidth={2.4} />
        <span className="permission-mode-selector__trigger-label">{MODE_LABELS[mode]}</span>
      </button>

      {isOpen && (
        <div className="permission-mode-selector__panel animate-fade-in">
          <div className="permission-mode-selector__header">
            <span className="permission-mode-selector__title">权限控制</span>
            <span className="permission-mode-selector__badge">{MODE_LABELS[mode]}</span>
          </div>

          <p className="permission-mode-selector__desc">
            {fullAccess
              ? "当前为完全访问，Omni 将跳过所有确认弹窗直接执行操作。"
              : "当前为默认权限，所有操作都会在安全沙箱约束内进行，超出范围会请求你的允许。"}
          </p>

          <label className="permission-mode-selector__row">
            <span className="permission-mode-selector__label">允许完全访问</span>
            <span className="permission-mode-selector__toggle">
              <input
                type="checkbox"
                checked={fullAccess}
                onChange={toggleMode}
                className="permission-mode-selector__checkbox"
              />
              <span className="permission-mode-selector__track" aria-hidden="true">
                <span className="permission-mode-selector__thumb" />
              </span>
            </span>
          </label>

          <p className="permission-mode-selector__hint">
            {fullAccess ? "谨慎使用：误操作风险更高。" : "可随时切换以批量执行可信操作。"}
          </p>
        </div>
      )}
    </div>
  );
}
