import type { CodexPetLibraryState, CodexPetPackage } from "../../app/pets/codexPetTypes";

type Props = {
  packages: CodexPetPackage[];
  state: CodexPetLibraryState;
  codexHome: string;
  onSelectPet: (petId: string) => void;
  onCreatePet: () => Promise<void> | void;
  onRefreshPets: () => Promise<void> | void;
};

export default function CodexPetSection({ packages, state, codexHome, onSelectPet, onCreatePet, onRefreshPets }: Props) {
  const activePackage = packages.find((pet) => pet.id === state.activePetId) ?? null;

  return (
    <section className="space-y-4 rounded-[22px] border border-slate-200 bg-slate-50/90 p-5 shadow-sm omni-settings-card">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Codex Pet</div>
          <h3 className="mt-1 text-sm font-semibold text-slate-900 omni-settings-title">宠物包</h3>
          <p className="mt-1 text-xs text-slate-500 omni-settings-muted">
            这里显示 {codexHome || "~/.codex"}/pets 下的本地宠物包，每个包只需要 `pet.json` 和 `spritesheet.webp`。
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center rounded-full bg-slate-200 px-3 py-1 text-[11px] font-medium text-slate-600">
          {packages.length} 个包
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">当前激活包</div>
              <div className="mt-1 truncate text-sm font-semibold text-slate-900">{activePackage?.displayName || "未选择"}</div>
              <div className="mt-1 text-xs text-slate-500">{activePackage ? activePackage.description : "请选择一个本地宠物包"}</div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => void onCreatePet()}
                className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 transition-colors hover:bg-slate-100"
              >
                创建自己的宠物
              </button>
              <button
                type="button"
                onClick={() => void onRefreshPets()}
                className="rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 transition-colors hover:bg-slate-100"
              >
                刷新
              </button>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">宠物包列表</div>
              <div className="mt-1 text-[11px] text-slate-500">单列滚动，点击即可切换激活包。</div>
            </div>
          </div>
          <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {packages.map((pet) => {
              const isActive = pet.id === state.activePetId;
              return (
                <button
                  key={pet.id}
                  type="button"
                  onClick={() => onSelectPet(pet.id)}
                  className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${
                    isActive ? "border-violet-300 bg-violet-50 shadow-sm" : "border-slate-200 bg-slate-50/70 hover:border-slate-300 hover:bg-white"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900">{pet.displayName}</div>
                      <div className="mt-1 text-xs leading-5 text-slate-500">{pet.description}</div>
                    </div>
                    <div
                      className={`shrink-0 rounded-full px-2 py-1 text-[11px] ${
                        isActive ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-400"
                      }`}
                    >
                      {isActive ? "当前激活" : pet.source === "custom" ? "自定义" : "内置"}
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] text-slate-400">{pet.spritesheetPath}</div>
                </button>
              );
            })}
            {packages.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-6 text-center text-xs text-slate-500">
                没有找到宠物包。请在 {codexHome || "~/.codex"}/pets/&lt;pet-name&gt;/ 中放入 `pet.json` 和 `spritesheet.webp`。
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
