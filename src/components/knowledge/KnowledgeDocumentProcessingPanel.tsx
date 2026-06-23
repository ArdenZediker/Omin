import type { KnowledgeCollection, KnowledgeDocumentDetail } from "../../chat/knowledgeTypes";
import { getProcessingStatusLabel } from "./knowledgeViewHelpers";

type KnowledgeDocumentProcessingPanelProps = {
  document: KnowledgeDocumentDetail["document"];
  collection: KnowledgeCollection | null;
};

export default function KnowledgeDocumentProcessingPanel({
  document,
  collection,
}: KnowledgeDocumentProcessingPanelProps) {
  const multimodalConfig = collection?.multimodalConfig ?? null;

  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-none border border-slate-200 bg-white p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-950">处理状态</div>
          <div className="mt-1 text-xs text-slate-500">查看当前文档的处理进度与错误摘要</div>
        </div>
        <span className="rounded-none border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600">
          {getProcessingStatusLabel(document.processingStatus)}
        </span>
      </div>

      <div className="grid gap-3 text-sm text-slate-600 sm:grid-cols-2">
        <div className="rounded-none border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="text-xs text-slate-400">当前状态</div>
          <div className="mt-1 font-medium text-slate-900">{getProcessingStatusLabel(document.processingStatus)}</div>
        </div>
        <div className="rounded-none border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="text-xs text-slate-400">活动任务 ID</div>
          <div className="mt-1 truncate font-medium text-slate-900" title={document.activeJobId ?? "无"}>
            {document.activeJobId ?? "无"}
          </div>
        </div>
        <div className="rounded-none border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="text-xs text-slate-400">分片数</div>
          <div className="mt-1 font-medium text-slate-900">{document.chunkCount}</div>
        </div>
        <div className="rounded-none border border-slate-200 bg-slate-50 px-4 py-3">
          <div className="text-xs text-slate-400">已向量化</div>
          <div className="mt-1 font-medium text-slate-900">
            {document.vectorizedChunkCount ?? 0}/{document.chunkCount}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-none border border-slate-200 bg-white px-4 py-3 text-sm">
        <div className="text-xs text-slate-400">错误信息</div>
        <div className={document.errorMessage ? "mt-1 text-red-500" : "mt-1 text-slate-500"}>
          {document.errorMessage ?? "无"}
        </div>
      </div>

      <div className="mt-3 rounded-none border border-slate-200 bg-white px-4 py-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs text-slate-400">多模态策略</div>
            <div className="mt-1 font-medium text-slate-900">
              {multimodalConfig?.enabled ? "已启用知识库多模态分析" : "当前知识库未启用多模态分析"}
            </div>
          </div>
          {multimodalConfig?.enabled ? (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
              多模态
            </span>
          ) : null}
        </div>
        {multimodalConfig?.enabled ? (
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1">
              图片分析 {multimodalConfig.image.enabled ? "开启" : "关闭"}
            </span>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1">
              音频分析 {multimodalConfig.audio.enabled ? "开启" : "关闭"}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
