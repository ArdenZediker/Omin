import { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { BasicSettings } from "../../app/types";
import type { ThemeMode } from "../../app/settings";
import type { CodexPetLibraryState, CodexPetPackage } from "../../app/pets/codexPetTypes";
import OmniSelect from "../ui/OmniSelect";
import OmniSwitch from "../ui/OmniSwitch";
import CodexPetSection from "./CodexPetSection";

// 常见 Shell 可执行文件路径示例（Windows 为主）：点按回填到 Shell 路径输入框。
const SHELL_EXAMPLES: Array<{ label: string; path: string }> = [
  { label: "Git-Bash", path: "C:\\Program Files\\Git\\bin\\bash.exe" },
  { label: "MSYS2", path: "C:\\msys64\\usr\\bin\\bash.exe" },
  { label: "Cygwin", path: "C:\\cygwin64\\bin\\bash.exe" },
  { label: "WSL", path: "C:\\Windows\\System32\\wsl.exe" },
  { label: "busybox", path: "C:\\tools\\busybox.exe" },
  { label: "PowerShell 7", path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
];

type Props = {
  basicSettings: BasicSettings;
  themeMode: ThemeMode;
  onChangeThemeMode: (mode: ThemeMode) => void;
  onUpdateBasicSettings: (patch: Partial<BasicSettings>) => void;
  codexPetPackages: CodexPetPackage[];
  codexPetLibraryState: CodexPetLibraryState;
  codexPetHome: string;
  isDesktopPetAwake: boolean;
  onEnableDesktopPet: () => void;
  onSelectCodexPet: (petId: string) => void;
  onImportCodexPet: () => Promise<boolean>;
  onRefreshCodexPets: () => void;
  onCaptureShortcut: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    keyName: keyof Pick<BasicSettings, "openMainShortcut" | "switchPreviousModelShortcut">
  ) => void;
  onStartShortcutCapture: (keyName: keyof Pick<BasicSettings, "openMainShortcut" | "switchPreviousModelShortcut">) => void;
  onCancelShortcutCapture: () => void;
  recordingShortcut: "openMainShortcut" | "switchPreviousModelShortcut" | null;
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-4">
      <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">{label}</label>
      {children}
    </div>
  );
}

function Actions({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-4">
      <span className="pt-1 text-right text-sm text-slate-700">{label}</span>
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}

export default function BasicSettingsSection({
  basicSettings,
  themeMode,
  onChangeThemeMode,
  onUpdateBasicSettings,
  codexPetPackages,
  codexPetLibraryState,
  codexPetHome,
  isDesktopPetAwake,
  onEnableDesktopPet,
  onSelectCodexPet,
  onImportCodexPet,
  onRefreshCodexPets,
  onCaptureShortcut,
  onStartShortcutCapture,
  onCancelShortcutCapture,
  recordingShortcut,
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

  return (
    <section className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm omni-settings-card">
      <div className="border-b border-slate-100 pb-3">
        <h3 className="text-sm font-medium text-slate-900 omni-settings-title">主题设置</h3>
        <p className="mt-1 text-xs text-slate-500 omni-settings-muted">主题会同步影响主窗口、设置界面、悬浮窗和悬浮球。</p>
      </div>

      <div className="grid grid-cols-[120px_1fr] gap-4">
        <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">主题</label>
        <div className="inline-flex w-fit overflow-hidden rounded-lg border border-slate-300 bg-white">
          {(["auto", "dark", "light"] as ThemeMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onChangeThemeMode(mode)}
              className={`px-5 py-2 text-sm transition-colors ${
                themeMode === mode ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              {mode === "auto" ? "自动" : mode === "dark" ? "暗黑" : "明亮"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="mb-2 text-center text-sm font-semibold text-slate-900">亮色预览</div>
          <div className="rounded-lg bg-gradient-to-br from-sky-100 via-pink-100 to-amber-100 p-4">
            <div className="w-32 rounded-xl bg-white/78 p-2 shadow-lg backdrop-blur">
              <div className="mb-2 h-5 rounded bg-slate-200" />
              <div className="space-y-1">
                <div className="h-3 rounded bg-slate-300" />
                <div className="h-3 rounded bg-violet-200" />
                <div className="h-3 rounded bg-slate-200" />
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-950 p-3">
          <div className="mb-2 text-center text-sm font-semibold text-white">暗色预览</div>
          <div className="rounded-lg bg-gradient-to-br from-slate-900 via-fuchsia-950 to-sky-950 p-4">
            <div className="w-32 rounded-xl bg-black/62 p-2 shadow-lg backdrop-blur">
              <div className="mb-2 h-5 rounded bg-white/15" />
              <div className="space-y-1">
                <div className="h-3 rounded bg-white/20" />
                <div className="h-3 rounded bg-violet-400/30" />
                <div className="h-3 rounded bg-white/10" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-medium text-slate-900 omni-settings-title">悬浮与窗口</h3>
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
      </div>

      <div className="space-y-4 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-medium text-slate-900 omni-settings-title">主窗口默认尺寸</h3>
        <div className="space-y-3">
          <Field label="主界面尺寸">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="640"
                max="1800"
                value={basicSettings.mainWindowWidth}
                onChange={(e) => onUpdateBasicSettings({ mainWindowWidth: Number(e.target.value) || 640 })}
                className="h-9 w-28 rounded-md border border-slate-300 px-3 text-sm"
              />
              <span className="text-xs text-slate-500 omni-settings-muted">×</span>
              <input
                type="number"
                min="480"
                max="1400"
                value={basicSettings.mainWindowHeight}
                onChange={(e) => onUpdateBasicSettings({ mainWindowHeight: Number(e.target.value) || 480 })}
                className="h-9 w-28 rounded-md border border-slate-300 px-3 text-sm"
              />
              <span className="text-xs text-slate-500 omni-settings-muted">宽 × 高</span>
            </div>
          </Field>
          <p className="pl-[136px] text-xs text-slate-500 omni-settings-muted">
            影响聊天/知识库主界面的默认窗口大小，不影响设置窗口、悬浮球和桌宠窗口。
          </p>
        </div>
      </div>

      <div className="space-y-4 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-medium text-slate-900 omni-settings-title">快捷键</h3>
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
            className={`omni-shortcut-capture h-9 w-full rounded-md border px-3 text-left text-sm ${
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
            className={`omni-shortcut-capture h-9 w-full rounded-md border px-3 text-left text-sm ${
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
        <p className="pl-[136px] text-xs text-slate-500 omni-settings-muted">点击快捷键框后直接按键设置，Backspace / Delete / Esc 清空。</p>
      </div>

      <div className="space-y-4 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-medium text-slate-900 omni-settings-title">默认工作空间</h3>
        <div className="grid grid-cols-[120px_1fr] gap-4">
          <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">默认目录</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={basicSettings.defaultWorkspacePath}
              onChange={(e) => onUpdateBasicSettings({ defaultWorkspacePath: e.target.value })}
              placeholder="未设置时任务会话不绑定工作目录"
              className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
            />
            <button
              type="button"
              onClick={async () => {
                const picked = await openDialog({ directory: true, multiple: false, title: "选择默认工作空间" });
                if (typeof picked === "string" && picked.trim()) {
                  onUpdateBasicSettings({ defaultWorkspacePath: picked.trim() });
                }
              }}
              className="h-9 shrink-0 rounded-md border border-slate-300 px-3 text-sm text-slate-700 hover:bg-slate-50"
            >
              选择目录
            </button>
          </div>
        </div>
        <p className="pl-[136px] text-xs text-slate-500 omni-settings-muted">
          未单独配置工作目录的项目与任务会话，自动共用此目录作为工作空间；在项目设置里单独填了「工作目录」的会以项目为准。
        </p>
      </div>

      <div className="space-y-4 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-medium text-slate-900 omni-settings-title">命令执行</h3>
        <div className="grid grid-cols-[120px_1fr] gap-4">
          <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">Shell 路径</label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={basicSettings.shellPath}
              onChange={(e) => {
                onUpdateBasicSettings({ shellPath: e.target.value });
                setShellProbe(null);
              }}
              placeholder="留空自动探测（Git-Bash → cmd /C）"
              className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
            />
            <button
              type="button"
              onClick={() => void probeShell()}
              disabled={!basicSettings.shellPath.trim() || shellProbe?.probing}
              className="h-9 shrink-0 rounded-md border border-slate-300 px-3 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
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
                  filters: [{ name: "Shell", extensions: ["exe", "bat", "cmd", "sh", "bash"] }],
                });
                if (typeof picked === "string" && picked.trim()) {
                  onUpdateBasicSettings({ shellPath: picked.trim() });
                }
              }}
              className="h-9 shrink-0 rounded-md border border-slate-300 px-3 text-sm text-slate-700 hover:bg-slate-50"
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
              className="rounded border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600 transition-colors hover:border-slate-400 hover:text-slate-900"
            >
              {example.label}
            </button>
          ))}
        </div>
        <p className="pl-[136px] text-xs text-slate-500 omni-settings-muted">
          「运行 Shell 命令」工具使用的 Shell。留空时 Windows 自动探测 Git-Bash（未命中回落 cmd），macOS/Linux 用系统 sh；
          指定后按可执行名匹配参数（bash/zsh → -lc，cmd → /C，pwsh → -Command，wsl → --，busybox → sh -c，其余 → -c），
          可指向 Git-Bash、WSL、MSYS2、Cygwin 或任意自定义 Shell。⚠️ 切换自定义 Shell 不会关闭命令安全校验，
          高危命令依旧被拦截、修改类操作依旧需要确认。
        </p>
        {shellProbe && !shellProbe.probing && (
          <p
            className={`pl-[136px] text-xs ${shellProbe.ok ? "text-emerald-600" : "text-red-600"}`}
            role="status"
          >
            {shellProbe.ok ? "✅ 检测成功：" : "❌ 检测失败："}
            {shellProbe.output || (shellProbe.ok ? "可用" : "未知错误")}
          </p>
        )}
      </div>

      <div className="border-t border-slate-100 pt-4">
        <CodexPetSection
          packages={codexPetPackages}
          state={codexPetLibraryState}
          projectPetsRoot={codexPetHome}
          isDesktopPetAwake={isDesktopPetAwake}
          onEnableDesktopPet={onEnableDesktopPet}
          onSelectPet={onSelectCodexPet}
          onImportPet={onImportCodexPet}
          onRefreshPets={onRefreshCodexPets}
        />
      </div>
    </section>
  );
}
