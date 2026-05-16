import type { KeyboardEvent, ReactNode } from "react";
import type { BasicSettings } from "../../app/types";
import type { ThemeMode } from "../../app/settings";
import type { CodexPetLibraryState, CodexPetPackage } from "../../app/pets/codexPetTypes";
import CodexPetSection from "./CodexPetSection";

type Props = {
  basicSettings: BasicSettings;
  themeMode: ThemeMode;
  onChangeThemeMode: (mode: ThemeMode) => void;
  onUpdateBasicSettings: (patch: Partial<BasicSettings>) => void;
  codexPetPackages: CodexPetPackage[];
  codexPetLibraryState: CodexPetLibraryState;
  codexPetHome: string;
  onSelectCodexPet: (petId: string) => void;
  onCreateCodexPet: () => void;
  onRefreshCodexPets: () => void;
  onCaptureShortcut: (
    event: KeyboardEvent<HTMLButtonElement>,
    keyName: keyof Pick<BasicSettings, "openMainShortcut" | "switchPreviousModelShortcut">
  ) => void;
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
  onSelectCodexPet,
  onCreateCodexPet,
  onRefreshCodexPets,
  onCaptureShortcut,
  recordingShortcut,
}: Props) {
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

      <CodexPetSection
        packages={codexPetPackages}
        state={codexPetLibraryState}
        codexHome={codexPetHome}
        onSelectPet={onSelectCodexPet}
        onCreatePet={onCreateCodexPet}
        onRefreshPets={onRefreshCodexPets}
      />

      <div className="space-y-4 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-medium text-slate-900 omni-settings-title">悬浮与窗口</h3>
        <Field label="菜单打开">
          <select
            value={basicSettings.menuOpenMode}
            onChange={(e) => onUpdateBasicSettings({ menuOpenMode: e.target.value as BasicSettings["menuOpenMode"] })}
            className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
          >
            <option value="hover">悬停</option>
            <option value="click">点击</option>
          </select>
        </Field>
        <Actions label="开机自启">
          <input type="checkbox" checked={basicSettings.autoLaunch} onChange={(e) => onUpdateBasicSettings({ autoLaunch: e.target.checked })} />
          <span className="text-xs text-slate-500 omni-settings-muted">已保存开关，接入系统自启插件后生效。</span>
        </Actions>
        <Field label="最小化方式">
          <select
            value={basicSettings.minimizeBehavior}
            onChange={(e) => onUpdateBasicSettings({ minimizeBehavior: e.target.value as BasicSettings["minimizeBehavior"] })}
            className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
          >
            <option value="taskbar">最小化到任务栏</option>
            <option value="compact">收起到悬浮球</option>
          </select>
        </Field>
        <Field label="打开主窗口">
          <select
            value={basicSettings.mainWindowPositionMode}
            onChange={(e) => onUpdateBasicSettings({ mainWindowPositionMode: e.target.value as BasicSettings["mainWindowPositionMode"] })}
            className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
          >
            <option value="center">居中</option>
            <option value="remember">记住上次位置</option>
          </select>
        </Field>
        <Actions label="悬浮球">
          <input type="checkbox" checked={basicSettings.showCompactBall} onChange={(e) => onUpdateBasicSettings({ showCompactBall: e.target.checked })} />
          <span className="text-xs text-slate-500 omni-settings-muted">控制主窗口隐藏后是否显示悬浮球。</span>
        </Actions>
        <Actions label="鼠标随航">
          <input type="checkbox" checked={basicSettings.followCursorScreen} onChange={(e) => onUpdateBasicSettings({ followCursorScreen: e.target.checked })} />
          <span className="text-xs text-slate-500 omni-settings-muted">开启后，鼠标跨屏时悬浮球会切换到鼠标所在屏幕。</span>
        </Actions>
      </div>

      <div className="space-y-4 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-medium text-slate-900 omni-settings-title">默认尺寸</h3>
        <div className="space-y-3">
          <Field label="默认尺寸">
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
        </div>
      </div>

      <div className="space-y-4 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-medium text-slate-900 omni-settings-title">快捷键</h3>
        <Field label="打开主界面">
          <button
            type="button"
            onKeyDown={(e) => onCaptureShortcut(e, "openMainShortcut")}
            onClick={(e) => e.currentTarget.focus()}
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
            onClick={(e) => e.currentTarget.focus()}
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
    </section>
  );
}
