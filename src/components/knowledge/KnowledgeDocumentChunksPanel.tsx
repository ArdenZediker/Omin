import type { ReactNode, RefObject } from "react";
import { Search, X } from "lucide-react";
import type { KnowledgeDocumentChunk } from "../../chat/knowledgeTypes";

type KnowledgeDocumentChunksPanelProps = {
  chunks: KnowledgeDocumentChunk[];
  totalChunkCount: number;
  searchQuery: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSearchQueryChange: (value: string) => void;
  renderHighlightedSearchText: (text: string, query: string) => ReactNode;
  formatTimestamp: (timestamp?: number | null) => string;
};

export default function KnowledgeDocumentChunksPanel({
  chunks,
  totalChunkCount,
  searchQuery,
  searchInputRef,
  onSearchQueryChange,
  renderHighlightedSearchText,
  formatTimestamp,
}: KnowledgeDocumentChunksPanelProps) {
  const resultCountLabel = searchQuery ? ` · 命中 ${chunks.length} 个` : "";

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-none border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-950">分片</div>
          <div className="mt-1 text-xs text-slate-500">
            共 {totalChunkCount} 个分片{resultCountLabel}
          </div>
        </div>
        <div className="flex h-8 w-full max-w-xs items-center gap-2 rounded-none border border-slate-200 bg-white px-2.5">
          <Search size={14} strokeWidth={1.8} className="shrink-0 text-slate-400" />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                if (searchQuery) {
                  onSearchQueryChange("");
                } else {
                  event.currentTarget.blur();
                }
              }
            }}
            placeholder="搜索当前分片"
            className="w-full min-w-0 border-0 bg-transparent text-sm outline-none placeholder:text-slate-400"
          />
          {searchQuery ? (
            <button
              type="button"
              onClick={() => {
                onSearchQueryChange("");
                searchInputRef.current?.focus();
              }}
              className="inline-flex h-5 w-5 items-center justify-center rounded-none text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label="清空分片搜索"
            >
              <X size={12} strokeWidth={2} />
            </button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {chunks.map((chunk) => (
          <div key={chunk.id} className="rounded-none border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-slate-950">
                  {renderHighlightedSearchText(`第 ${chunk.chunkIndex + 1} 片${chunk.title ? ` · ${chunk.title}` : ""}`, searchQuery)}
                </div>
              </div>
              <div className="shrink-0 text-xs text-slate-400">{formatTimestamp(chunk.createdAt)}</div>
            </div>
            <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">
              {renderHighlightedSearchText(chunk.content, searchQuery)}
            </div>
          </div>
        ))}

        {totalChunkCount === 0 ? (
          <div className="rounded-none border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
            当前文档还没有分片
          </div>
        ) : searchQuery && chunks.length === 0 ? (
          <div className="rounded-none border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500">
            未找到匹配的分片
          </div>
        ) : null}
      </div>
    </section>
  );
}
