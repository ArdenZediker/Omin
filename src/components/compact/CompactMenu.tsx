import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { BasicSettings, ExternalChatEntry } from "../../app/types";
import type { CharacterModel, CompactAppearance } from "../../hooks/useCompactWindowState";
import { omniSmallIconSrc, THEME_MODE_STORAGE_KEY } from "../../app/constants";
import { applyThemeMode, getInitialThemeMode, type ThemeMode } from "../../app/settings";
import { Bot, Check, ChevronRight, Circle, MessageSquareMore, Minimize2, MonitorCog, Moon, Palette, RotateCcw, Settings2, Sun } from "lucide-react";
import anthropicLogoSrc from "@lobehub/icons-static-svg/icons/claude.svg?url";
import baichuanLogoSrc from "@lobehub/icons-static-svg/icons/baichuan.svg?url";
import chatgptLogoSrc from "@lobehub/icons-static-svg/icons/openai.svg?url";
import copilotLogoSrc from "@lobehub/icons-static-svg/icons/copilot.svg?url";
import deepseekLogoSrc from "@lobehub/icons-static-svg/icons/deepseek.svg?url";
import doubaoLogoSrc from "@lobehub/icons-static-svg/icons/doubao.svg?url";
import geminiLogoSrc from "@lobehub/icons-static-svg/icons/gemini.svg?url";
import iflytekcloudLogoSrc from "@lobehub/icons-static-svg/icons/iflytekcloud.svg?url";
import poeLogoSrc from "@lobehub/icons-static-svg/icons/poe.svg?url";
import qwenLogoSrc from "@lobehub/icons-static-svg/icons/qwen.svg?url";
import searchApiLogoSrc from "@lobehub/icons-static-svg/icons/searchapi.svg?url";
import sparkLogoSrc from "@lobehub/icons-static-svg/icons/spark.svg?url";
import yuanbaoLogoSrc from "@lobehub/icons-static-svg/icons/yuanbao.svg?url";
import zhipuLogoSrc from "@lobehub/icons-static-svg/icons/zhipu.svg?url";

const EXTERNAL_CHAT_ICON_MAP = {
  omni: omniSmallIconSrc,
  chatgpt: chatgptLogoSrc,
  claude: anthropicLogoSrc,
  gemini: geminiLogoSrc,
  deepseek: deepseekLogoSrc,
  copilot: copilotLogoSrc,
  poe: poeLogoSrc,
  spark: sparkLogoSrc,
  zhipu: zhipuLogoSrc,
  metaso: searchApiLogoSrc,
  baichuan: baichuanLogoSrc,
  qwen: qwenLogoSrc,
  yuanbao: yuanbaoLogoSrc,
  doubao: doubaoLogoSrc,
  iflytekcloud: iflytekcloudLogoSrc,
} as const;

const ENTRY_GROUP_LABELS: Record<"common" | "domestic", string> = {
  common: "通用",
  domestic: "国内",
};

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
  compactMenuSide: "left" | "right";
  compactSubmenuSide: "left" | "right";
  followCursorScreen: boolean;
  onCharacterModelChange: (model: CharacterModel) => void;
  onCompactAppearanceChange: (appearance: CompactAppearance) => void;
  onOpenExternalChat: (entry: ExternalChatEntry) => void | Promise<void>;
  onOpenSettingsFromCompact: () => void | Promise<void>;
  onScaleReset: () => void;
  onUpdateBasicSettings: (patch: Partial<BasicSettings>) => void;
  onSetCharacterMenuPinned: Dispatch<SetStateAction<boolean>>;
  onSetIsCharacterModelOpen: Dispatch<SetStateAction<boolean>>;
  onSetIsCompactAppearanceOpen: Dispatch<SetStateAction<boolean>>;
  onSetIsCompactMenuOpen: Dispatch<SetStateAction<boolean>>;
  onSetIsCompactModelOpen: Dispatch<SetStateAction<boolean>>;
};

function MenuLeadingIcon({ children }: { children: ReactNode }) {
  return (
    <span className="compact-menu__leading-icon" aria-hidden="true">
      {children}
    </span>
  );
}

export default function CompactMenu({
  appearanceOptions,
  characterMenuPosition,
  characterModelOptions,
  characterScale,
  compactAppearance,
  entries,
  isCharacterAppearance: _isCharacterAppearance,
  isCharacterModelOpen: _isCharacterModelOpen,
  isCompactAppearanceOpen,
  isCompactModelOpen,
  compactMenuSide,
  compactSubmenuSide,
  followCursorScreen,
  onCharacterModelChange,
  onCompactAppearanceChange,
  onOpenExternalChat,
  onOpenSettingsFromCompact,
  onScaleReset,
  onUpdateBasicSettings,
  onSetCharacterMenuPinned,
  onSetIsCharacterModelOpen: _onSetIsCharacterModelOpen,
  onSetIsCompactAppearanceOpen,
  onSetIsCompactMenuOpen: _onSetIsCompactMenuOpen,
  onSetIsCompactModelOpen,
}: CompactMenuProps) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getInitialThemeMode(THEME_MODE_STORAGE_KEY));
  const [isThemeOpen, setIsThemeOpen] = useState(false);

  const menuPositionStyle =
    characterMenuPosition && typeof window !== "undefined"
      ? {
          position: "fixed" as const,
          left: Math.max(8, characterMenuPosition.x),
          top: Math.max(8, characterMenuPosition.y),
        }
      : undefined;

  const switchThemeMode = (mode: ThemeMode) => {
    setThemeMode(mode);
    applyThemeMode(THEME_MODE_STORAGE_KEY, mode);
  };

  const resolveAppearanceIcon = (appearance: CompactAppearance) => {
    if (appearance === "default") return <Circle className="compact-menu__icon" />;
    if (appearance === "compact") return <Minimize2 className="compact-menu__icon" />;
    if (appearance === "large") return <MonitorCog className="compact-menu__icon" />;
    return <Bot className="compact-menu__icon" />;
  };

  return (
    <div
      className={`compact-menu animate-fade-in compact-menu--${compactMenuSide} ${
        characterMenuPosition ? "compact-menu--cursor" : ""
      }`}
      style={menuPositionStyle}
    >
      <div className="compact-menu__section">
        <button
          type="button"
          className="compact-menu__item compact-menu__item--branch"
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={() => {
            onSetIsCompactModelOpen(true);
            onSetIsCompactAppearanceOpen(false);
            setIsThemeOpen(false);
          }}
        >
          <span className="compact-menu__item-main">
            <MenuLeadingIcon>
              <MessageSquareMore className="compact-menu__icon" />
            </MenuLeadingIcon>
            <span>聊天入口</span>
          </span>
          <ChevronRight className="compact-menu__arrow-icon" aria-hidden="true" />
        </button>

        <button
          type="button"
          className="compact-menu__item compact-menu__item--branch"
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={() => {
            onSetIsCompactModelOpen(false);
            onSetIsCompactAppearanceOpen(true);
            setIsThemeOpen(false);
          }}
        >
          <span className="compact-menu__item-main">
            <MenuLeadingIcon>
              <Palette className="compact-menu__icon" />
            </MenuLeadingIcon>
            <span>界面外观</span>
          </span>
          <ChevronRight className="compact-menu__arrow-icon" aria-hidden="true" />
        </button>

        <button
          type="button"
          className="compact-menu__item compact-menu__item--branch"
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={() => {
            onSetIsCompactModelOpen(false);
            onSetIsCompactAppearanceOpen(false);
            setIsThemeOpen(true);
          }}
        >
          <span className="compact-menu__item-main">
            <MenuLeadingIcon>
              <MonitorCog className="compact-menu__icon" />
            </MenuLeadingIcon>
            <span>主题切换</span>
          </span>
          <ChevronRight className="compact-menu__arrow-icon" aria-hidden="true" />
        </button>

        <div className="compact-menu__divider" aria-hidden="true" />

        <button
          type="button"
          className="compact-menu__item compact-menu__item--toggle compact-menu__item--toggle-only"
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={() => {
            onSetIsCompactModelOpen(false);
            onSetIsCompactAppearanceOpen(false);
            setIsThemeOpen(false);
          }}
          onClick={() => {
            onUpdateBasicSettings({ followCursorScreen: !followCursorScreen });
          }}
          aria-pressed={followCursorScreen}
        >
          <span className="compact-menu__item-main">
            <span className={`compact-menu__check ${followCursorScreen ? "compact-menu__check--checked" : ""}`} aria-hidden="true">
              {followCursorScreen ? <Check className="compact-menu__check-icon" /> : null}
            </span>
            <span>鼠标随航</span>
          </span>
        </button>

        {compactAppearance === "character" && (
          <button
            type="button"
            className="compact-menu__item"
            onMouseDown={(e) => e.stopPropagation()}
            onMouseEnter={() => {
              onSetIsCompactModelOpen(false);
              onSetIsCompactAppearanceOpen(false);
              setIsThemeOpen(false);
            }}
            onClick={onScaleReset}
          >
            <span className="compact-menu__item-main">
              <MenuLeadingIcon>
                <RotateCcw className="compact-menu__icon" />
              </MenuLeadingIcon>
              <span>重置缩放</span>
            </span>
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
            setIsThemeOpen(false);
          }}
          onClick={() => {
            void onOpenSettingsFromCompact();
          }}
        >
          <span className="compact-menu__item-main">
            <MenuLeadingIcon>
              <Settings2 className="compact-menu__icon" />
            </MenuLeadingIcon>
            <span>设置</span>
          </span>
        </button>
      </div>

      {isCompactModelOpen && (
        <div
          className={`compact-submenu compact-submenu--${compactSubmenuSide} animate-fade-in`}
          onMouseEnter={() => {
            onSetIsCompactModelOpen(true);
            onSetIsCompactAppearanceOpen(false);
            setIsThemeOpen(false);
          }}
        >
          <div className="compact-menu__label">聊天入口</div>
          {(["common", "domestic"] as const).map((group) => {
            const groupEntries = entries.filter((entry) => entry.group === group);
            if (groupEntries.length === 0) {
              return null;
            }

            return (
              <div key={group} className="compact-menu__group">
                <div className="compact-menu__group-label">{ENTRY_GROUP_LABELS[group]}</div>
                {groupEntries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="compact-menu__item"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      void onOpenExternalChat(entry);
                    }}
                  >
                    <span className="compact-menu__entry">
                      <img className="compact-menu__entry-icon" src={EXTERNAL_CHAT_ICON_MAP[entry.icon]} alt="" aria-hidden="true" />
                      <span>{entry.title}</span>
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {isCompactAppearanceOpen && (
        <div
          className={`compact-submenu compact-submenu--${compactSubmenuSide} animate-fade-in`}
          onMouseEnter={() => {
            onSetIsCompactModelOpen(false);
            onSetIsCompactAppearanceOpen(true);
            setIsThemeOpen(false);
          }}
        >
          <div className="compact-menu__label">外观设置</div>
          {appearanceOptions.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`compact-menu__item ${compactAppearance === option.id ? "compact-menu__item--active" : ""}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                onCompactAppearanceChange(option.id);
                if (option.id === "character" && characterModelOptions[0]) {
                  onCharacterModelChange(characterModelOptions[0].id);
                  onSetCharacterMenuPinned(false);
                }
              }}
            >
              <span className="compact-menu__item-main">
                <MenuLeadingIcon>{resolveAppearanceIcon(option.id)}</MenuLeadingIcon>
                <span>{option.title}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {isThemeOpen && (
        <div
          className={`compact-submenu compact-submenu--${compactSubmenuSide} animate-fade-in`}
          onMouseEnter={() => {
            onSetIsCompactModelOpen(false);
            onSetIsCompactAppearanceOpen(false);
            setIsThemeOpen(true);
          }}
        >
          <div className="compact-menu__label">主题切换</div>
          <button
            type="button"
            className={`compact-menu__item ${themeMode === "auto" ? "compact-menu__item--active" : ""}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => switchThemeMode("auto")}
          >
            <span className="compact-menu__item-main">
              <span className={`compact-menu__check ${themeMode === "auto" ? "compact-menu__check--checked" : ""}`} aria-hidden="true">
                {themeMode === "auto" ? <Check className="compact-menu__check-icon" /> : null}
              </span>
              <MenuLeadingIcon>
                <MonitorCog className="compact-menu__icon" />
              </MenuLeadingIcon>
              <span>自动</span>
            </span>
          </button>
          <button
            type="button"
            className={`compact-menu__item ${themeMode === "light" ? "compact-menu__item--active" : ""}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => switchThemeMode("light")}
          >
            <span className="compact-menu__item-main">
              <span className={`compact-menu__check ${themeMode === "light" ? "compact-menu__check--checked" : ""}`} aria-hidden="true">
                {themeMode === "light" ? <Check className="compact-menu__check-icon" /> : null}
              </span>
              <MenuLeadingIcon>
                <Sun className="compact-menu__icon" />
              </MenuLeadingIcon>
              <span>明亮</span>
            </span>
          </button>
          <button
            type="button"
            className={`compact-menu__item ${themeMode === "dark" ? "compact-menu__item--active" : ""}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => switchThemeMode("dark")}
          >
            <span className="compact-menu__item-main">
              <span className={`compact-menu__check ${themeMode === "dark" ? "compact-menu__check--checked" : ""}`} aria-hidden="true">
                {themeMode === "dark" ? <Check className="compact-menu__check-icon" /> : null}
              </span>
              <MenuLeadingIcon>
                <Moon className="compact-menu__icon" />
              </MenuLeadingIcon>
              <span>暗黑</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
