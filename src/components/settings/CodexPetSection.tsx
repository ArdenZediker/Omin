import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "../../app/storageApi";
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
    <section className="omni-settings-card overflow-hidden rounded-2xl border">
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} className="flex w-full items-start justify-between gap-4 px-5 py-4 text-left">
        <div>
          <div className="omni-settings-title text-sm font-medium">宠物</div>
          <div className="omni-settings-muted mt-1 text-sm">{activePackage ? `已选择 ${activePackage.displayName}` : "未选择宠物"}</div>
        </div>
        <div className="omni-settings-muted pt-0.5">{expanded ? <ChevronUp aria-hidden="true" size={16} strokeWidth={1.8} /> : <ChevronDown aria-hidden="true" size={16} strokeWidth={1.8} />}</div>
      </button>

      {expanded && (
        <>
          <div className="omni-pet-actions omni-model-section-divider border-t px-5 py-3">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => void handleImportPet()}
                disabled={isImporting}
                title={petFormatHint}
                className="omni-pet-action-button rounded-full px-4 py-2 text-sm"
              >
                {isImporting ? "导入中..." : "导入宠物"}
              </button>
              <button
                type="button"
                onClick={() => void onRefreshPets()}
                className="omni-pet-action-button rounded-full px-4 py-2 text-sm"
              >
                刷新
              </button>
              <button
                type="button"
                onClick={() => void onEnableDesktopPet()}
                className="omni-pet-action-button rounded-full px-4 py-2 text-sm"
              >
                {isDesktopPetAwake ? "收起宠物" : "唤醒宠物"}
              </button>
            </div>
            <div className="omni-pet-format-hint omni-model-section-divider mt-2 rounded-xl border px-3 py-2 text-xs leading-5">
              <div className="omni-settings-title font-medium">宠物包格式</div>
              <div className="mt-0.5">
                选择一个宠物包文件夹，需包含 <code className="omni-pet-code rounded px-1">pet.json</code> 和贴图文件，
                可使用 Codex 同款宠物文件。
                <code className="omni-pet-code ml-1 rounded px-1">pet.json</code> 字段：
                <code className="omni-pet-code ml-1 rounded px-1">id</code>、
                <code className="omni-pet-code ml-1 rounded px-1">displayName</code>、
                <code className="omni-pet-code ml-1 rounded px-1">description</code>、
                <code className="omni-pet-code ml-1 rounded px-1">spritesheetPath</code>。
              </div>
            </div>
            {importStatus ? (
              <div
                className={`omni-pet-import-status mt-3 rounded-lg border px-3 py-2 text-xs ${
                  importStatus.tone === "error"
                    ? "omni-model-warning-box omni-model-warning-text"
                    : "omni-pet-import-status--success"
                }`}
              >
                {importStatus.message}
              </div>
            ) : null}
          </div>

          <div className="omni-pet-custom-section omni-model-section-divider border-t px-5 py-3 text-xs">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="omni-settings-title font-medium">自定义宠物</div>
                <div className="mt-0.5 truncate">{projectPetsRoot || "当前项目宠物目录"}</div>
              </div>
              <button
                type="button"
                onClick={() => void handleOpenFolder()}
                className="omni-settings-muted shrink-0 text-xs hover:text-[var(--omni-app-text)]"
              >
                打开文件夹 ↗
              </button>
            </div>
          </div>

          <div className="omni-pet-list omni-model-section-divider max-h-[360px] overflow-y-auto overscroll-contain border-t pr-1 [scrollbar-gutter:stable]">
            {packages.map((pet) => {
              const isActive = pet.id === state.activePetId;
              return (
                <button
                  key={pet.id}
                  type="button"
                  onClick={() => onSelectPet(pet.id)}
                  className="omni-pet-list-item omni-model-section-divider flex w-full items-center gap-3 border-b px-5 py-3 text-left transition-colors last:border-b-0"
                >
                  <div className="omni-pet-preview flex h-[54px] w-[54px] shrink-0 items-end justify-center overflow-hidden rounded-xl border">
                    <DesktopPet width={previewSize.width} height={previewSize.height} state="idle" packageData={pet} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="omni-pet-name text-[15px] font-medium">{pet.displayName}</div>
                    <div className="omni-pet-description mt-0.5 text-sm">{pet.description}</div>
                  </div>

                  <div className="shrink-0">
                    <span
                      className={`omni-pet-select-badge inline-flex rounded-full px-3 py-1.5 text-sm ${
                        isActive ? "omni-pet-select-badge--active" : "omni-pet-select-badge"
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
