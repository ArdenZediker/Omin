import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { BasicSettings } from "../../app/types";
import {
  DEFAULT_LIGHT_THEME_CONFIG,
  DEFAULT_THEME_CONFIG,
  THEME_PRESET_LABELS,
  THEME_PRESETS,
  type ThemeConfig,
  type ThemeMode,
  type ThemeSettings,
  type ThemeVariant,
} from "../../app/settings";
import {
  HAS_OS_FILE_SANDBOX,
  IS_MACOS_PLATFORM,
  IS_WINDOWS_PLATFORM,
} from "../../app/platform";
import { modelRegistry } from "../../adapters/registry";
import { requestConfirmation } from "../../chat/confirmationGate";
import OmniSelect from "../ui/OmniSelect";
import OmniSwitch from "../ui/OmniSwitch";
import { Check, Clipboard, Download } from "lucide-react";

const IS_WINDOWS = IS_WINDOWS_PLATFORM;

// 常见 Shell 可执行文件路径示例：点按回填到 Shell 路径输入框。
const WINDOWS_SHELL_EXAMPLES: Array<{ label: string; path: string }> = [
  { label: "Git-Bash", path: "C:\\Program Files\\Git\\bin\\bash.exe" },
  { label: "MSYS2", path: "C:\\msys64\\usr\\bin\\bash.exe" },
  { label: "Cygwin", path: "C:\\cygwin64\\bin\\bash.exe" },
  { label: "WSL", path: "C:\\Windows\\System32\\wsl.exe" },
  { label: "busybox", path: "C:\\tools\\busybox.exe" },
  { label: "PowerShell 7", path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
];
const UNIX_SHELL_EXAMPLES: Array<{ label: string; path: string }> = [
  { label: "zsh", path: "/bin/zsh" },
  { label: "bash", path: "/bin/bash" },
  { label: "sh", path: "/bin/sh" },
];
const SHELL_EXAMPLES = IS_WINDOWS ? WINDOWS_SHELL_EXAMPLES : UNIX_SHELL_EXAMPLES;

type Props = {
  basicSettings: BasicSettings;
  themeMode: ThemeMode;
  onChangeThemeMode: (mode: ThemeMode) => void;
  themeConfig: ThemeConfig;
  themeSettings: ThemeSettings;
  onChangeThemeSettings: (settings: ThemeSettings) => void;
  onUpdateBasicSettings: (patch: Partial<BasicSettings>) => void;
  onCaptureShortcut: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    keyName: keyof Pick<BasicSettings, "openMainShortcut" | "switchPreviousModelShortcut">
  ) => void;
  onStartShortcutCapture: (keyName: keyof Pick<BasicSettings, "openMainShortcut" | "switchPreviousModelShortcut">) => void;
  onCancelShortcutCapture: () => void;
  recordingShortcut: "openMainShortcut" | "switchPreviousModelShortcut" | null;
  /** 「打开主界面」全局热键的注册结果反馈（设置页注册后回填）。 */
  openMainShortcutNotice?: { kind: "ok" | "error"; text: string } | null;
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="omni-settings-form-row grid grid-cols-[120px_1fr] gap-4">
      <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">{label}</label>
      {children}
    </div>
  );
}

function Actions({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="omni-settings-form-row grid grid-cols-[120px_1fr] gap-4">
      <span className="pt-1 text-right text-sm text-slate-700">{label}</span>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "auto", label: "自动" },
  { value: "light", label: "明亮" },
  { value: "dark", label: "暗黑" },
];

function ThemePreview({ mode }: { mode: ThemeMode }) {
  return (
    <span className={`omni-theme-preview omni-theme-preview--${mode}`} aria-hidden="true">
      <span className="omni-theme-preview__rail" />
      <span className="omni-theme-preview__window">
        <span className="omni-theme-preview__window-top" />
        <span className="omni-theme-preview__lines">
          <span />
          <span />
          <span />
        </span>
        <span className="omni-theme-preview__dot" />
      </span>
    </span>
  );
}

function ThemePicker({ mode, onChange }: { mode: ThemeMode; onChange: (next: ThemeMode) => void }) {
  return (
    <div className="omni-theme-picker" role="radiogroup" aria-label="主题模式">
      {THEME_OPTIONS.map((option, index) => {
        const selected = mode === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            aria-label={option.label}
            title={option.label}
            className={`omni-theme-picker__option${selected ? " omni-theme-picker__option--selected" : ""}`}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
              event.preventDefault();
              const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
              const nextIndex = (index + direction + THEME_OPTIONS.length) % THEME_OPTIONS.length;
              onChange(THEME_OPTIONS[nextIndex].value);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>("[role='radio']")
                .item(nextIndex)
                ?.focus();
            }}
          >
            <ThemePreview mode={option.value} />
            <span className="omni-theme-picker__label">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function ThemeColorRow({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [draft, setDraft] = useState(value.toUpperCase());
  useEffect(() => setDraft(value.toUpperCase()), [value]);
  const commit = (next: string) => {
    setDraft(next.toUpperCase());
    if (/^#[\da-f]{6}$/i.test(next)) onChange(next.toLowerCase());
  };
  return (
    <div className="omni-theme-config__row">
      <span className="omni-theme-config__label">{label}</span>
      <div className="omni-theme-config__control">
        <input aria-label={`${label}颜色`} className="omni-theme-config__color" type="color" value={value} onChange={(event) => commit(event.target.value)} />
        <input
          aria-label={`${label}HEX值`}
          className={`omni-theme-config__hex${/^#[\da-f]{6}$/i.test(draft) ? "" : " omni-theme-config__hex--invalid"}`}
          value={draft}
          maxLength={7}
          onChange={(event) => commit(event.target.value)}
          onBlur={() => setDraft(value.toUpperCase())}
        />
      </div>
    </div>
  );
}

function ThemeSwatch({ themeId, config }: { themeId: string; config?: ThemeConfig }) {
  const theme = config?.theme ?? THEME_PRESETS[themeId]?.theme ?? DEFAULT_THEME_CONFIG.theme;
  return (
    <span
      className="omni-select__icon omni-theme-swatch"
      aria-hidden="true"
      style={{
        "--swatch-accent": theme.accent,
        "--swatch-surface": theme.surface,
        "--swatch-ink": theme.ink,
      } as React.CSSProperties}
    >
      <span className="omni-theme-swatch__glyph">Aa</span>
    </span>
  );
}

function ThemeConfigPanel({ config, variant, label, onChange }: {
  config: ThemeConfig;
  variant: ThemeVariant;
  label?: string;
  onChange: (config: ThemeConfig) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [fontsLoading, setFontsLoading] = useState(true);
  const theme = config.theme;
  useEffect(() => {
    let cancelled = false;
    void invoke<string[]>("list_system_fonts")
      .then((fonts) => {
        if (!cancelled) setSystemFonts(fonts);
      })
      .catch(() => {
        if (!cancelled) setSystemFonts(["Arial", "Cascadia Code", "Consolas", "Inter", "JetBrains Mono", "Microsoft YaHei", "Noto Sans SC Variable", "Segoe UI"]);
      })
      .finally(() => {
        if (!cancelled) setFontsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const updateTheme = (patch: Partial<ThemeConfig["theme"]>) => onChange({ ...config, theme: { ...theme, ...patch } });
  const updateColor = (key: "accent" | "surface" | "ink", value: string) => {
    if (!/^#[\da-f]{6}$/i.test(value)) return;
    updateTheme({ [key]: value.toLowerCase(), ...(key === "accent" ? { accentSource: "custom" as const } : {}) });
  };
  const copyConfig = async () => {
    const value = `codex-theme-v1:${JSON.stringify(config)}`;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  const downloadConfig = () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${config.codeThemeId || "omni-theme"}.codex-theme.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const setPreset = (presetId: string) => {
    const preset = THEME_PRESETS[presetId] ?? DEFAULT_THEME_CONFIG;
    const modeBase = variant === "light" ? DEFAULT_LIGHT_THEME_CONFIG : DEFAULT_THEME_CONFIG;
    onChange({
      ...preset,
      variant,
      theme: {
        ...preset.theme,
        surface: modeBase.theme.surface,
        ink: modeBase.theme.ink,
        opaqueWindows: modeBase.theme.opaqueWindows,
        semanticColors: { ...modeBase.theme.semanticColors },
        fonts: { ...theme.fonts },
      },
    });
  };
  return (
    <div className="omni-theme-config" aria-label={label ? `${label}视觉配置` : "主题视觉配置"}>
      {label ? <div className="omni-theme-config__heading">{label}</div> : null}
      <div className="omni-theme-config__row">
        <span className="omni-theme-config__label">主题包</span>
        <div className="omni-theme-config__control">
          <button type="button" className="omni-theme-config__icon-button" onClick={downloadConfig} aria-label="下载主题配置" title="下载主题配置">
            <Download size={16} />
          </button>
          <button type="button" className="omni-theme-config__icon-button" onClick={() => void copyConfig()} aria-label="复制主题配置" title="复制 codex-theme-v1 配置">
            {copied ? <Check size={16} /> : <Clipboard size={16} />}
          </button>
          <OmniSelect
            value={config.codeThemeId}
            onChange={setPreset}
            ariaLabel="主题包"
            options={Object.keys(THEME_PRESETS).map((value) => ({
              value,
              label: THEME_PRESET_LABELS[value],
              icon: <ThemeSwatch themeId={value} config={value === config.codeThemeId ? config : undefined} />,
            }))}
          />
        </div>
      </div>
      <ThemeColorRow label="强调色" value={theme.accent} onChange={(value) => updateColor("accent", value)} />
      <ThemeColorRow label="背景" value={theme.surface} onChange={(value) => updateColor("surface", value)} />
      <ThemeColorRow label="前景" value={theme.ink} onChange={(value) => updateColor("ink", value)} />
      <div className="omni-theme-config__row">
        <span className="omni-theme-config__label">界面字体</span>
        <OmniSelect
          value={theme.fonts.ui ?? "system"}
          onChange={(value) => updateTheme({ fonts: { ...theme.fonts, ui: value === "system" ? null : value } })}
          ariaLabel="界面字体"
          options={[{ value: "system", label: "系统（跟随系统）" }, ...systemFonts.map((font) => ({ value: font, label: font }))]}
          placeholder={fontsLoading ? "读取系统字体…" : "选择字体"}
        />
      </div>
      <div className="omni-theme-config__row">
        <span className="omni-theme-config__label">代码字体</span>
        <OmniSelect
          value={theme.fonts.code ?? "system"}
          onChange={(value) => updateTheme({ fonts: { ...theme.fonts, code: value === "system" ? null : value } })}
          ariaLabel="代码字体"
          options={[{ value: "system", label: "系统（跟随系统）" }, ...systemFonts.map((font) => ({ value: font, label: font }))]}
          placeholder={fontsLoading ? "读取系统字体…" : "选择字体"}
        />
      </div>
    </div>
  );
}

export default function BasicSettingsSection({
  basicSettings,
  themeMode,
  onChangeThemeMode,
  themeConfig,
  themeSettings,
  onChangeThemeSettings,
  onUpdateBasicSettings,
  onCaptureShortcut,
  onStartShortcutCapture,
  onCancelShortcutCapture,
  recordingShortcut,
  openMainShortcutNotice,
}: Props) {
  // Shell 可用性检测结果（点「检测可用性」后展示）。
  const [shellProbe, setShellProbe] = useState<{ ok: boolean; output: string; probing: boolean } | null>(null);

  const probeShell = async () => {
    const path = basicSettings.shellPath.trim();
    if (!path) return;
    setShellProbe({ ok: false, output: "", probing: true });
    try {
      const result = await invoke<{ ok: boolean; output: string }>("detect_shell", { path });
      setShellProbe({ ok: result.ok, output: result.output.split("\n")[0]?.slice(0, 160) || "", probing: false });
    } catch (error) {
      setShellProbe({ ok: false, output: error instanceof Error ? error.message : String(error), probing: false });
    }
  };

  const updateSandboxMode = async (value: BasicSettings["sandboxMode"]) => {
    if (
      value === "danger-full-access" &&
      basicSettings.sandboxMode !== "danger-full-access"
    ) {
      const approved = await requestConfirmation({
        source: "sandbox_settings",
        title: "启用完全文件访问？",
        summary:
          "完全访问会关闭命令与文件工具的 OS 级写入边界，模型可以直接修改工作区外的文件。",
        riskLevel: "destructive",
        details: [
          { label: "当前模式", value: basicSettings.sandboxMode },
          { label: "目标模式", value },
        ],
        targets: ["本机文件系统"],
        warning:
          "危险命令黑名单、受保护目录检查和逐次确认门仍会生效，但不再有文件系统写入边界。仅在信任当前任务时启用。",
        confirmLabel: "启用完全访问",
      });
      if (!approved) return;
    }
    onUpdateBasicSettings({
      sandboxMode: value,
      sandboxEnabled: value !== "danger-full-access",
    });
  };

  return (
    <div className="omni-basic-settings">
      <section className="omni-settings-group omni-settings-group--appearance" aria-labelledby="basic-theme-heading">
        <div className="omni-settings-group__heading">
          <div>
            <h3 id="basic-theme-heading" className="omni-settings-title">主题与外观</h3>
            <p className="omni-settings-muted">主题会同步影响主窗口、设置界面、悬浮窗和悬浮球。</p>
          </div>
        </div>

        <div className="omni-settings-group__row omni-settings-group__row--theme-mode">
          <label className="omni-settings-group__label">主题模式</label>
          <ThemePicker mode={themeMode} onChange={onChangeThemeMode} />
        </div>

        <div className="omni-settings-group__row omni-settings-group__row--visual-style">
          <div className="omni-settings-group__label">视觉风格</div>
          <div className="omni-theme-config-stack">
            <div className="omni-theme-config__row omni-theme-config__row--switch">
              <div className="omni-theme-config__switch-copy">
                <span className="omni-theme-config__label">分别设置浅色和深色模式</span>
                <span className="omni-theme-config__hint">分别选择各自的主题、颜色和字体</span>
              </div>
              <OmniSwitch
                checked={themeSettings.separateVariants}
                onChange={(checked) => onChangeThemeSettings({ ...themeSettings, separateVariants: checked })}
                ariaLabel="分别设置浅色和深色模式"
              />
            </div>
            {themeSettings.separateVariants ? (
              <>
                <ThemeConfigPanel
                  config={themeSettings.light}
                  variant="light"
                  label="浅色主题"
                  onChange={(config) => onChangeThemeSettings({ ...themeSettings, light: { ...config, variant: "light" } })}
                />
                <ThemeConfigPanel
                  config={themeSettings.dark}
                  variant="dark"
                  label="深色主题"
                  onChange={(config) => onChangeThemeSettings({ ...themeSettings, dark: { ...config, variant: "dark" } })}
                />
              </>
            ) : (
              <ThemeConfigPanel
                config={themeConfig}
                variant={themeConfig.variant}
                onChange={(config) => onChangeThemeSettings({
                  ...themeSettings,
                  [themeConfig.variant]: { ...config, variant: themeConfig.variant },
                })}
              />
            )}
          </div>
        </div>
      </section>

      <section className="omni-settings-group" aria-labelledby="basic-window-heading">
        <div className="omni-settings-group__heading"><h3 id="basic-window-heading" className="omni-settings-title">悬浮与窗口</h3></div>
        <Actions label="开机自启">
          <OmniSwitch checked={basicSettings.autoLaunch} onChange={(checked) => onUpdateBasicSettings({ autoLaunch: checked })} ariaLabel="开机自启" />
          <span className="text-xs text-slate-500 omni-settings-muted">已保存开关，接入系统自启插件后生效。</span>
        </Actions>
        <Field label="最小化方式">
          <OmniSelect
            value={basicSettings.minimizeBehavior}
            onChange={(value) => onUpdateBasicSettings({ minimizeBehavior: value as BasicSettings["minimizeBehavior"] })}
            ariaLabel="最小化方式"
            options={[
              { value: "taskbar", label: "最小化到任务栏" },
              { value: "compact", label: "收起到悬浮球" },
            ]}
          />
        </Field>
        <Field label="打开主窗口">
          <OmniSelect
            value={basicSettings.mainWindowPositionMode}
            onChange={(value) => onUpdateBasicSettings({ mainWindowPositionMode: value as BasicSettings["mainWindowPositionMode"] })}
            ariaLabel="打开主窗口位置"
            options={[
              { value: "center", label: "居中" },
              { value: "remember", label: "记住上次位置" },
            ]}
          />
        </Field>
        <Actions label="悬浮球">
          <OmniSwitch checked={basicSettings.showCompactBall} onChange={(checked) => onUpdateBasicSettings({ showCompactBall: checked })} ariaLabel="显示悬浮球" />
          <span className="text-xs text-slate-500 omni-settings-muted">控制主窗口隐藏后是否显示悬浮球。</span>
        </Actions>
        <Actions label="鼠标随航">
          <OmniSwitch checked={basicSettings.followCursorScreen} onChange={(checked) => onUpdateBasicSettings({ followCursorScreen: checked })} ariaLabel="鼠标随航" />
          <span className="text-xs text-slate-500 omni-settings-muted">鼠标跨屏时悬浮球会切换到所在屏幕，并尽量保留原来的相对位置。</span>
        </Actions>
      </section>

      <section className="omni-settings-group" aria-labelledby="basic-size-heading">
        <div className="omni-settings-group__heading"><h3 id="basic-size-heading" className="omni-settings-title">主窗口默认尺寸</h3></div>
        <div className="space-y-3">
          <Field label="主界面尺寸">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="640"
                max="1800"
                value={basicSettings.mainWindowWidth}
                onChange={(e) => onUpdateBasicSettings({ mainWindowWidth: Number(e.target.value) || 640 })}
                className="h-9 w-28 rounded-[8px] border border-slate-300 px-3 text-sm"
              />
              <span className="text-xs text-slate-500 omni-settings-muted">×</span>
              <input
                type="number"
                min="480"
                max="1400"
                value={basicSettings.mainWindowHeight}
                onChange={(e) => onUpdateBasicSettings({ mainWindowHeight: Number(e.target.value) || 480 })}
                className="h-9 w-28 rounded-[8px] border border-slate-300 px-3 text-sm"
              />
              <span className="text-xs text-slate-500 omni-settings-muted">宽 × 高</span>
            </div>
          </Field>
          <p className="pl-[136px] text-xs text-slate-500 omni-settings-muted">
            影响聊天/知识库主界面的默认窗口大小，不影响设置窗口、悬浮球和桌宠窗口。
          </p>
        </div>
      </section>

      <section className="omni-settings-group" aria-labelledby="basic-shortcuts-heading">
        <div className="omni-settings-group__heading"><h3 id="basic-shortcuts-heading" className="omni-settings-title">快捷键</h3></div>
        <Field label="打开主界面">
          <button
            type="button"
            onKeyDown={(e) => onCaptureShortcut(e, "openMainShortcut")}
            onClick={(e) => {
              e.currentTarget.focus();
              onStartShortcutCapture("openMainShortcut");
            }}
            onBlur={onCancelShortcutCapture}
            aria-pressed={recordingShortcut === "openMainShortcut"}
            className={`omni-shortcut-capture h-9 w-full rounded-[8px] border px-3 text-left text-sm ${
              recordingShortcut === "openMainShortcut"
                ? "omni-shortcut-capture--active border-violet-500 text-violet-600 ring-2 ring-violet-500/20"
                : "border-slate-300"
            }`}
          >
            <span>{recordingShortcut === "openMainShortcut" ? "请按快捷键..." : basicSettings.openMainShortcut}</span>
            {recordingShortcut === "openMainShortcut" && <span className="ml-2 rounded bg-violet-600 px-1.5 py-0.5 text-[10px] text-white">录入中</span>}
          </button>
        </Field>
        <Field label="切换上个模型">
          <button
            type="button"
            onKeyDown={(e) => onCaptureShortcut(e, "switchPreviousModelShortcut")}
            onClick={(e) => {
              e.currentTarget.focus();
              onStartShortcutCapture("switchPreviousModelShortcut");
            }}
            onBlur={onCancelShortcutCapture}
            aria-pressed={recordingShortcut === "switchPreviousModelShortcut"}
            className={`omni-shortcut-capture h-9 w-full rounded-[8px] border px-3 text-left text-sm ${
              recordingShortcut === "switchPreviousModelShortcut"
                ? "omni-shortcut-capture--active border-violet-500 text-violet-600 ring-2 ring-violet-500/20"
                : "border-slate-300"
            }`}
          >
            <span>{recordingShortcut === "switchPreviousModelShortcut" ? "请按快捷键..." : basicSettings.switchPreviousModelShortcut}</span>
            {recordingShortcut === "switchPreviousModelShortcut" && (
              <span className="ml-2 rounded bg-violet-600 px-1.5 py-0.5 text-[10px] text-white">录入中</span>
            )}
          </button>
        </Field>
        <p className="pl-[136px] text-xs text-slate-500 omni-settings-muted">
          「打开主界面」是系统级全局快捷键，应用未聚焦时同样可用；若组合键已被其它程序占用，会自动回落到「仅窗口聚焦时生效」并在下方提示。
          点击快捷键框后直接按键设置，Backspace / Delete / Esc 清空。
        </p>
        {openMainShortcutNotice ? (
          <p
            className={`pl-[136px] text-xs ${
              openMainShortcutNotice.kind === "error" ? "text-red-600" : "text-emerald-600"
            }`}
          >
            {openMainShortcutNotice.text}
          </p>
        ) : null}
      </section>

      <section className="omni-settings-group" aria-labelledby="basic-command-heading">
        <div className="omni-settings-group__heading"><h3 id="basic-command-heading" className="omni-settings-title">命令执行</h3></div>
        <div className="omni-settings-form-row grid grid-cols-[120px_1fr] gap-4">
          <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">Shell 路径</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={basicSettings.shellPath}
              onChange={(e) => {
                onUpdateBasicSettings({ shellPath: e.target.value });
                setShellProbe(null);
              }}
              placeholder={IS_WINDOWS ? "留空自动探测（Git-Bash → cmd /C）" : "留空使用默认 bash/zsh"}
              className="h-9 w-full rounded-[8px] border border-slate-300 px-3 text-sm"
            />
            <button
              type="button"
              onClick={() => void probeShell()}
              disabled={!basicSettings.shellPath.trim() || shellProbe?.probing}
              className="h-9 shrink-0 rounded-[8px] border border-slate-300 px-3 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {shellProbe?.probing ? "检测中…" : "检测可用性"}
            </button>
            <button
              type="button"
              onClick={async () => {
                const picked = await openDialog({
                  directory: false,
                  multiple: false,
                  title: "选择 Shell 可执行文件",
                  ...(IS_WINDOWS
                    ? { filters: [{ name: "Shell", extensions: ["exe", "bat", "cmd", "sh", "bash"] }] }
                    : {}),
                });
                if (typeof picked === "string" && picked.trim()) {
                  onUpdateBasicSettings({ shellPath: picked.trim() });
                }
              }}
              className="h-9 shrink-0 rounded-[8px] border border-slate-300 px-3 text-sm text-slate-700 hover:bg-slate-50"
            >
              选择文件
            </button>
          </div>
        </div>
        <div className="pl-[136px] flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-500 omni-settings-muted">常见示例：</span>
          {SHELL_EXAMPLES.map((example) => (
            <button
              key={example.label}
              type="button"
              title={example.path}
              onClick={() => {
                onUpdateBasicSettings({ shellPath: example.path });
                setShellProbe(null);
              }}
              className="rounded-[8px] border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600 transition-colors hover:border-slate-400 hover:text-slate-900"
            >
              {example.label}
            </button>
          ))}
        </div>
        <p className="pl-[136px] text-xs text-slate-500 omni-settings-muted">
          「运行 Shell 命令」工具使用的 Shell。留空时 Windows 自动探测 Git-Bash（未命中回落 cmd），macOS/Linux 优先使用用户默认 Shell；
          指定后按可执行名匹配参数（bash/zsh → -lc，cmd → /C，pwsh → -Command，wsl → --，busybox → sh -c，其余 → -c），
          可指向 Git-Bash、WSL、MSYS2、Cygwin 或任意自定义 Shell。注意：切换自定义 Shell 不会关闭命令安全校验，
          高危命令依旧被拦截、修改类操作依旧需要确认。
        </p>
        {shellProbe && !shellProbe.probing && (
          <p
            className={`pl-[136px] text-xs ${shellProbe.ok ? "text-emerald-600" : "text-red-600"}`}
            role="status"
          >
            {shellProbe.ok ? "检测成功：" : "检测失败："}
            {shellProbe.output || (shellProbe.ok ? "可用" : "未知错误")}
          </p>
        )}
        <div className="omni-settings-form-row grid grid-cols-[120px_1fr] gap-4">
          <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">文件权限（沙箱）</label>
          <div className="flex flex-col gap-1.5">
            <OmniSelect
              value={basicSettings.sandboxMode}
              ariaLabel="文件权限模式"
              onChange={(value) => {
                void updateSandboxMode(value as BasicSettings["sandboxMode"]);
              }}
              options={[
                {
                  value: "read-only",
                  label: "只读",
                  description: "命令不能修改文件，适合检索、查看和运行只读工具",
                  disabled: !HAS_OS_FILE_SANDBOX,
                },
                {
                  value: "workspace-write",
                  label: "工作区写入",
                  description: "只能写当前工作区和隔离临时目录，工作区外写入会被系统拒绝",
                  disabled: !HAS_OS_FILE_SANDBOX,
                },
                {
                  value: "danger-full-access",
                  label: "完全访问",
                  description: "不启用文件写入边界；现有确认门和禁区拦截仍会生效",
                },
              ]}
            />
            <p className="text-xs text-slate-500 omni-settings-muted">
              {IS_WINDOWS
                ? "只读和工作区写入使用 Windows WRITE_RESTRICTED Token、能力 SID、目录 ACL 与 Low Integrity。受限模式会关闭持久 PTY，改为一次性执行；沙箱不可用时拒绝执行。"
                : HAS_OS_FILE_SANDBOX && IS_MACOS_PLATFORM
                  ? "只读和工作区写入使用 macOS Seatbelt（/usr/bin/sandbox-exec）统一禁止文件写入，仅工作区、/tmp 与用户临时目录可写。沙箱不可用时会拒绝执行，不会静默降级。"
                  : "当前平台没有已实现的系统级文件沙箱，只提供“完全访问”；受限模式不会静默退化为普通执行。"}
            </p>
          </div>
        </div>
      </section>

      <section className="omni-settings-group" aria-labelledby="basic-subagent-heading">
        <div className="omni-settings-group__heading"><h3 id="basic-subagent-heading" className="omni-settings-title">子 Agent 模型</h3></div>
        <p className="text-xs text-slate-500 omni-settings-muted">
          通过 agent 工具派出的子 Agent 可走「能力强 / 轻量」两档模型。未设置时回落到本轮主运行模型；轻量档未设置再回落能力强档。通用只读调研默认走轻量档，专家委派默认走能力强档，也可用 tier 参数显式覆盖。
        </p>
        <Field label="能力强模型">
          <OmniSelect
            value={basicSettings.subAgentModel}
            onChange={(value) => onUpdateBasicSettings({ subAgentModel: value })}
            ariaLabel="子 Agent 能力强模型"
            options={[
              { value: "", label: "未设置（回落主模型）" },
              ...modelRegistry.getAvailableModels().map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
        </Field>
        <Field label="轻量模型">
          <OmniSelect
            value={basicSettings.subAgentFastModel}
            onChange={(value) => onUpdateBasicSettings({ subAgentFastModel: value })}
            ariaLabel="子 Agent 轻量模型"
            options={[
              { value: "", label: "未设置（回落能力强档）" },
              ...modelRegistry.getAvailableModels().map((m) => ({ value: m.id, label: m.name })),
            ]}
          />
        </Field>
        <Field label="专家委派">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={basicSettings.allowAnyExpertDelegation === true}
                onChange={(e) => onUpdateBasicSettings({ allowAnyExpertDelegation: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300"
              />
              允许模型指派任意已启用专家
            </label>
            <p className="text-xs text-slate-500 omni-settings-muted">
              默认关闭。专家与技能/MCP 的口径不同：技能和 MCP「安装 + 开启」即对模型直接可用，
              而专家是「本项目可指派的工作角色」，只有项目设置里绑定过的专家才会进入模型的可委派名册，
              未绑定的专家即使已安装并开启也不会被模型自动指派。打开后放宽为任意已启用专家都可委派。
              手动 @专家 不受此开关影响，始终可用。
            </p>
          </div>
        </Field>
      </section>
    </div>
  );
}
