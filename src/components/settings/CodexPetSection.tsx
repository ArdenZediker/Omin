import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { fitCodexPetToBounds } from "../../app/pets/codexPetSizing";
import type { CodexPetLibraryState, CodexPetPackage } from "../../app/pets/codexPetTypes";
import DesktopPet from "../DesktopPet";

type Props = {
  packages: CodexPetPackage[];
  state: CodexPetLibraryState;
  projectPetsRoot: string;
  isDesktopPetAwake: boolean;
  onEnableDesktopPet: () => Promise<void> | void;
  onSelectPet: (petId: string) => void;
  onImportPet: () => Promise<boolean>;
  onRefreshPets: () => Promise<void> | void;
};

export default function CodexPetSection({
  packages,
  state,
  projectPetsRoot,
  isDesktopPetAwake,
  onEnableDesktopPet,
  onSelectPet,
  onImportPet,
  onRefreshPets,
}: Props) {
  const [expanded, setExpanded] = useState(true);
  const [importStatus, setImportStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const activePackage = packages.find((pet) => pet.id === state.activePetId) ?? null;
  const previewSize = fitCodexPetToBounds({ width: 54, height: 54 });
  const petFormatHint = "请选择宠物包文件夹，文件夹内必须包含 pet.json 和贴图文件，可使用 Codex 同款宠物文件。pet.json 需要包含 id、displayName、description、spritesheetPath，其中 spritesheetPath 必须指向文件夹内的相对路径。";
  const handleOpenFolder = async () => {
    const folderPath = projectPetsRoot;
    try {
      await revealItemInDir(folderPath);
    } catch (error) {
      console.error("打开宠物文件夹失败", error);
    }
  };

  const handleImportPet = async () => {
    setIsImporting(true);
    setImportStatus(null);
    try {
      const imported = await onImportPet();
      if (imported) {
        setImportStatus({ tone: "success", message: "宠物已导入并加入列表。" });
      }
    } catch (error) {
      setImportStatus({
        tone: "error",
        message: error instanceof Error ? error.message : "导入宠物失败，请检查宠物文件夹。",
      });
    } finally {
      setIsImporting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void invoke<string>("load_workspace_pet_dir_command").catch(() => {
      if (!cancelled) {
        console.error("读取当前项目宠物目录失败");
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm omni-settings-card">
      <button type="button" onClick={() => setExpanded((value) => !value)} className="flex w-full items-start justify-between gap-4 px-5 py-4 text-left">
        <div>
          <div className="text-sm font-medium text-slate-900">宠物</div>
          <div className="mt-1 text-sm text-slate-500">{activePackage ? `已选择 ${activePackage.displayName}` : "未选择宠物"}</div>
        </div>
        <div className="pt-0.5 text-slate-400">{expanded ? "⌃" : "⌄"}</div>
      </button>

      {expanded && (
        <>
          <div className="border-t border-slate-100 px-5 py-3">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleImportPet()}
                disabled={isImporting}
                title={petFormatHint}
                className="rounded-full bg-slate-100 px-4 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-200"
              >
                {isImporting ? "导入中..." : "导入宠物"}
              </button>
              <button
                type="button"
                onClick={() => void onRefreshPets()}
                className="rounded-full bg-slate-100 px-4 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-200"
              >
                刷新
              </button>
              <button
                type="button"
                onClick={() => void onEnableDesktopPet()}
                className="rounded-full bg-slate-100 px-4 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-200"
              >
                {isDesktopPetAwake ? "收起宠物" : "唤醒宠物"}
              </button>
            </div>
            <div className="mt-2 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
              <div className="font-medium text-slate-700">宠物包格式</div>
              <div className="mt-0.5">
                选择一个宠物包文件夹，需包含 <code className="rounded bg-white px-1 text-slate-600">pet.json</code> 和贴图文件，
                可使用 Codex 同款宠物文件。
                <code className="ml-1 rounded bg-white px-1 text-slate-600">pet.json</code> 字段：
                <code className="ml-1 rounded bg-white px-1 text-slate-600">id</code>、
                <code className="ml-1 rounded bg-white px-1 text-slate-600">displayName</code>、
                <code className="ml-1 rounded bg-white px-1 text-slate-600">description</code>、
                <code className="ml-1 rounded bg-white px-1 text-slate-600">spritesheetPath</code>。
              </div>
            </div>
            {importStatus ? (
              <div
                className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
                  importStatus.tone === "error"
                    ? "border-rose-200 bg-rose-50 text-rose-700"
                    : "border-emerald-200 bg-emerald-50 text-emerald-700"
                }`}
              >
                {importStatus.message}
              </div>
            ) : null}
          </div>

          <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="font-medium text-slate-700">自定义宠物</div>
                <div className="mt-0.5 truncate">{projectPetsRoot || "当前项目宠物目录"}</div>
              </div>
              <button
                type="button"
                onClick={() => void handleOpenFolder()}
                className="shrink-0 text-slate-400 text-xs hover:text-slate-600"
              >
                打开文件夹 ↗
              </button>
            </div>
          </div>

          <div className="max-h-[360px] overflow-y-auto overscroll-contain border-t border-slate-100 pr-1 [scrollbar-gutter:stable]">
            {packages.map((pet) => {
              const isActive = pet.id === state.activePetId;
              return (
                <button
                  key={pet.id}
                type="button"
                onClick={() => onSelectPet(pet.id)}
                className="flex w-full items-center gap-3 border-b border-slate-100 px-5 py-3 text-left transition-colors last:border-b-0 hover:bg-slate-50"
              >
                <div className="flex h-[54px] w-[54px] shrink-0 items-end justify-center overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
                    <DesktopPet width={previewSize.width} height={previewSize.height} state="idle" packageData={pet} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-medium text-slate-900">{pet.displayName}</div>
                    <div className="mt-0.5 text-sm text-slate-500">{pet.description}</div>
                  </div>

                  <div className="shrink-0">
                    <span
                      className={`inline-flex rounded-full px-3 py-1.5 text-sm ${
                        isActive ? "bg-slate-100 text-slate-400" : "bg-slate-100 text-slate-700"
                      }`}
                    >
                      {isActive ? "已选" : "选择"}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
