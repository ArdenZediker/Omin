import type { CharacterModel, CompactAppearance } from "../../hooks/useCompactWindowState";
import type { ExternalChatEntry } from "../../app/types";

type CompactMenuProps = {
  appearanceOptions: Array<{ id: CompactAppearance; title: string; description: string }>;
  characterMenuPosition: { x: number; y: number } | null;
  characterModel: CharacterModel;
  characterModelOptions: Array<{ id: CharacterModel; title: string; description: string }>;
  characterScale: number;
  compactAppearance: CompactAppearance;
  entries: ExternalChatEntry[];
  isCharacterAppearance: boolean;
  isCharacterModelOpen: boolean;
  isCompactAppearanceOpen: boolean;
  isCompactModelOpen: boolean;
  onCharacterModelChange: (model: CharacterModel) => void;
  onCompactAppearanceChange: (appearance: CompactAppearance) => void;
  onOpenExternalChat: (entry: ExternalChatEntry) => void | Promise<void>;
  onOpenSettingsFromCompact: () => void | Promise<void>;
  onScaleReset: () => void;
  onSetCharacterMenuPinned: React.Dispatch<React.SetStateAction<boolean>>;
  onSetIsCharacterModelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onSetIsCompactAppearanceOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onSetIsCompactMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onSetIsCompactModelOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

export default function CompactMenu({
  appearanceOptions,
  characterMenuPosition,
  characterModel,
  characterModelOptions,
  characterScale,
  compactAppearance,
  entries,
  isCharacterAppearance,
  isCharacterModelOpen,
  isCompactAppearanceOpen,
  isCompactModelOpen,
  onCharacterModelChange,
  onCompactAppearanceChange,
  onOpenExternalChat,
  onOpenSettingsFromCompact,
  onScaleReset,
  onSetCharacterMenuPinned,
  onSetIsCharacterModelOpen,
  onSetIsCompactAppearanceOpen,
  onSetIsCompactMenuOpen,
  onSetIsCompactModelOpen,
}: CompactMenuProps) {
  return (
    <div
      className={`compact-menu animate-fade-in ${isCharacterAppearance && characterMenuPosition ? "compact-menu--cursor" : ""}`}
      style={isCharacterAppearance && characterMenuPosition ? { left: characterMenuPosition.x, top: characterMenuPosition.y } : undefined}
    >
      <div className="compact-menu__section">
        <button
          type="button"
          className="compact-menu__item compact-menu__item--branch"
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={() => {
            onSetIsCompactModelOpen(true);
            onSetIsCompactAppearanceOpen(false);
            onSetIsCharacterModelOpen(false);
          }}
        >
          <span>聊天入口</span>
          <span className="compact-menu__arrow">{">"}</span>
        </button>
        <button
          type="button"
          className="compact-menu__item compact-menu__item--branch"
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={() => {
            onSetIsCompactModelOpen(false);
            onSetIsCompactAppearanceOpen(true);
            onSetIsCharacterModelOpen(false);
          }}
        >
          <span>界面外观</span>
          <span className="compact-menu__arrow">{">"}</span>
        </button>

        {isCharacterAppearance && (
          <button
            type="button"
            className="compact-menu__item"
            onMouseDown={(e) => e.stopPropagation()}
            onMouseEnter={() => {
              onSetIsCompactModelOpen(false);
              onSetIsCompactAppearanceOpen(false);
              onSetIsCharacterModelOpen(false);
            }}
            onClick={onScaleReset}
          >
            <span>重置缩放</span>
            <span className="compact-menu__meta">{(characterScale * 100).toFixed(0)}%</span>
          </button>
        )}

        <button
          type="button"
          className="compact-menu__item compact-menu__item--settings"
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={() => {
            onSetIsCompactModelOpen(false);
            onSetIsCompactAppearanceOpen(false);
            onSetIsCharacterModelOpen(false);
          }}
          onClick={() => {
            void onOpenSettingsFromCompact();
          }}
        >
          <svg className="compact-menu__settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Z" strokeWidth="1.8" strokeLinecap="round" />
            <path
              d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.04.04a2.1 2.1 0 0 1-2.97 2.97l-.04-.04A1.8 1.8 0 0 0 14.8 19.6a1.8 1.8 0 0 0-1.08 1.65V21.3a2.1 2.1 0 0 1-4.2 0v-.06A1.8 1.8 0 0 0 8.45 19.6a1.8 1.8 0 0 0-1.98.36l-.04.04a2.1 2.1 0 0 1-2.97-2.97l.04-.04A1.8 1.8 0 0 0 3.86 15a1.8 1.8 0 0 0-1.65-1.08H2.15a2.1 2.1 0 0 1 0-4.2h.06A1.8 1.8 0 0 0 3.86 8.65a1.8 1.8 0 0 0-.36-1.98l-.04-.04a2.1 2.1 0 0 1 2.97-2.97l.04.04a1.8 1.8 0 0 0 1.98.36A1.8 1.8 0 0 0 9.53 2.4V2.35a2.1 2.1 0 0 1 4.2 0v.06a1.8 1.8 0 0 0 1.08 1.65 1.8 1.8 0 0 0 1.98-.36l.04-.04a2.1 2.1 0 0 1 2.97 2.97l-.04.04a1.8 1.8 0 0 0-.36 1.98 1.8 1.8 0 0 0 1.65 1.08h.06a2.1 2.1 0 0 1 0 4.2h-.06A1.8 1.8 0 0 0 19.4 15Z"
              strokeWidth="1.35"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>设置</span>
        </button>
      </div>

      {isCompactModelOpen && (
        <div
          className="compact-submenu animate-fade-in"
          onMouseEnter={() => {
            onSetIsCompactModelOpen(true);
            onSetIsCompactAppearanceOpen(false);
            onSetIsCharacterModelOpen(false);
          }}
        >
          <div className="compact-menu__label">聊天入口</div>
          {entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="compact-menu__item"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                void onOpenExternalChat(entry);
              }}
            >
              <span>{entry.title}</span>
              <span className="compact-menu__meta">{entry.kind === "main" ? "主界面" : "应用内打开"}</span>
            </button>
          ))}
        </div>
      )}

      {isCompactAppearanceOpen && (
        <div
          className="compact-submenu animate-fade-in"
          onMouseEnter={() => {
            onSetIsCompactModelOpen(false);
            onSetIsCompactAppearanceOpen(true);
          }}
        >
          <div className="compact-menu__label">紧凑外观</div>
          {appearanceOptions.map((option) =>
            option.id === "character" ? (
              <button
                key={option.id}
                type="button"
                className={`compact-menu__item compact-menu__item--branch ${
                  compactAppearance === option.id ? "compact-menu__item--active" : ""
                }`}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseEnter={() => {
                  onSetIsCompactModelOpen(false);
                  onSetIsCharacterModelOpen(true);
                }}
                onClick={() => {
                  if (compactAppearance !== "character") {
                    onCompactAppearanceChange("character");
                    window.setTimeout(() => {
                      onSetIsCompactMenuOpen(true);
                      onSetIsCompactAppearanceOpen(true);
                      onSetIsCharacterModelOpen(true);
                      onSetCharacterMenuPinned(true);
                    }, 0);
                    return;
                  }
                  onSetIsCharacterModelOpen(true);
                }}
              >
                <span>{option.title}</span>
                <span className="compact-menu__meta">{option.description}</span>
                <span className="compact-menu__arrow">{">"}</span>
              </button>
            ) : (
              <button
                key={option.id}
                type="button"
                className={`compact-menu__item ${compactAppearance === option.id ? "compact-menu__item--active" : ""}`}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseEnter={() => {
                  onSetIsCompactModelOpen(false);
                  onSetIsCharacterModelOpen(false);
                }}
                onClick={() => onCompactAppearanceChange(option.id)}
              >
                <span>{option.title}</span>
                <span className="compact-menu__meta">{option.description}</span>
              </button>
            )
          )}
        </div>
      )}

      {isCompactAppearanceOpen && isCharacterModelOpen && (
        <div
          className="compact-submenu animate-fade-in"
          style={{ left: "calc(100% + 192px)" }}
          onMouseEnter={() => {
            onSetIsCompactModelOpen(false);
            onSetIsCharacterModelOpen(true);
            onSetIsCompactAppearanceOpen(true);
          }}
        >
          <div className="compact-menu__label">角色模型</div>
          {characterModelOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`compact-menu__item ${characterModel === option.id ? "compact-menu__item--active" : ""}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onCharacterModelChange(option.id)}
            >
              <span>{option.title}</span>
              <span className="compact-menu__meta">{option.description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
