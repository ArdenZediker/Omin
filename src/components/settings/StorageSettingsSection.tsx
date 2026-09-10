import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { BasicSettings } from "../../app/types";
import {
  getDataRootInfo,
  setDataRoot,
  resetDataRoot,
  openDataDir,
  exportDataBackup,
  importDataBackup,
  restartApp,
  type DataRootInfo,
  type DataRootSource,
} from "../../app/storageApi";
import {
  getOutputRootSetting,
  setOutputRootSetting,
} from "../../app/outputStorage";

type Props = {
  basicSettings: BasicSettings;
  onUpdateBasicSettings: (patch: Partial<BasicSettings>) => void;
};

const SOURCE_LABEL: Record<DataRootSource, string> = {
  custom: "自定义目录",
  portable: "便携模式（跟随软件）",
  default: "默认（应用数据目录）",
};

const ZIP_FILTER = [{ name: "Omni 备份", extensions: ["zip"] }];

type StatusMessage = { kind: "ok" | "error"; text: string };

function StatusBanner({ message }: { message: StatusMessage | null }) {
  if (!message) return null;
  return (
    <div
      className={`rounded-lg px-3 py-2 text-xs ${
        message.kind === "ok"
          ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
          : "bg-rose-50 text-rose-700 ring-1 ring-rose-200"
      }`}
    >
      {message.text}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-4">
      <span className="pt-1 text-right text-sm text-slate-700 omni-settings-label">
        {label}
      </span>
      <span className="break-all rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-600">
        {value}
      </span>
    </div>
  );
}

export default function StorageSettingsSection({
  basicSettings,
  onUpdateBasicSettings,
}: Props) {
  const [info, setInfo] = useState<DataRootInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<StatusMessage | null>(null);
  const [exportSecret, setExportSecret] = useState("");
  const [importSecret, setImportSecret] = useState("");
  const [importSource, setImportSource] = useState("");
  const [importTarget, setImportTarget] = useState("");
  // 恢复成功后，运行中的进程仍持旧数据库句柄，需重启才能加载新数据。
  const [needsRestart, setNeedsRestart] = useState(false);

  const [outputRoot, setOutputRoot] = useState(() => getOutputRootSetting());
  // 产出根目录默认不暴露：导出固定落到工作空间下的 Omni-导出。仅当用户主动勾选覆盖时才展开输入框。
  const [useOutputOverride, setUseOutputOverride] = useState(
    () => getOutputRootSetting() !== "",
  );

  // 兜底工作目录提示：设置页打开时按需拉取当前数据根，拼出 fallback-workspace 真实路径。
  const [fallbackWorkspaceHint, setFallbackWorkspaceHint] = useState("");
  useEffect(() => {
    let active = true;
    getDataRootInfo()
      .then((info) => {
        if (!active || !info?.path) return;
        const base =
          info.path.endsWith("/") || info.path.endsWith("\\")
            ? info.path
            : `${info.path}/`;
        setFallbackWorkspaceHint(`${base}fallback-workspace`);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await getDataRootInfo();
      setInfo(next);
    } catch (err) {
      setMessage({
        kind: "error",
        text: `读取数据目录失败：${(err as Error).message ?? String(err)}`,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleOpen = async () => {
    setBusy("open");
    setMessage(null);
    try {
      await openDataDir();
    } catch (err) {
      setMessage({
        kind: "error",
        text: `打开目录失败：${(err as Error).message ?? String(err)}`,
      });
    } finally {
      setBusy(null);
    }
  };

  const handlePickRoot = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "选择 Omni 数据存储目录",
    });
    if (typeof selected !== "string") return;
    setBusy("set");
    setMessage(null);
    try {
      const next = await setDataRoot(selected);
      setInfo(next);
      setMessage({
        kind: "ok",
        text: "已迁移数据到新目录，旧目录的数据已保留，可手动清理。",
      });
    } catch (err) {
      setMessage({
        kind: "error",
        text: `迁移失败：${(err as Error).message ?? String(err)}`,
      });
    } finally {
      setBusy(null);
    }
  };

  const handleReset = async () => {
    setBusy("reset");
    setMessage(null);
    try {
      const next = await resetDataRoot();
      setInfo(next);
      setMessage({
        kind: "ok",
        text: "已恢复为默认存储位置（应用数据目录）。",
      });
    } catch (err) {
      setMessage({
        kind: "error",
        text: `恢复失败：${(err as Error).message ?? String(err)}`,
      });
    } finally {
      setBusy(null);
    }
  };

  const handlePickOutputRoot = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "选择生成文档存放目录",
    });
    if (typeof selected === "string" && selected.trim()) {
      setOutputRootSetting(selected.trim());
      setOutputRoot(selected.trim());
    }
  };

  const handleExport = async () => {
    const target = await openDialog({
      save: true,
      defaultPath: "omni-backup.zip",
      filters: ZIP_FILTER,
      title: "导出数据备份",
    });
    if (typeof target !== "string") return;
    const finalTarget = target.endsWith(".zip") ? target : `${target}.zip`;
    setBusy("export");
    setMessage(null);
    try {
      const manifest = await exportDataBackup(
        finalTarget,
        exportSecret || null,
      );
      setMessage({
        kind: "ok",
        text: `备份已导出：${finalTarget}（格式版本 ${manifest.formatVersion}，加密：${manifest.encrypted ? "是" : "否"}）`,
      });
    } catch (err) {
      setMessage({
        kind: "error",
        text: `导出失败：${(err as Error).message ?? String(err)}`,
      });
    } finally {
      setBusy(null);
    }
  };

  const handlePickImportSource = async () => {
    const selected = await openDialog({
      filters: ZIP_FILTER,
      multiple: false,
      title: "选择 Omni 备份文件",
    });
    if (typeof selected === "string") setImportSource(selected);
  };

  const handlePickImportTarget = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: "选择恢复到的目录（将作为新的数据存储位置）",
    });
    if (typeof selected === "string") setImportTarget(selected);
  };

  const handleImport = async () => {
    if (!importSource || !importTarget) {
      setMessage({ kind: "error", text: "请先选择备份文件和恢复目录。" });
      return;
    }
    setBusy("import");
    setMessage(null);
    try {
      const manifest = await importDataBackup(
        importSource,
        importTarget,
        importSecret || null,
      );
      await refresh();
      setNeedsRestart(true);
      setMessage({
        kind: "ok",
        text: `已从备份恢复，数据位置已切换到：${importTarget}（格式版本 ${manifest.formatVersion}）`,
      });
    } catch (err) {
      setMessage({
        kind: "error",
        text: `导入失败：${(err as Error).message ?? String(err)}`,
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="space-y-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm omni-settings-card">
      <div className="border-b border-slate-100 pb-3">
        <h3 className="text-sm font-medium text-slate-900 omni-settings-title">
          生成文档归档
        </h3>
        <p className="mt-1 text-xs text-slate-500 omni-settings-muted">
          各类生成文件（文档/表格/演示/Markdown）默认存放到「当前工作空间下的{" "}
          <code className="rounded bg-slate-100 px-1 text-slate-700">
            Omni-导出
          </code>{" "}
          文件夹」，并按「项目 / 会话」自动分子目录。通常无需设置。
        </p>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-[120px_1fr] gap-4">
          <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">
            归档位置
          </label>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={useOutputOverride}
                onChange={(e) => {
                  const next = e.target.checked;
                  if (!next) {
                    setOutputRootSetting("");
                    setOutputRoot("");
                  }
                  setUseOutputOverride(next);
                }}
              />
              固定归档到其它目录（覆盖默认工作空间位置）
            </label>

            {useOutputOverride && (
              <div className="space-y-2 rounded-lg bg-slate-50 p-3">
                <span className="block break-all rounded-md bg-white px-2 py-1 text-xs text-slate-600">
                  {outputRoot || "未选择目录"}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    onClick={handlePickOutputRoot}
                  >
                    选择目录…
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    onClick={() => {
                      setOutputRootSetting("");
                      setOutputRoot("");
                    }}
                  >
                    清除
                  </button>
                </div>
                <p className="text-xs text-slate-400">
                  设置后，所有导出将固定落到此目录，不再跟随工作空间。
                </p>
              </div>
            )}

            {!useOutputOverride && (
              <p className="text-xs text-slate-400">
                默认：导出到工作空间下的{" "}
                <code className="rounded bg-slate-100 px-1 text-slate-600">
                  Omni-导出
                </code>
                。如想把生成文件固定归档到别处，勾选上方选项即可。
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-4 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-medium text-slate-900 omni-settings-title">
          默认工作空间
        </h3>
        <div className="grid grid-cols-[120px_1fr] gap-4">
          <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">
            默认目录
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={basicSettings.defaultWorkspacePath}
              onChange={(e) =>
                onUpdateBasicSettings({ defaultWorkspacePath: e.target.value })
              }
              placeholder="未设置时任务会话不绑定工作目录"
              className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
            />
            <button
              type="button"
              onClick={async () => {
                const picked = await openDialog({
                  directory: true,
                  multiple: false,
                  title: "选择默认工作空间",
                });
                if (typeof picked === "string" && picked.trim()) {
                  onUpdateBasicSettings({
                    defaultWorkspacePath: picked.trim(),
                  });
                }
              }}
              className="h-9 shrink-0 rounded-md border border-slate-300 px-3 text-sm text-slate-700 hover:bg-slate-50"
            >
              选择目录
            </button>
          </div>
        </div>
        <p className="pl-[136px] text-xs text-slate-500 omni-settings-muted">
          未单独配置工作目录的项目与任务会话，自动共用此目录作为工作空间；在项目设置里单独填了「工作目录」的会以项目为准。留空时，未绑定会话将使用兜底工作目录：
          {fallbackWorkspaceHint ? (
            <code className="ml-1 rounded bg-slate-100 px-1 py-0.5 text-[11px] text-slate-600">
              {fallbackWorkspaceHint}
            </code>
          ) : (
            <span className="ml-1">
              （应用数据目录内的 fallback-workspace）
            </span>
          )}
          。
        </p>
      </div>

      <div className="space-y-4 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-medium text-slate-900 omni-settings-title">
          高级 · 应用数据存储
        </h3>

        <StatusBanner message={message} />

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                info ? "bg-sky-100 text-sky-700" : "bg-slate-100 text-slate-500"
              }`}
            >
              {loading ? "读取中…" : info ? SOURCE_LABEL[info.source] : "未知"}
            </span>
            {info && !info.writable && (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                目录不可写
              </span>
            )}
            {info?.fallbackReason && (
              <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                已回退
              </span>
            )}
          </div>

          {loading ? (
            <div className="text-xs text-slate-400">正在读取当前数据目录…</div>
          ) : info ? (
            <div className="space-y-2">
              <InfoRow label="数据根目录" value={info.path} />
              <InfoRow label="数据库" value={info.databasePath} />
              <InfoRow label="知识库" value={info.knowledgePath} />
              {info.fallbackReason && (
                <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-200">
                  {info.fallbackReason}
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-slate-400">无法读取数据目录信息。</div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            onClick={handleOpen}
            disabled={busy !== null || !info}
          >
            打开数据目录
          </button>
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            onClick={handlePickRoot}
            disabled={busy !== null}
          >
            更改存储位置…
          </button>
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            onClick={handleReset}
            disabled={busy !== null}
          >
            恢复默认位置
          </button>
        </div>

        <p className="text-xs leading-5 text-slate-500 omni-settings-muted">
          不要把数据目录放进云同步盘（OneDrive / Dropbox /
          百度网盘等）或网络盘——SQLite 的 WAL 模式在这些位置可能静默损坏。
          软件安装在{" "}
          <code className="rounded bg-slate-100 px-1 text-slate-700">
            Program Files
          </code>{" "}
          等只读位置时，会自动改用应用数据目录。
        </p>
      </div>

      <div className="space-y-4 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-medium text-slate-900 omni-settings-title">
          整库备份
        </h3>
        <div className="space-y-3">
          <div className="grid grid-cols-[120px_1fr] gap-4">
            <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">
              加密密码
            </label>
            <input
              type="password"
              value={exportSecret}
              onChange={(e) => setExportSecret(e.target.value)}
              placeholder="可选，留空则不加密"
              className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
            />
          </div>
          <div className="flex items-center gap-2 pl-[136px]">
            <button
              type="button"
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              onClick={handleExport}
              disabled={busy !== null}
            >
              {busy === "export" ? "导出中…" : "导出备份…"}
            </button>
            <span className="text-xs text-slate-500 omni-settings-muted">
              导出为 .zip，含数据库、知识库与全部对话记录。
            </span>
          </div>
          <p className="pl-[136px] text-xs leading-5 text-slate-500 omni-settings-muted">
            备份包含 API Key 等敏感配置；设置密码后会用 AES-256
            加密整个压缩包，导入时须输入相同密码。
          </p>
        </div>
      </div>

      <div className="space-y-4 border-t border-slate-100 pt-4">
        <h3 className="text-sm font-medium text-slate-900 omni-settings-title">
          从备份恢复
        </h3>
        {needsRestart && (
          <div className="rounded-lg bg-amber-50 px-3 py-3 text-xs text-amber-800 ring-1 ring-amber-200">
            <p className="mb-2 font-medium">
              ⚠️ 备份已恢复，但当前运行的程序仍加载着旧数据。请重启应用以载入恢复后的数据（包括对话记录）。
            </p>
            <button
              type="button"
              onClick={() => {
                void restartApp();
              }}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700"
            >
              重启应用
            </button>
          </div>
        )}
        <div className="space-y-3">
          <div className="grid grid-cols-[120px_1fr] gap-4">
            <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">
              备份文件
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                onClick={handlePickImportSource}
              >
                选择文件…
              </button>
              <span className="min-w-0 flex-1 truncate break-all text-xs text-slate-500">
                {importSource || "未选择"}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-[120px_1fr] gap-4">
            <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">
              恢复目录
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                onClick={handlePickImportTarget}
              >
                选择目录…
              </button>
              <span className="min-w-0 flex-1 truncate break-all text-xs text-slate-500">
                {importTarget || "未选择"}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-[120px_1fr] gap-4">
            <label className="pt-2 text-right text-sm text-slate-700 omni-settings-label">
              解密密码
            </label>
            <input
              type="password"
              value={importSecret}
              onChange={(e) => setImportSecret(e.target.value)}
              placeholder="加密备份需要填写"
              className="h-9 w-full rounded-md border border-slate-300 px-3 text-sm"
            />
          </div>
          <div className="flex items-center gap-2 pl-[136px]">
            <button
              type="button"
              className="rounded-md bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              onClick={handleImport}
              disabled={busy !== null || !importSource || !importTarget}
            >
              {busy === "import" ? "恢复中…" : "导入并恢复"}
            </button>
            <span className="text-xs text-slate-500 omni-settings-muted">
              恢复后会把数据位置切换到所选目录。
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
