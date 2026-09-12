import type { KnowledgeCollection, KnowledgeDocumentDetail } from "../../chat/knowledgeTypes";
import { getProcessingStatusLabel } from "./knowledgeViewHelpers";

type KnowledgeDocumentProcessingPanelProps = {
  document: KnowledgeDocumentDetail["document"];
  collection: KnowledgeCollection | null;
};

// 卡片/文字颜色统一走 --omni-* token（此前是 slate-*/white 硬编码，暗色下整块亮岛）。
// 多模态徽标是琥珀色强语义色，用 .omni-knowledge-warn-chip 承载（暗色下换浅琥珀前景）。
export default function KnowledgeDocumentProcessingPanel({
  document,
  collection,
}: KnowledgeDocumentProcessingPanelProps) {
  const multimodalConfig = collection?.multimodalConfig ?? null;

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-none border border-[var(--omni-panel-border)] bg-[var(--omni-panel-bg)] p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--omni-app-text)]">处理状态</div>
          <div className="mt-1 text-xs text-[var(--omni-app-muted)]">查看当前文档的处理进度与错误摘要</div>
        </div>
        <span className="shrink-0 rounded-none border border-[var(--omni-panel-border)] bg-[var(--omni-panel-bg)] px-2 py-0.5 text-[11px] font-medium text-[var(--omni-app-muted)]">
          {getProcessingStatusLabel(document.processingStatus)}
        </span>
      </div>

      <div className="grid gap-3 text-sm text-[var(--omni-app-muted)] sm:grid-cols-2">
        <div className="rounded-none border border-[var(--omni-panel-border)] bg-[var(--omni-soft-bg)] px-4 py-3">
          <div className="text-xs text-[var(--omni-app-muted)]">当前状态</div>
          <div className="mt-1 font-medium text-[var(--omni-app-text)]">
            {getProcessingStatusLabel(document.processingStatus)}
          </div>
        </div>
        <div className="rounded-none border border-[var(--omni-panel-border)] bg-[var(--omni-soft-bg)] px-4 py-3">
          <div className="text-xs text-[var(--omni-app-muted)]">活动任务 ID</div>
          <div className="mt-1 truncate font-medium text-[var(--omni-app-text)]" title={document.activeJobId ?? "无"}>
            {document.activeJobId ?? "无"}
          </div>
        </div>
        <div className="rounded-none border border-[var(--omni-panel-border)] bg-[var(--omni-soft-bg)] px-4 py-3">
          <div className="text-xs text-[var(--omni-app-muted)]">分片数</div>
          <div className="mt-1 font-medium text-[var(--omni-app-text)]">{document.chunkCount}</div>
        </div>
        <div className="rounded-none border border-[var(--omni-panel-border)] bg-[var(--omni-soft-bg)] px-4 py-3">
          <div className="text-xs text-[var(--omni-app-muted)]">已向量化</div>
          <div className="mt-1 font-medium text-[var(--omni-app-text)]">
            {document.vectorizedChunkCount ?? 0}/{document.chunkCount}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-none border border-[var(--omni-panel-border)] bg-[var(--omni-panel-bg)] px-4 py-3 text-sm">
        <div className="text-xs text-[var(--omni-app-muted)]">错误信息</div>
        <div
          className={
            document.errorMessage
              ? "mt-1 text-[var(--omni-danger,#ef4444)]"
              : "mt-1 text-[var(--omni-app-muted)]"
          }
        >
          {document.errorMessage ?? "无"}
        </div>
      </div>

      <div className="mt-3 rounded-none border border-[var(--omni-panel-border)] bg-[var(--omni-panel-bg)] px-4 py-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs text-[var(--omni-app-muted)]">多模态策略</div>
            <div className="mt-1 font-medium text-[var(--omni-app-text)]">
              {multimodalConfig?.enabled ? "已启用知识库多模态分析" : "当前知识库未启用多模态分析"}
            </div>
          </div>
          {multimodalConfig?.enabled ? (
            <span className="omni-knowledge-warn-chip shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium">
              多模态
            </span>
          ) : null}
        </div>
        {multimodalConfig?.enabled ? (
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--omni-app-muted)]">
            <span className="rounded-full border border-[var(--omni-panel-border)] bg-[var(--omni-soft-bg)] px-2 py-1">
              图片分析 {multimodalConfig.image.enabled ? "开启" : "关闭"}
            </span>
            <span className="rounded-full border border-[var(--omni-panel-border)] bg-[var(--omni-soft-bg)] px-2 py-1">
              音频分析 {multimodalConfig.audio.enabled ? "开启" : "关闭"}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
