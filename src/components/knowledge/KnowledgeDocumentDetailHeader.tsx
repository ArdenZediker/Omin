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

/**
 * 文档详情页顶部栏。
 *
 * **布局契约（改这里之前先读 knowledge.css 的 .omni-knowledge-detail-* 注释）**：
 * 标题块、切页药丸、处理信息、文档操作、窗口控制是 header 的**直接子元素**，
 * 由 header 的 `flex-wrap` 统一排布。绝对不要把它们再套进一个"右侧工具组"容器里
 * —— 工具组的 hypothetical main size 等于它内部所有控件的 max-content（实测约
 * 736px），会整块换行，把标题挤到只剩几十像素，并让工具组内部自己折行后与标题
 * 视觉重叠。
 *
 * 另外副标题与状态徽标同占一行：状态徽标是 76px 高度预算下的"多出来的一行"，
 * 独立成行会把标题块撑到 76px 以上，header 就再也压不回与聊天顶栏齐平的 76px。
 */
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
    <div className="omni-knowledge-detail-header px-4 py-3 md:px-6">
      <div className="omni-knowledge-detail-header__identity">
        <button
          type="button"
          onClick={onBackToList}
          className="omni-knowledge-detail-back no-drag"
          title="返回列表"
        >
          <ArrowLeft size={16} strokeWidth={2} />
        </button>
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-[var(--omni-app-text)]">
            {document?.sourceName ?? fallbackDocumentName ?? "文档详情"}
          </div>
          <div className="omni-knowledge-detail-meta">
            <span className="omni-knowledge-detail-meta__text">
              {collectionName}
              {document ? ` · ${getDocumentTypeLabel(document)} · ${document.chunkCount} 个分片` : ""}
            </span>
            {document ? (
              <span className="omni-knowledge-detail-status">
                <span>{getProcessingStatusLabel(document.processingStatus)}</span>
                <span>·</span>
                <span>{vectorizationLabel}</span>
                {document.vectorizedChunkCount !== undefined ? (
                  <span>· {document.vectorizedChunkCount}/{document.chunkCount}</span>
                ) : null}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="omni-knowledge-detail-tabs no-drag">
        {DETAIL_VIEW_OPTIONS.map((option) => {
          const Icon = option.icon;
          const isActive = activeView === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onChangeView(option.id)}
              className={`omni-knowledge-detail-tab ${isActive ? "omni-knowledge-detail-tab--active" : ""}`}
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
        className={`omni-knowledge-detail-pill no-drag ${
          activeView === "processing" ? "omni-knowledge-detail-pill--active" : ""
        }`}
        title="处理信息"
        aria-pressed={activeView === "processing"}
      >
        <Settings size={14} strokeWidth={2} />
        <span>处理信息</span>
      </button>

      {document ? (
        <div className="omni-knowledge-detail-actions no-drag">
          {document.activeJobId ? (
            <>
              <button type="button" onClick={onCancelActiveJob} className="omni-knowledge-detail-actions__button">
                取消
              </button>
              <button type="button" onClick={onRetryActiveJob} className="omni-knowledge-detail-actions__button">
                重试
              </button>
            </>
          ) : null}
          <button type="button" onClick={onReparse} className="omni-knowledge-detail-actions__button">
            重解析
          </button>
          <button type="button" onClick={onRevectorize} className="omni-knowledge-detail-actions__button">
            重向量化
          </button>
        </div>
      ) : null}

      <div className="omni-knowledge-detail-header__controls no-drag omni-window-control-slot">{windowControls}</div>
    </div>
  );
}
