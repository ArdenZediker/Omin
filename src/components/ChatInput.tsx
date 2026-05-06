import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bot,
  CirclePlus,
  Eraser,
  GitCompare,
  Languages,
  LibraryBig,
  ListCollapse,
  MessageCircleQuestion,
  Paperclip,
  Pencil,
  PencilLine,
  Pin,
  Settings,
  Square,
  TimerReset,
  X,
} from "lucide-react";
import { buildSlashDraft, getMatchingSlashSuggestions, LOCAL_SLASH_COMMANDS, type SlashSuggestion } from "../chat/skills";
import { SKILL_MANIFESTS } from "../config/manifests/skills";

interface ChatInputProps {
  canStartNewTopic?: boolean;
  hasConversation?: boolean;
  usageLabel?: string | null;
  contextPresetText?: string;
  onCreateScheduledTask?: (input: {
    title: string;
    prompt: string;
    cron: string;
    target: "desktop" | "notification" | "session";
  }) => void;
  onStartNewTopic?: () => void;
  onSend: (content: string, images?: string[]) => void;
  isLoading: boolean;
  onStop: () => void;
  focusSignal?: number;
  draftValue?: string;
  draftImages?: string[];
  draftSignal?: number;
}

const LOCAL_COMMAND_ICON_MAP: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  new: CirclePlus,
  clear: Eraser,
  settings: Settings,
  model: Bot,
  rename: Pencil,
  pin: Pin,
};

const SKILL_ICON_MAP: Record<string, React.ComponentType<{ size?: number; strokeWidth?: number }>> = {
  summarize: ListCollapse,
  translate: Languages,
  rewrite: PencilLine,
  explain: MessageCircleQuestion,
  compare: GitCompare,
};

function SuggestionIcon({ suggestion }: { suggestion: SlashSuggestion }) {
  const Icon =
    suggestion.kind === "local"
      ? (LOCAL_COMMAND_ICON_MAP[suggestion.id] ?? CirclePlus)
      : (SKILL_ICON_MAP[suggestion.id] ?? MessageCircleQuestion);

  return <Icon size={16} strokeWidth={1.8} />;
}

export default function ChatInput({
  canStartNewTopic = false,
  hasConversation = false,
  usageLabel,
  contextPresetText,
  onCreateScheduledTask,
  onStartNewTopic,
  onSend,
  isLoading,
  onStop,
  focusSignal,
  draftValue,
  draftImages,
  draftSignal,
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [activePopover, setActivePopover] = useState<"mode" | "knowledge" | "timer" | null>(null);
  const [timerPreset, setTimerPreset] = useState<"daily" | "hourly" | "workday">("daily");
  const [contextSelection, setContextSelection] = useState({
    session: true,
    memory: true,
    favorites: false,
    workspace: false,
  });
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const matchedSuggestions = getMatchingSlashSuggestions(input);
  const localSuggestions = matchedSuggestions.filter((suggestion) => suggestion.kind === "local");
  const skillSuggestions = matchedSuggestions.filter((suggestion) => suggestion.kind === "skill");

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 280)}px`;
    }
  }, [input]);

  useEffect(() => {
    if (typeof focusSignal === "number") {
      textareaRef.current?.focus();
    }
  }, [focusSignal]);

  useEffect(() => {
    if (typeof draftSignal === "number" && typeof draftValue === "string") {
      setInput(draftValue);
      setImages(draftImages ?? []);
      textareaRef.current?.focus();
    }
  }, [draftImages, draftSignal, draftValue]);

  useEffect(() => {
    if (!activePopover) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (composerRef.current?.contains(target)) {
        return;
      }
      setActivePopover(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [activePopover]);

  const handleSubmit = () => {
    if ((!input.trim() && images.length === 0) || isLoading) {
      return;
    }

    const contextLines = [];
    if (contextSelection.session) contextLines.push("- 当前话题历史");
    if (contextSelection.memory) contextLines.push("- 助手记忆");
    if (contextSelection.favorites) contextLines.push("- 收藏话题");
    if (contextSelection.workspace) contextLines.push("- 工作区文件");

    const finalContent =
      contextLines.length > 0 && contextPresetText
        ? `【上下文要求】\n请优先结合以下来源回答：\n${contextLines.join("\n")}\n\n【可用上下文】\n${contextPresetText}\n\n【用户问题】\n${input.trim()}`
        : input.trim();

    onSend(finalContent, images.length > 0 ? images : undefined);
    setInput("");
    setImages([]);
    setActivePopover(null);
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const appendImageFiles = async (files: File[]) => {
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }

    const nextImages = await Promise.all(
      imageFiles.map(
        (file) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (readerEvent) => resolve(readerEvent.target?.result as string);
            reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
            reader.readAsDataURL(file);
          })
      )
    );

    setImages((prev) => [...prev, ...nextImages]);
  };

  const handlePaste = (event: React.ClipboardEvent) => {
    const items = event.clipboardData.items;
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          void appendImageFiles([blob]);
        }
        break;
      }
    }
  };

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length > 0) {
      await appendImageFiles(files);
    }
    event.target.value = "";
  };

  const activeContextChips = [
    contextSelection.session ? "当前话题" : null,
    contextSelection.memory ? "助手记忆" : null,
    contextSelection.favorites ? "收藏话题" : null,
    contextSelection.workspace ? "工作区文件" : null,
  ].filter(Boolean) as string[];

  const activeSlashCommand = input.trim().startsWith("/") ? input.trim().split(/\s+/)[0].toLowerCase() : "";
  const activeLocalCommand = LOCAL_SLASH_COMMANDS.find((item) => item.command === activeSlashCommand) ?? null;
  const activeSkillCommand = SKILL_MANIFESTS.find((item) => item.command === activeSlashCommand) ?? null;
  const activeModeLabel = activeLocalCommand?.title ?? activeSkillCommand?.title ?? null;
  const activeModeTypeLabel = activeLocalCommand ? "工具模式" : activeSkillCommand ? "技能模式" : null;
  const hasComposerStatus = Boolean(activeModeLabel || activeContextChips.length > 0 || images.length > 0);

  const timerPresetOptions = {
    daily: { label: "每天 09:00", cron: "0 9 * * *" },
    hourly: { label: "每小时", cron: "0 * * * *" },
    workday: { label: "工作日 09:00", cron: "0 9 * * 1-5" },
  } as const;

  return (
    <div ref={composerRef} className="chat-composer">
      {matchedSuggestions.length > 0 && (
        <div className="chat-composer__skills">
          {localSuggestions.length > 0 && (
            <div className="chat-composer__skills-group">
              <div className="chat-composer__skills-group-title">命令</div>
              {localSuggestions.map((suggestion) => (
                <button
                  key={`${suggestion.kind}-${suggestion.id}`}
                  type="button"
                  className="chat-composer__skill"
                  onClick={() => {
                    setInput(buildSlashDraft(suggestion));
                    textareaRef.current?.focus();
                  }}
                >
                  <span className="chat-composer__skill-icon" aria-hidden="true">
                    <SuggestionIcon suggestion={suggestion} />
                  </span>
                  <span className="chat-composer__skill-command">{suggestion.command}</span>
                  <span className="chat-composer__skill-description">{suggestion.description}</span>
                </button>
              ))}
            </div>
          )}

          {skillSuggestions.length > 0 && (
            <div className="chat-composer__skills-group">
              <div className="chat-composer__skills-group-title">技能</div>
              {skillSuggestions.map((suggestion) => (
                <button
                  key={`${suggestion.kind}-${suggestion.id}`}
                  type="button"
                  className="chat-composer__skill"
                  onClick={() => {
                    setInput(buildSlashDraft(suggestion));
                    textareaRef.current?.focus();
                  }}
                >
                  <span className="chat-composer__skill-icon" aria-hidden="true">
                    <SuggestionIcon suggestion={suggestion} />
                  </span>
                  <span className="chat-composer__skill-command">{suggestion.command}</span>
                  <span className="chat-composer__skill-description">{suggestion.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {images.length > 0 && (
        <div className="chat-composer__attachments">
          {images.map((img, index) => (
            <div key={index} className="relative group">
              <img src={img} alt="图片附件" className="w-12 h-12 rounded-lg object-cover border border-white/10" />
              <button
                onClick={() => setImages((prev) => prev.filter((_, imageIndex) => imageIndex !== index))}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500/80 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                title="移除图片"
                type="button"
              >
                <X size={10} strokeWidth={2.2} />
              </button>
            </div>
          ))}
        </div>
      )}

      {hasComposerStatus && (
        <div className="chat-composer__status">
          {activeModeLabel && activeModeTypeLabel && (
            <button
              type="button"
              className="chat-composer__status-chip"
              onClick={() => {
                setInput((current) => current.replace(/^\/\S+\s*/, ""));
                textareaRef.current?.focus();
              }}
              title="清除当前模式"
            >
                <Bot size={13} strokeWidth={1.9} />
                <span>{activeModeTypeLabel}：{activeModeLabel}</span>
                <X size={12} strokeWidth={2} />
            </button>
          )}

          {activeContextChips.length > 0 && (
            <button
              type="button"
              className="chat-composer__status-chip"
              onClick={() => setActivePopover("knowledge")}
              title="查看上下文来源"
            >
              <LibraryBig size={13} strokeWidth={1.9} />
              <span>上下文：{activeContextChips.join(" / ")}</span>
            </button>
          )}

          {images.length > 0 && (
            <button
              type="button"
              className="chat-composer__status-chip"
              onClick={() => fileInputRef.current?.click()}
              title="继续添加图片"
            >
              <Paperclip size={13} strokeWidth={1.9} />
              <span>附件：{images.length} 张图片</span>
            </button>
          )}
        </div>
      )}

      <div className="chat-composer__panel">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            void handleFileSelect(event);
          }}
        />
        <div className="chat-composer__toolbar">
          <div className="chat-composer__toolbar-group">
            <div className="chat-composer__tool-dropdown">
              <button
                type="button"
                className={`chat-composer__tool-button ${activePopover === "mode" ? "chat-composer__tool-button--active" : ""}`}
                title="对话模式"
                onClick={() => setActivePopover((current) => (current === "mode" ? null : "mode"))}
              >
                <Bot size={16} strokeWidth={1.8} />
              </button>
              {activePopover === "mode" && (
                <div className="chat-composer__context-menu">
                  <div className="chat-composer__context-menu-title">发送方式</div>
                  <button
                    type="button"
                    className="chat-composer__mode-option"
                      onClick={() => {
                        setInput((current) => current.replace(/^\/\S+\s*/, ""));
                        setActivePopover(null);
                        textareaRef.current?.focus();
                      }}
                  >
                    <span className="chat-composer__mode-option-title">普通聊天</span>
                    <span className="chat-composer__mode-option-desc">直接发送当前问题</span>
                  </button>
                  <button
                    type="button"
                    className="chat-composer__mode-option"
                      onClick={() => {
                        setInput("/analyze_files ");
                        setActivePopover(null);
                        textareaRef.current?.focus();
                      }}
                  >
                    <span className="chat-composer__mode-option-title">工具分析</span>
                    <span className="chat-composer__mode-option-desc">预填文件分析命令</span>
                  </button>
                  {SKILL_MANIFESTS.map((skill) => (
                    <button
                      key={skill.id}
                      type="button"
                      className="chat-composer__mode-option"
                      onClick={() => {
                        setInput(buildSlashDraft({ command: skill.command }));
                        setActivePopover(null);
                        textareaRef.current?.focus();
                      }}
                    >
                      <span className="chat-composer__mode-option-title">{skill.title}</span>
                      <span className="chat-composer__mode-option-desc">{skill.description}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className="chat-composer__tool-button"
              title="上传图片"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={16} strokeWidth={1.8} />
            </button>
            <div className="chat-composer__tool-dropdown">
              <button
                type="button"
                className={`chat-composer__tool-button ${activePopover === "knowledge" ? "chat-composer__tool-button--active" : ""}`}
                title="上下文来源"
                onClick={() => setActivePopover((current) => (current === "knowledge" ? null : "knowledge"))}
              >
                <LibraryBig size={16} strokeWidth={1.8} />
              </button>
              {activePopover === "knowledge" && (
                <div className="chat-composer__context-menu">
                  <div className="chat-composer__context-menu-title">本次回答引用</div>
                  <label className="chat-composer__context-option">
                    <input
                      type="checkbox"
                      checked={contextSelection.session}
                      onChange={(event) => setContextSelection((current) => ({ ...current, session: event.target.checked }))}
                    />
                    <span>当前话题历史</span>
                  </label>
                  <label className="chat-composer__context-option">
                    <input
                      type="checkbox"
                      checked={contextSelection.memory}
                      onChange={(event) => setContextSelection((current) => ({ ...current, memory: event.target.checked }))}
                    />
                    <span>助手记忆</span>
                  </label>
                  <label className="chat-composer__context-option">
                    <input
                      type="checkbox"
                      checked={contextSelection.favorites}
                      onChange={(event) => setContextSelection((current) => ({ ...current, favorites: event.target.checked }))}
                    />
                    <span>收藏话题</span>
                  </label>
                  <label className="chat-composer__context-option">
                    <input
                      type="checkbox"
                      checked={contextSelection.workspace}
                      onChange={(event) => setContextSelection((current) => ({ ...current, workspace: event.target.checked }))}
                    />
                    <span>工作区文件</span>
                  </label>
                </div>
              )}
            </div>
            <div className="chat-composer__tool-dropdown">
              <button
                type="button"
                className={`chat-composer__tool-button ${activePopover === "timer" ? "chat-composer__tool-button--active" : ""}`}
                title="定时任务"
                onClick={() => setActivePopover((current) => (current === "timer" ? null : "timer"))}
              >
                <TimerReset size={16} strokeWidth={1.8} />
              </button>
              {activePopover === "timer" && (
                <div className="chat-composer__context-menu">
                  <div className="chat-composer__context-menu-title">快速创建任务</div>
                  {(Object.entries(timerPresetOptions) as Array<[keyof typeof timerPresetOptions, (typeof timerPresetOptions)[keyof typeof timerPresetOptions]]>).map(
                    ([key, option]) => (
                      <button
                        key={key}
                        type="button"
                        className="chat-composer__mode-option"
                        onClick={() => {
                          setTimerPreset(key);
                        }}
                      >
                        <span className="chat-composer__mode-option-title">{option.label}</span>
                        <span className="chat-composer__mode-option-desc">{option.cron}</span>
                      </button>
                    )
                  )}
                  <button
                    type="button"
                    className="chat-composer__mode-option"
                      onClick={() => {
                        if (!onCreateScheduledTask || !input.trim()) {
                          return;
                      }
                      const selected = timerPresetOptions[timerPreset];
                        onCreateScheduledTask({
                          title: `快速任务 ${selected.label}`,
                          prompt: input.trim(),
                          cron: selected.cron,
                          target: "desktop",
                        });
                        setActivePopover(null);
                      }}
                  >
                    <span className="chat-composer__mode-option-title">保存当前输入为任务</span>
                    <span className="chat-composer__mode-option-desc">使用上方选中的执行频率</span>
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="chat-composer__toolbar-badge">{usageLabel ?? "--"}</div>
          <div className="chat-composer__toolbar-group chat-composer__toolbar-group--right">
            <button type="button" className="chat-composer__tool-button" title="布局">
              <CirclePlus size={16} strokeWidth={1.8} />
            </button>
            <button type="button" className="chat-composer__tool-button" title="展开">
              <ArrowRight size={16} strokeWidth={1.8} className="chat-composer__tool-button-arrow" />
            </button>
          </div>
        </div>

        <div className="chat-composer__editor">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="输入聊天内容..."
            className="chat-composer__textarea hide-scrollbar"
            rows={1}
            disabled={isLoading}
          />
        </div>

        <div className="chat-composer__footer">
          <div className="chat-composer__footer-hint">↵ 发送 / Shift + ↵ 换行</div>
          <div className="chat-composer__footer-actions">
            {canStartNewTopic && hasConversation ? (
              <button
                type="button"
                className="chat-composer__aux-button chat-composer__aux-button--topic"
                title="开启新话题"
                onClick={onStartNewTopic}
              >
                <CirclePlus size={16} strokeWidth={1.8} />
                <span>新话题</span>
              </button>
            ) : (
              <button type="button" className="chat-composer__aux-button" title="工具箱">
                <LibraryBig size={16} strokeWidth={1.8} />
              </button>
            )}
            {isLoading ? (
              <button onClick={onStop} className="chat-composer__submit chat-composer__submit--stop" title="停止生成" type="button">
                <Square className="w-4 h-4" fill="currentColor" strokeWidth={1.8} />
              </button>
            ) : (
              <button onClick={handleSubmit} disabled={!input.trim() && images.length === 0} className="chat-composer__submit" title="发送消息" type="button">
                <span>发送</span>
                <ArrowRight className="chat-composer__submit-icon" strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
