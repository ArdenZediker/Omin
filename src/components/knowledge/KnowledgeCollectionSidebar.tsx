import { EllipsisVertical, PanelLeftOpen, Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { KnowledgeCollection } from "../../chat/knowledgeTypes";

export type KnowledgeSidebarCategory = {
  id: string;
  title: string;
  icon: LucideIcon;
  count: number;
  description: string;
};

type KnowledgeCollectionSidebarProps = {
  isCollapsed: boolean;
  /** 收起态下唯一显示的"展开"按钮会调用此回调。 */
  onToggleCollapsed?: () => void;
  categories: KnowledgeSidebarCategory[];
  activeCategoryId: string;
  collections: KnowledgeCollection[];
  activeCollectionId: string | null;
  openCollectionMenuId: string | null;
  onSelectCategory: (categoryId: string) => void;
  onCreateCollection: () => void;
  onSelectCollection: (collectionId: string) => void;
  onToggleCollectionMenu: (collectionId: string) => void;
  onOpenCollectionSettings: (collection: KnowledgeCollection) => void;
  onDeleteCollection: (collectionId: string) => void;
};

function getCategoryIconColor(categoryId: string) {
  if (categoryId === "all") {
    return "#2563eb";
  }
  if (categoryId === "docs") {
    return "#3b82f6";
  }
  if (categoryId === "images") {
    return "#f59e0b";
  }
  if (categoryId === "audio") {
    return "#10b981";
  }
  return "#8b5cf6";
}

function KnowledgeCollectionIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className={className}>
      <path d="M4.25 2.5h6.2L12.25 4.3v9.2H4.25z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M10.45 2.5V4.25h1.8" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M5.1 6.35h5.1" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" />
      <path d="M5.1 8.45h3.8" stroke="currentColor" strokeWidth="1.05" strokeLinecap="round" />
    </svg>
  );
}

export default function KnowledgeCollectionSidebar({
  isCollapsed,
  onToggleCollapsed,
  categories,
  activeCategoryId,
  collections,
  activeCollectionId,
  openCollectionMenuId,
  onSelectCategory,
  onCreateCollection,
  onSelectCollection,
  onToggleCollectionMenu,
  onOpenCollectionSettings,
  onDeleteCollection,
}: KnowledgeCollectionSidebarProps) {
  // 收起态：不再 return null，保留一个 64px 宽的图标列占位。这避免 main 区域
  // 在 sidebar 收起后撑满整个 viewport，导致 KB header 卡片宽度突然比 chat
  // toolbar 卡片"宽出 ~280px"。chat 视图收起 sidebar 时是用 CSS flex-basis:0 +
  // width:0 把容器压成 0px（保留 DOM 节点占位），这里也类似但保留固定 64px
  // 让 KB 顶部栏 ↔ 左侧边缘的视觉距离稳定，不随 sidebar 状态变化。
  if (isCollapsed) {
    return (
      <aside className="omni-knowledge-sidebar omni-knowledge-sidebar--collapsed flex min-h-0 shrink-0 flex-col items-center pt-3">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="no-drag flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-900"
          title="展开侧栏"
          aria-label="展开侧栏"
        >
          <PanelLeftOpen size={16} strokeWidth={2} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="omni-knowledge-sidebar flex min-h-0 shrink-0 flex-col border-r border-slate-200 bg-slate-50">
      <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-3">
        <div className="min-w-0">
          <div className="truncate text-base font-semibold tracking-[-0.02em] text-slate-950">文件</div>
          <div className="mt-0.5 text-xs text-slate-500">知识库与分类</div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="space-y-1 px-3 py-3">
          {categories.map((category) => {
            const Icon = category.icon;
            const isActive = category.id === activeCategoryId;
            const categoryIconColor = getCategoryIconColor(category.id);

            return (
              <button
                key={category.id}
                type="button"
                onClick={() => onSelectCategory(category.id)}
                className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm transition ${
                  isActive
                    ? "border-slate-950 bg-white text-slate-950 shadow-sm"
                    : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                }`}
                title={category.title}
              >
                <span className={`flex h-5 w-5 items-center justify-center rounded-lg ${isActive ? "text-slate-950" : "text-slate-500"}`}>
                  <Icon size={13} strokeWidth={1.8} stroke={categoryIconColor} color={categoryIconColor} />
                </span>
                <span className="flex-1">{category.title}</span>
                <span className="text-[11px] text-slate-400">{category.count}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-2 border-t border-slate-200 px-4 pt-3">
          <div className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
            <span>知识库</span>
            <button
              type="button"
              className="no-drag rounded-lg p-1 text-slate-400 hover:bg-white hover:text-slate-700"
              title="新建知识库"
              onClick={onCreateCollection}
            >
              <Plus size={14} strokeWidth={2} />
            </button>
          </div>

          <div className="space-y-1">
            {collections.map((collection) => {
              const isActive = collection.id === activeCollectionId;
              return (
                <div
                  key={collection.id}
                  className={`flex items-center gap-1 rounded-xl border px-1 py-0.5 text-sm transition ${
                    isActive
                      ? "border-[var(--omni-app-text)] bg-[var(--omni-panel-bg)] text-[var(--omni-app-text)] shadow-sm"
                      : "border-[var(--omni-panel-border)] bg-[var(--omni-panel-bg)] text-[var(--omni-app-muted)] hover:bg-[var(--omni-soft-bg)] hover:text-[var(--omni-app-text)]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectCollection(collection.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1 text-left"
                    title={collection.name}
                  >
                    <KnowledgeCollectionIcon className="h-4 w-4 shrink-0 text-blue-500" />
                    <span className="flex-1 truncate">{collection.name}</span>
                  </button>

                  <div className="relative">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleCollectionMenu(collection.id);
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--omni-app-muted)] hover:bg-[var(--omni-soft-bg)] hover:text-[var(--omni-app-text)]"
                      title="更多操作"
                    >
                      <EllipsisVertical size={14} strokeWidth={2} />
                    </button>

                    {openCollectionMenuId === collection.id ? (
                      <div
                        className="absolute right-0 top-8 z-20 w-32 overflow-hidden rounded-xl border border-[var(--omni-panel-border)] bg-[var(--omni-panel-bg)] py-1 shadow-lg"
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          className="flex w-full items-center px-3 py-2 text-left text-sm text-[var(--omni-app-text)] hover:bg-[var(--omni-soft-bg)]"
                          onClick={() => onOpenCollectionSettings(collection)}
                        >
                          设置
                        </button>
                        <button
                          type="button"
                          className="flex w-full items-center px-3 py-2 text-left text-sm text-rose-500 hover:bg-rose-500/10"
                          onClick={() => onDeleteCollection(collection.id)}
                        >
                          删除
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mt-auto border-t border-slate-200 p-3">
        <button
          type="button"
          className="flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          onClick={onCreateCollection}
        >
          <Plus size={14} strokeWidth={2} />
          新建知识库
        </button>
      </div>
    </aside>
  );
}
