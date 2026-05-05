import type { KeyboardEvent } from "react";

type CompactQueryPanelProps = {
  compactQuery: string;
  isCharacterAppearance: boolean;
  variant?: "default" | "character" | "pet";
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (openMain?: boolean) => void | Promise<void>;
};

export default function CompactQueryPanel({
  compactQuery,
  isCharacterAppearance,
  variant = isCharacterAppearance ? "character" : "default",
  onChange,
  onClose,
  onSubmit,
}: CompactQueryPanelProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === "Enter" && event.altKey) {
      event.preventDefault();
      void onSubmit(true);
      if (variant === "default") {
        onClose();
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      void onSubmit(false);
      if (variant === "default") {
        onClose();
      }
    }
  };

  if (variant === "pet") {
    return (
      <div className="compact-query compact-query--pet animate-fade-in no-drag" onMouseDown={(event) => event.stopPropagation()}>
        <div className="compact-query__row compact-query__row--pet">
          <input
            type="text"
            value={compactQuery}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入后回车"
            className="compact-query__input compact-query__input--pet"
            autoFocus
          />
          <button type="button" className="compact-query__preset compact-query__preset--pet" onClick={() => void onSubmit(false)}>
            发送
          </button>
        </div>
      </div>
    );
  }

  if (variant === "character") {
    return (
      <div className="compact-query compact-query--character animate-fade-in no-drag" onMouseDown={(event) => event.stopPropagation()}>
        <div className="compact-query__row">
          <button type="button" className="compact-query__preset" onClick={() => onChange("默认查询")}>
            默认查询
          </button>
          <input
            type="text"
            value={compactQuery}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="请输入查询内容"
            className="compact-query__input"
            autoFocus
          />
          <button type="button" className="compact-query__preset" onClick={() => void onSubmit(false)}>
            发送
          </button>
        </div>
        <div className="compact-query__hint">回车直接回答，Alt+回车切到主窗口</div>
      </div>
    );
  }

  return (
    <div className="compact-search-popover no-drag" onMouseDown={(event) => event.stopPropagation()}>
      <button type="button" className="compact-query__preset compact-query__preset--inline" onClick={() => onChange("默认查询")}>
        默认查询
      </button>
      <input
        type="text"
        value={compactQuery}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="请输入查询内容"
        className="compact-search-popover__input"
        autoFocus
      />
      <button
        type="button"
        className="compact-query__preset compact-query__preset--inline"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          void onSubmit(false);
          onClose();
        }}
      >
        发送
      </button>
    </div>
  );
}
