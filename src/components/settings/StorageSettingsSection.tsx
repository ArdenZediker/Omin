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
          ? "omni-pet-import-status--success"
          : "omni-model-warning-box omni-model-warning-text"
      }`}
    >
      {message.text}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-4">
      <span className="omni-settings-label pt-1 text-right text-sm">
        {label}
      </span>
      <span className="omni-model-code break-all rounded-md px-2 py-1 text-xs">
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
  // 产出根目录默认不暴露：导出默认落到会话工作目录下的 Omni-导出。仅当用户主动勾选覆盖时才展开输入框。
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
      setNeedsRestart(Boolean(next?.pendingRestart));
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
      setNeedsRestart(next.pendingRestart);
      setMessage({
        kind: "ok",
        text: "数据已完整迁移到新目录；当前进程仍使用旧目录，重启后切换。旧目录暂未删除。",
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
      setNeedsRestart(next.pendingRestart);
      setMessage({
        kind: "ok",
        text: next.pendingRestart
          ? "数据已迁移到默认存储位置；重启后切换。原目录的数据仍保留。"
          : "当前已使用默认存储位置，无需重启。",
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
        text: `已从备份恢复到：${importTarget}；重启后切换（格式版本 ${manifest.formatVersion}）`,
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
    <section className="omni-settings-card space-y-5 rounded-xl border p-5">
      <div className="omni-model-section-divider border-b pb-3">
        <h3 className="omni-settings-title text-sm font-medium">
          产物归档位置
        </h3>
        <p className="omni-settings-muted mt-1 text-xs">
          导出的文件（文档/表格/演示/Markdown）默认存放到「会话工作目录下的{" "}
          <code className="omni-model-code rounded px-1">
            Omni-导出
          </code>{" "}
          文件夹」，并按「日期 / 项目 / 会话」自动分子目录。产物属于你的项目文件，可随项目一起
          git 提交、团队共享；因此它不包含在应用备份中，删除会话也不会删除它。通常无需设置。
        </p>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-[120px_1fr] gap-4">
          <label className="omni-settings-label pt-2 text-right text-sm">
            归档位置
          </label>
          <div className="space-y-2">
            <label className="omni-settings-title flex items-center gap-2 text-sm">
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
              固定归档到其它目录（覆盖默认的会话工作目录位置）
            </label>

            {useOutputOverride && (
              <div className="omni-persona-memory-card space-y-2 rounded-lg p-3">
                <span className="omni-model-code block break-all rounded-md px-2 py-1 text-xs">
                  {outputRoot || "未选择目录"}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="omni-knowledge-button omni-knowledge-button--secondary px-3 py-1.5 text-xs font-medium"
                    onClick={handlePickOutputRoot}
                  >
                    选择目录…
                  </button>
                  <button
                    type="button"
                    className="omni-knowledge-button omni-knowledge-button--secondary px-3 py-1.5 text-xs font-medium"
                    onClick={() => {
                      setOutputRootSetting("");
                      setOutputRoot("");
                    }}
                  >
                    清除
                  </button>
                </div>
                <p className="omni-model-hint text-xs">
                  设置后，所有导出将固定落到此目录（按「日期 / 项目 / 会话」分子目录），
                  不再跟随会话工作目录。注意：该目录不在应用备份范围内。
                </p>
              </div>
            )}

            {!useOutputOverride && (
              <p className="omni-model-hint text-xs">
                默认：导出到会话工作目录下的{" "}
                <code className="omni-model-code rounded px-1">
                  Omni-导出
                </code>
                。如想把生成文件固定归档到别处，勾选上方选项即可。
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="omni-model-section-divider space-y-4 border-t pt-4">
        <h3 className="omni-settings-title text-sm font-medium">
          默认工作空间
        </h3>
        <div className="grid grid-cols-[120px_1fr] gap-4">
          <label className="omni-settings-label pt-2 text-right text-sm">
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
              className="omni-knowledge-model-input h-9 w-full rounded-[8px] px-3 text-sm"
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
              className="omni-knowledge-button omni-knowledge-button--secondary h-9 shrink-0 px-3 text-sm"
            >
              选择目录
            </button>
          </div>
        </div>
        <p className="omni-settings-muted pl-[136px] text-xs">
          未单独配置工作目录的项目与任务会话，自动共用此目录作为工作空间；在项目设置里单独填了「工作目录」的会以项目为准。留空时，未绑定会话将使用兜底工作目录：
          {fallbackWorkspaceHint ? (
            <code className="omni-model-code ml-1 rounded px-1 py-0.5 text-[11px]">
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

      <div className="omni-model-section-divider space-y-4 border-t pt-4">
        <h3 className="omni-settings-title text-sm font-medium">
          高级 · 应用数据存储
        </h3>

        <StatusBanner message={message} />

        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                info ? "omni-knowledge-chip--capability" : "omni-knowledge-chip"
              }`}
            >
              {loading ? "读取中…" : info ? SOURCE_LABEL[info.source] : "未知"}
            </span>
            {info && !info.writable && (
              <span className="omni-knowledge-chip omni-knowledge-chip--warning rounded-full px-2.5 py-1 text-[11px] font-medium">
                目录不可写
              </span>
            )}
            {info?.fallbackReason && (
              <span className="omni-knowledge-chip omni-knowledge-chip--warning rounded-full px-2.5 py-1 text-[11px] font-medium">
                {info.pendingRestart ? "待重启" : "已回退"}
              </span>
            )}
          </div>

          {loading ? (
            <div className="omni-model-hint text-xs">正在读取当前数据目录…</div>
          ) : info ? (
            <div className="space-y-2">
              <InfoRow label="数据根目录" value={info.path} />
              <InfoRow label="数据库" value={info.databasePath} />
              <InfoRow label="知识库" value={info.knowledgePath} />
              <InfoRow label="会话目录" value={info.chatSessionsPath} />
              {info.fallbackReason && (
                <div className="omni-model-warning-box omni-model-warning-text rounded-lg px-3 py-2 text-xs">
                  {info.fallbackReason}
                </div>
              )}
            </div>
          ) : (
            <div className="omni-model-hint text-xs">无法读取数据目录信息。</div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="omni-knowledge-button omni-knowledge-button--primary px-3 py-2 text-xs font-medium disabled:opacity-50"
            onClick={handleOpen}
            disabled={busy !== null || !info}
          >
            打开数据目录
          </button>
          <button
            type="button"
            className="omni-knowledge-button omni-knowledge-button--secondary px-3 py-2 text-xs font-medium disabled:opacity-50"
            onClick={handlePickRoot}
            disabled={busy !== null || needsRestart}
          >
            更改存储位置…
          </button>
          <button
            type="button"
            className="omni-knowledge-button omni-knowledge-button--secondary px-3 py-2 text-xs font-medium disabled:opacity-50"
            onClick={handleReset}
            disabled={busy !== null || needsRestart}
          >
            恢复默认位置
          </button>
        </div>

        {needsRestart && (
          <div className="omni-model-warning-box omni-model-warning-text rounded-lg px-3 py-3 text-xs">
            <p className="mb-2 font-medium">
              数据目录变更已准备完成，但当前程序仍使用旧目录。请重启应用以切换到新目录。
            </p>
            <button
              type="button"
              onClick={() => {
                void restartApp();
              }}
              className="omni-knowledge-button omni-knowledge-button--primary px-3 py-1.5 text-xs font-medium"
            >
              重启应用
            </button>
          </div>
        )}

        <p className="omni-settings-muted text-xs leading-5">
          迁移目标必须是空目录，迁移完成后需重启应用；源目录会保留，不会自动删除。不要把数据目录放进云同步盘（OneDrive / Dropbox /
          百度网盘等）或网络盘——SQLite 的 WAL 模式在这些位置可能静默损坏。
          软件安装在{" "}
          <code className="omni-model-code rounded px-1">
            Program Files
          </code>{" "}
          等只读位置时，会自动改用应用数据目录。
        </p>
      </div>

      <div className="omni-model-section-divider space-y-4 border-t pt-4">
        <h3 className="omni-settings-title text-sm font-medium">
          整库备份
        </h3>
        <div className="space-y-3">
          <div className="grid grid-cols-[120px_1fr] gap-4">
            <label className="omni-settings-label pt-2 text-right text-sm">
              加密密码
            </label>
            <input
              type="password"
              value={exportSecret}
              onChange={(e) => setExportSecret(e.target.value)}
              placeholder="可选，留空则不加密"
              className="omni-knowledge-model-input h-9 w-full rounded-[8px] px-3 text-sm"
            />
          </div>
          <div className="flex items-center gap-2 pl-[136px]">
            <button
              type="button"
              className="omni-knowledge-button omni-knowledge-button--secondary px-3 py-2 text-xs font-medium disabled:opacity-50"
              onClick={handleExport}
              disabled={busy !== null}
            >
              {busy === "export" ? "导出中…" : "导出备份…"}
            </button>
            <span className="omni-settings-muted text-xs">
              导出为 .zip，含数据库、知识库与全部对话记录。
            </span>
          </div>
          <p className="omni-settings-muted pl-[136px] text-xs leading-5">
            备份包含 API Key 等敏感配置；设置密码后会用 AES-256
            加密整个压缩包，导入时须输入相同密码。
          </p>
        </div>
      </div>

      <div className="omni-model-section-divider space-y-4 border-t pt-4">
        <h3 className="omni-settings-title text-sm font-medium">
          从备份恢复
        </h3>
        <div className="space-y-3">
          <div className="grid grid-cols-[120px_1fr] gap-4">
            <label className="omni-settings-label pt-2 text-right text-sm">
              备份文件
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="omni-knowledge-button omni-knowledge-button--secondary shrink-0 px-3 py-2 text-xs font-medium"
                onClick={handlePickImportSource}
              >
                选择文件…
              </button>
              <span className="omni-settings-muted min-w-0 flex-1 truncate break-all text-xs">
                {importSource || "未选择"}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-[120px_1fr] gap-4">
            <label className="omni-settings-label pt-2 text-right text-sm">
              恢复目录
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="omni-knowledge-button omni-knowledge-button--secondary shrink-0 px-3 py-2 text-xs font-medium"
                onClick={handlePickImportTarget}
              >
                选择目录…
              </button>
              <span className="omni-settings-muted min-w-0 flex-1 truncate break-all text-xs">
                {importTarget || "未选择"}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-[120px_1fr] gap-4">
            <label className="omni-settings-label pt-2 text-right text-sm">
              解密密码
            </label>
            <input
              type="password"
              value={importSecret}
              onChange={(e) => setImportSecret(e.target.value)}
              placeholder="加密备份需要填写"
              className="omni-knowledge-model-input h-9 w-full rounded-[8px] px-3 text-sm"
            />
          </div>
          <div className="flex items-center gap-2 pl-[136px]">
            <button
              type="button"
              className="omni-knowledge-button omni-knowledge-button--primary px-3 py-2 text-xs font-medium disabled:opacity-50"
              onClick={handleImport}
              disabled={busy !== null || needsRestart || !importSource || !importTarget}
            >
              {busy === "import" ? "恢复中…" : "导入并恢复"}
            </button>
            <span className="omni-settings-muted text-xs">
              恢复后会把数据位置切换到所选目录。
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
