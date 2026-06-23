import type { ReactNode } from "react";
import { ArrowLeft, FileImage, FileText, Layers3, Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { KnowledgeDocument, KnowledgeDocumentDetail } from "../../chat/knowledgeTypes";
import {
  getDocumentTypeLabel,
  getProcessingStatusLabel,
  getVectorizationLabel,
} from "./knowledgeViewHelpers";

export type KnowledgeDocumentDetailView = "preview" | "assets" | "chunks" | "processing";

type KnowledgeDocumentDetailHeaderProps = {
  document: KnowledgeDocumentDetail["document"] | KnowledgeDocument | null;
  fallbackDocumentName?: string | null;
  collectionName: string;
  activeView: KnowledgeDocumentDetailView;
  windowControls?: ReactNode;
  onBackToList: () => void;
  onChangeView: (view: KnowledgeDocumentDetailView) => void;
  onCancelActiveJob: () => void;
  onRetryActiveJob: () => void;
  onReparse: () => void;
  onRevectorize: () => void;
};

type DetailViewOption = {
  id: Exclude<KnowledgeDocumentDetailView, "processing">;
  label: string;
  icon: LucideIcon;
};

const DETAIL_VIEW_OPTIONS: DetailViewOption[] = [
  { id: "preview", label: "原文", icon: FileText },
  { id: "assets", label: "图片资产", icon: FileImage },
  { id: "chunks", label: "知识结果", icon: Layers3 },
];

export default function KnowledgeDocumentDetailHeader({
  document,
  fallbackDocumentName,
  collectionName,
  activeView,
  windowControls,
  onBackToList,
  onChangeView,
  onCancelActiveJob,
  onRetryActiveJob,
  onReparse,
  onRevectorize,
}: KnowledgeDocumentDetailHeaderProps) {
  const vectorizationLabel = getVectorizationLabel(document?.vectorizationState ?? null);

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 md:px-6">
      <div className="drag-region flex min-w-0 flex-1 items-center gap-3">
        <button
          type="button"
          onClick={onBackToList}
          className="no-drag inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-none border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
          title="返回列表"
        >
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-slate-950">
            {document?.sourceName ?? fallbackDocumentName ?? "文档详情"}
          </div>
          <div className="mt-1 truncate text-xs text-slate-500">
            {collectionName}
            {document ? ` · ${getDocumentTypeLabel(document)} · ${document.chunkCount} 个分片` : ""}
          </div>
          {document ? (
            <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600">
              <span>{getProcessingStatusLabel(document.processingStatus)}</span>
              <span>·</span>
              <span>{vectorizationLabel}</span>
              {document.vectorizedChunkCount !== undefined ? (
                <span>· {document.vectorizedChunkCount}/{document.chunkCount}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="drag-region flex flex-wrap items-center justify-end gap-2">
        <div className="no-drag inline-flex items-center gap-1 rounded-[20px] border border-slate-200/90 bg-white/90 p-1 shadow-sm shadow-slate-200/60 backdrop-blur">
          {DETAIL_VIEW_OPTIONS.map((option) => {
            const Icon = option.icon;
            const isActive = activeView === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onChangeView(option.id)}
                className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-2xl px-3 text-xs font-medium transition ${
                  isActive
                    ? "bg-slate-950 text-white shadow-sm shadow-slate-300/60"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
                title={option.label}
                aria-pressed={isActive}
              >
                <Icon size={14} strokeWidth={2} />
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => onChangeView("processing")}
          className={`no-drag inline-flex h-10 items-center justify-center gap-1.5 rounded-[20px] border px-3 text-xs font-medium shadow-sm shadow-slate-200/40 transition ${
            activeView === "processing"
              ? "border-slate-950 bg-slate-950 text-white"
              : "border-slate-200/90 bg-white/90 text-slate-600 hover:bg-slate-50 hover:text-slate-900"
          }`}
          title="处理信息"
          aria-pressed={activeView === "processing"}
        >
          <Settings size={14} strokeWidth={2} />
          <span>处理信息</span>
        </button>

        {document ? (
          <div className="no-drag inline-flex items-center gap-1 rounded-[20px] border border-slate-200/90 bg-white/90 p-1 shadow-sm shadow-slate-200/50 backdrop-blur">
            {document.activeJobId ? (
              <>
                <button
                  type="button"
                  onClick={onCancelActiveJob}
                  className="inline-flex h-8 items-center justify-center rounded-2xl px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={onRetryActiveJob}
                  className="inline-flex h-8 items-center justify-center rounded-2xl px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                >
                  重试
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={onReparse}
              className="inline-flex h-8 items-center justify-center rounded-2xl px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              重解析
            </button>
            <button
              type="button"
              onClick={onRevectorize}
              className="inline-flex h-8 items-center justify-center rounded-2xl px-3 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
            >
              重向量化
            </button>
          </div>
        ) : null}

        <div className="no-drag">{windowControls}</div>
      </div>
    </div>
  );
}
