import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { BasicSettings, ExternalChatEntry } from "../../app/types";
import type { CharacterModel, CompactAppearance } from "../../hooks/useCompactWindowState";
import { omniSmallIconSrc } from "../../app/constants";
import { Check, ChevronRight, MessageSquareMore, Palette, RotateCcw, Settings2 } from "lucide-react";
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
  characterModel,
  characterModelOptions,
  characterScale,
  compactAppearance,
  entries,
  isCharacterAppearance,
  isCharacterModelOpen,
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
  onSetIsCharacterModelOpen,
  onSetIsCompactAppearanceOpen,
  onSetIsCompactMenuOpen,
  onSetIsCompactModelOpen,
}: CompactMenuProps) {
  const hasMultipleCharacterModels = characterModelOptions.length > 1;
  const menuPositionStyle =
    characterMenuPosition && typeof window !== "undefined"
      ? {
          position: "fixed" as const,
          left: Math.max(8, characterMenuPosition.x),
          top: Math.max(8, characterMenuPosition.y),
        }
      : undefined;

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
            onSetIsCharacterModelOpen(false);
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
            onSetIsCharacterModelOpen(false);
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

        <div className="compact-menu__divider" aria-hidden="true" />

        <button
          type="button"
          className="compact-menu__item compact-menu__item--toggle compact-menu__item--toggle-only"
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={() => {
            onSetIsCompactModelOpen(false);
            onSetIsCompactAppearanceOpen(false);
            onSetIsCharacterModelOpen(false);
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
            onSetIsCharacterModelOpen(false);
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
          className={`compact-submenu compact-submenu--fit compact-submenu--${compactSubmenuSide} animate-fade-in`}
          onMouseEnter={() => {
            onSetIsCompactModelOpen(true);
            onSetIsCompactAppearanceOpen(false);
            onSetIsCharacterModelOpen(false);
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
                    className="compact-menu__item compact-menu__item--submenu"
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
          className={`compact-submenu compact-submenu--fit compact-submenu--${compactSubmenuSide} animate-fade-in`}
          onMouseEnter={() => {
            onSetIsCompactModelOpen(false);
            onSetIsCompactAppearanceOpen(true);
          }}
        >
          {appearanceOptions.map((option) =>
            option.id === "character" && hasMultipleCharacterModels ? (
              <div key={option.id} className="compact-menu__branch">
                <button
                  type="button"
                  className={`compact-menu__item compact-menu__item--submenu compact-menu__item--branch ${
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
                  <ChevronRight className="compact-menu__arrow-icon" aria-hidden="true" />
                </button>

                {isCharacterModelOpen && (
                  <div
                    className={`compact-submenu compact-submenu--fit compact-submenu--${compactSubmenuSide} compact-submenu--nested animate-fade-in`}
                    onMouseEnter={() => {
                      onSetIsCompactModelOpen(false);
                      onSetIsCharacterModelOpen(true);
                      onSetIsCompactAppearanceOpen(true);
                    }}
                  >
                    <div className="compact-menu__label">角色模型</div>
                    {characterModelOptions.map((modelOption) => (
                      <button
                        key={modelOption.id}
                        type="button"
                        className={`compact-menu__item compact-menu__item--submenu ${
                          characterModel === modelOption.id ? "compact-menu__item--active" : ""
                        }`}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={() => onCharacterModelChange(modelOption.id)}
                      >
                        <span>{modelOption.title}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button
                key={option.id}
                type="button"
                className={`compact-menu__item compact-menu__item--submenu compact-menu__item--simple ${
                  compactAppearance === option.id ? "compact-menu__item--active" : ""
                }`}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseEnter={() => {
                  onSetIsCompactModelOpen(false);
                  onSetIsCharacterModelOpen(false);
                }}
                onClick={() => onCompactAppearanceChange(option.id)}
              >
                <span>{option.title}</span>
              </button>
            )
          )}
        </div>
      )}

    </div>
  );
}
