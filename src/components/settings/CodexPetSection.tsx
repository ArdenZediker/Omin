import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { CodexPetLibraryState, CodexPetPackage } from "../../app/pets/codexPetTypes";
import DesktopPet from "../DesktopPet";

type Props = {
  packages: CodexPetPackage[];
  state: CodexPetLibraryState;
  codexHome: string;
  isDesktopPetAwake: boolean;
  onEnableDesktopPet: () => Promise<void> | void;
  onSelectPet: (petId: string) => void;
  onCreatePet: () => Promise<void> | void;
  onRefreshPets: () => Promise<void> | void;
};

export default function CodexPetSection({
  packages,
  state,
  codexHome,
  isDesktopPetAwake,
  onEnableDesktopPet,
  onSelectPet,
  onCreatePet,
  onRefreshPets,
}: Props) {
  const [expanded, setExpanded] = useState(true);
  const [projectPetsRoot, setProjectPetsRoot] = useState(codexHome || "");
  const activePackage = packages.find((pet) => pet.id === state.activePetId) ?? null;
  const handleOpenFolder = async () => {
    const folderPath = projectPetsRoot || codexHome || "~/.codex";
    try {
      await revealItemInDir(folderPath);
    } catch (error) {
      console.error("打开宠物文件夹失败", error);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void invoke<string>("load_workspace_pet_dir_command")
      .then((path) => {
        if (!cancelled) {
          setProjectPetsRoot(path);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProjectPetsRoot(codexHome || "");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [codexHome]);

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
                onClick={() => void onCreatePet()}
                className="rounded-full bg-slate-100 px-4 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-200"
              >
                创建自己的宠物
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
          </div>

          <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="font-medium text-slate-700">自定义宠物</div>
                <div className="mt-0.5 truncate">{projectPetsRoot || codexHome || "~/.codex"}</div>
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

          <div className="border-t border-slate-100">
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
                    <DesktopPet width={34} height={40} state="idle" packageData={pet} />
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
