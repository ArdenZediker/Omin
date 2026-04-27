type CompactQueryPanelProps = {
  compactQuery: string;
  isCharacterAppearance: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (openMain?: boolean) => void | Promise<void>;
};

export default function CompactQueryPanel({
  compactQuery,
  isCharacterAppearance,
  onChange,
  onClose,
  onSubmit,
}: CompactQueryPanelProps) {
  if (isCharacterAppearance) {
    return (
      <div className="compact-query animate-fade-in no-drag" onMouseDown={(e) => e.stopPropagation()}>
        <div className="compact-query__row">
          <button type="button" className="compact-query__preset" onClick={() => onChange("默认查询")}>
            默认查询
          </button>
          <input
            type="text"
            value={compactQuery}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.altKey) {
                e.preventDefault();
                void onSubmit(true);
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                void onSubmit(false);
              }
            }}
            placeholder="请输入查询内容"
            className="compact-query__input"
            autoFocus
          />
          <button type="button" className="compact-query__preset" onClick={() => void onSubmit(false)}>
            发送
          </button>
        </div>
        <div className="compact-query__hint">回车在角色旁回答，Alt+回车切到主窗口</div>
      </div>
    );
  }

  return (
    <div className="compact-search-popover no-drag" onMouseDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="compact-query__preset compact-query__preset--inline"
        onClick={() => onChange("默认查询")}
      >
        默认查询
      </button>
      <input
        type="text"
        value={compactQuery}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
            return;
          }
          if (e.key === "Enter" && e.altKey) {
            e.preventDefault();
            void onSubmit(true);
            onClose();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            void onSubmit(false);
            onClose();
          }
        }}
        placeholder="请输入查询内容"
        className="compact-search-popover__input"
        autoFocus
      />
      <button
        type="button"
        className="compact-query__preset compact-query__preset--inline"
        onMouseDown={(e) => e.preventDefault()}
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
