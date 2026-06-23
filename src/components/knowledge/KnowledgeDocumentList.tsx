import { Trash2 } from "lucide-react";
import type { KnowledgeDocument } from "../../chat/knowledgeTypes";
import { getProcessingStatusLabel, getVectorizationLabel } from "./knowledgeViewHelpers";

type KnowledgeDocumentListProps = {
  documents: KnowledgeDocument[];
  selectedDocumentId: string | null;
  openDocumentMenuId: string | null;
  thumbnailDataUrlById: Map<string, string | undefined>;
  onOpenDocument: (documentId: string) => void;
  onOpenDocumentMenu: (documentId: string) => void;
  onCloseDocumentMenu: () => void;
  onDeleteDocument: (documentId: string) => void;
};

export default function KnowledgeDocumentList({
  documents,
  selectedDocumentId,
  openDocumentMenuId,
  thumbnailDataUrlById,
  onOpenDocument,
  onOpenDocumentMenu,
  onCloseDocumentMenu,
  onDeleteDocument,
}: KnowledgeDocumentListProps) {
  return (
    <section className="no-drag flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 overflow-y-auto pt-3">
        <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(168px,1fr))] content-start gap-3">
          {documents.map((document) => {
            const isActive = document.id === selectedDocumentId;
            const thumbnailDataUrl = thumbnailDataUrlById.get(document.id);
            const fileBadge = thumbnailDataUrl ? (
              <img src={thumbnailDataUrl} alt={document.sourceName} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-900 via-slate-700 to-slate-500 text-[10px] font-semibold text-white">
                {document.sourceName.slice(0, 2).toUpperCase()}
              </div>
            );

            return (
              <div
                key={document.id}
                className={`group relative flex h-[170px] min-w-0 flex-col rounded-lg border p-2 text-left transition ${
                  isActive ? "border-slate-950 bg-white text-slate-950 shadow-sm" : "border-slate-200 bg-white text-slate-900 hover:bg-slate-50"
                }`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  onOpenDocumentMenu(document.id);
                }}
              >
                <button
                  type="button"
                  onClick={() => onOpenDocument(document.id)}
                  className="flex min-w-0 flex-1 flex-col items-stretch gap-1.5 text-left"
                >
                  <div className="h-[86px] w-full overflow-hidden rounded-md bg-slate-100">{fileBadge}</div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <div className="line-clamp-2 text-[12px] font-medium leading-4">{document.sourceName}</div>
                    {document.errorMessage ? <div className="mt-1 line-clamp-1 text-xs text-red-500">{document.errorMessage}</div> : null}
                    <div className="mt-auto flex items-center justify-between gap-2 pt-2">
                      <span className="shrink-0 rounded-none border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">
                        {getProcessingStatusLabel(document.processingStatus)}
                      </span>
                      <span className="shrink-0 rounded-full border border-slate-200 px-2 py-0.5 text-[10px] text-slate-500">
                        {getVectorizationLabel(document.vectorizationState ?? null)}
                      </span>
                    </div>
                  </div>
                </button>

                {openDocumentMenuId === document.id ? (
                  <div
                    className="omni-knowledge-doc-menu no-drag absolute right-0 top-6 z-20 w-40 overflow-hidden"
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="omni-knowledge-doc-menu__danger no-drag"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => {
                        onCloseDocumentMenu();
                        onDeleteDocument(document.id);
                      }}
                    >
                      <Trash2 size={14} strokeWidth={1.9} />
                      删除
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}

          {documents.length === 0 ? (
            <div className="col-span-full rounded-none border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-sm text-slate-500">
              没有符合当前筛选条件的文档。你可以先上传文件，或者切换分类。
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
