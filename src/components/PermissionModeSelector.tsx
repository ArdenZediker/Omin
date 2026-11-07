import { useEffect, useRef, useState } from "react";
import { ChevronDown, Shield, ShieldCheck } from "lucide-react";
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
        title={MODE_LABELS[mode]}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={() => setIsOpen((open) => !open)}
      >
        {fullAccess ? <ShieldCheck size={16} strokeWidth={1.8} /> : <Shield size={16} strokeWidth={1.8} />}
        <span>{MODE_LABELS[mode]}</span>
        <ChevronDown size={14} strokeWidth={1.8} className={isOpen ? "permission-mode-selector__chevron--open" : ""} />
      </button>

      {isOpen && (
        <div className="permission-mode-selector__panel animate-fade-in">
          <div className="permission-mode-selector__header">
            <span className="permission-mode-selector__title">权限控制</span>
            <span className="permission-mode-selector__badge">{MODE_LABELS[mode]}</span>
          </div>

          <p className="permission-mode-selector__desc">
            {fullAccess
              ? "当前会跳过确认弹窗；文件写入范围仍由设置中的文件权限（沙箱）决定。"
              : "危险或写入操作会请求你的允许；文件写入范围由设置中的文件权限（沙箱）决定。"}
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
