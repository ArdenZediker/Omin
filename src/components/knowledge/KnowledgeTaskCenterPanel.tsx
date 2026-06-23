import { ChevronDown, ChevronUp, History, RotateCcw, Settings, TriangleAlert } from "lucide-react";
import type {
  KnowledgePipelineSettings,
  KnowledgeProcessingDeadLetter,
  KnowledgeProcessingStatusSummary,
} from "../../chat/knowledgeTypes";

export type KnowledgeTaskCenterScope = "all" | "activeCollection";
export type KnowledgeDeadLetterStatusFilter = "failed" | "replayed" | "all";

type KnowledgeTaskCenterCounts = {
  global: KnowledgeProcessingStatusSummary;
  activeCollection: KnowledgeProcessingStatusSummary;
  globalDeadLetterCount: number;
  activeCollectionDeadLetterCount: number;
};

type KnowledgeTaskCenterPanelProps = {
  activeCollectionName: string;
  hasActiveCollection: boolean;
  counts: KnowledgeTaskCenterCounts;
  scope: KnowledgeTaskCenterScope;
  statusFilter: KnowledgeDeadLetterStatusFilter;
  items: KnowledgeProcessingDeadLetter[];
  total: number;
  page: number;
  pageSize: number;
  isLoading: boolean;
  isBusy: boolean;
  replayBusyId: string | null;
  expandedItemId: string | null;
  pipelineSettings: KnowledgePipelineSettings | null;
  isTaskSettingsOpen: boolean;
  isSavingPipelineSettings: boolean;
  notice: string | null;
  error: string | null;
  documentNameById: Map<string, string>;
  onScopeChange: (scope: KnowledgeTaskCenterScope) => void;
  onStatusFilterChange: (status: KnowledgeDeadLetterStatusFilter) => void;
  onToggleTaskSettings: () => void;
  onReprocessFailedItems: (scope: KnowledgeTaskCenterScope) => void;
  onUpdatePipelineSettings: (patch: Partial<KnowledgePipelineSettings>) => void;
  onReplayDeadLetterItem: (item: KnowledgeProcessingDeadLetter) => void;
  onToggleDeadLetterExpanded: (itemId: string) => void;
  onPreviousPage: () => void;
  onNextPage: () => void;
  formatTimestamp: (timestamp?: number | null) => string;
  onUnavailableActiveCollection: () => void;
};

function getDeadLetterDisplayName(item: KnowledgeProcessingDeadLetter, documentNameById: Map<string, string>) {
  return item.documentName?.trim() || documentNameById.get(item.documentId) || `文档 ${item.documentId.slice(0, 8)}`;
}

function getDeadLetterStatusClassName(status: string) {
  return status === "failed" ? "chat-topic-panel__task-status--failed" : "chat-topic-panel__task-status--completed";
}

function formatDeadLetterAttempts(item: KnowledgeProcessingDeadLetter) {
  return `第 ${Math.max(1, item.attempt)}/${Math.max(1, item.maxAttempts)} 次尝试`;
}

export default function KnowledgeTaskCenterPanel({
  activeCollectionName,
  hasActiveCollection,
  counts,
  scope,
  statusFilter,
  items,
  total,
  page,
  pageSize,
  isLoading,
  isBusy,
  replayBusyId,
  expandedItemId,
  pipelineSettings,
  isTaskSettingsOpen,
  isSavingPipelineSettings,
  notice,
  error,
  documentNameById,
  onScopeChange,
  onStatusFilterChange,
  onToggleTaskSettings,
  onReprocessFailedItems,
  onUpdatePipelineSettings,
  onReplayDeadLetterItem,
  onToggleDeadLetterExpanded,
  onPreviousPage,
  onNextPage,
  formatTimestamp,
  onUnavailableActiveCollection,
}: KnowledgeTaskCenterPanelProps) {
  const currentCounts = scope === "activeCollection" ? counts.activeCollection : counts.global;
  const currentDeadLetterCount =
    scope === "activeCollection" ? counts.activeCollectionDeadLetterCount : counts.globalDeadLetterCount;
  const hasFailedItems = currentCounts.failed + currentDeadLetterCount > 0;

  return (
    <aside className="chat-topic-panel no-drag !w-[360px] !min-w-[360px] !basis-[360px] omni-knowledge-task-panel">
      <div className="chat-topic-panel__body">
        <>
          <div className="chat-topic-panel__section chat-topic-panel__section--task">
            <div className="chat-topic-panel__section-title">
              <History size={13} strokeWidth={2} />
              <span>任务中心</span>
            </div>

            <div className="chat-topic-panel__task">
              <div className="chat-topic-panel__task-head">
                <strong>{scope === "activeCollection" ? `当前知识库 · ${activeCollectionName}` : "全局处理概览"}</strong>
                <span
                  className={`chat-topic-panel__task-status ${
                    currentCounts.failed > 0 ? "chat-topic-panel__task-status--failed" : "chat-topic-panel__task-status--completed"
                  }`}
                >
                  失败 {currentCounts.failed}
                </span>
              </div>
              <div className="chat-topic-panel__task-meta">
                <span>排队 {currentCounts.queued}</span>
                <span>运行 {currentCounts.running}</span>
                <span>死信 {currentDeadLetterCount}</span>
              </div>
              <div className="mt-3 rounded-none border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
                全局失败 {counts.global.failed} · 当前库失败 {counts.activeCollection.failed} · 当前展示 {scope === "activeCollection" ? "当前知识库" : "全局范围"}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-2">
              <select
                value={scope}
                onChange={(event) => {
                  const nextScope = event.target.value as KnowledgeTaskCenterScope;
                  if (nextScope === "activeCollection" && !hasActiveCollection) {
                    onUnavailableActiveCollection();
                    return;
                  }
                  onScopeChange(nextScope);
                }}
                className="chat-topic-panel__form-input"
              >
                <option value="activeCollection">当前知识库</option>
                <option value="all">全局范围</option>
              </select>
              <button type="button" className="chat-topic-panel__inline-action" onClick={onToggleTaskSettings}>
                {isTaskSettingsOpen ? <ChevronUp size={14} strokeWidth={2} /> : <ChevronDown size={14} strokeWidth={2} />}
                <span>{isTaskSettingsOpen ? "收起调度设置" : "调度设置"}</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={isBusy || !hasFailedItems}
                onClick={() => onReprocessFailedItems(scope)}
                className="chat-topic-panel__inline-action"
              >
                <RotateCcw size={14} strokeWidth={2} />
                <span>重新处理失败项</span>
              </button>
            </div>
          </div>

          {pipelineSettings && isTaskSettingsOpen ? (
            <div className="chat-topic-panel__section">
              <div className="chat-topic-panel__section-title">
                <Settings size={13} strokeWidth={2} />
                <span>调度设置</span>
                <span className="chat-topic-panel__item-meta">{isSavingPipelineSettings ? "保存中..." : "自动保存"}</span>
              </div>
              <div className="chat-topic-panel__task chat-topic-panel__task--form">
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <label className="flex items-center justify-between gap-2 rounded-none border border-slate-200 bg-white px-2 py-1.5">
                    <span>总并发</span>
                    <input
                      type="number"
                      min={1}
                      max={4}
                      value={pipelineSettings.maxConcurrentJobs}
                      onChange={(event) => onUpdatePipelineSettings({ maxConcurrentJobs: Number(event.target.value || 1) })}
                      className="w-14 rounded-none border border-slate-200 px-1 py-0.5 text-right text-[11px] outline-none"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2 rounded-none border border-slate-200 bg-white px-2 py-1.5">
                    <span>单库并发</span>
                    <input
                      type="number"
                      min={1}
                      max={4}
                      value={pipelineSettings.perCollectionMaxRunning}
                      onChange={(event) => onUpdatePipelineSettings({ perCollectionMaxRunning: Number(event.target.value || 1) })}
                      className="w-14 rounded-none border border-slate-200 px-1 py-0.5 text-right text-[11px] outline-none"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2 rounded-none border border-slate-200 bg-white px-2 py-1.5">
                    <span>自动重试</span>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={pipelineSettings.maxAutoRetries}
                      onChange={(event) => onUpdatePipelineSettings({ maxAutoRetries: Number(event.target.value || 0) })}
                      className="w-14 rounded-none border border-slate-200 px-1 py-0.5 text-right text-[11px] outline-none"
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2 rounded-none border border-slate-200 bg-white px-2 py-1.5">
                    <span>任务超时(s)</span>
                    <input
                      type="number"
                      min={10}
                      max={3600}
                      value={Math.floor(pipelineSettings.jobTimeoutMs / 1000)}
                      onChange={(event) =>
                        onUpdatePipelineSettings({
                          jobTimeoutMs: Number(event.target.value || 10) * 1000,
                        })
                      }
                      className="w-14 rounded-none border border-slate-200 px-1 py-0.5 text-right text-[11px] outline-none"
                    />
                  </label>
                </div>
              </div>
            </div>
          ) : null}

          <div className="chat-topic-panel__section">
            <div className="chat-topic-panel__section-title">
              <TriangleAlert size={13} strokeWidth={2} />
              <span>待处理失败</span>
              <span className="chat-topic-panel__item-meta">{total} 条</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={statusFilter}
                onChange={(event) => onStatusFilterChange(event.target.value as KnowledgeDeadLetterStatusFilter)}
                className="chat-topic-panel__form-input"
              >
                <option value="failed">仅失败</option>
                <option value="replayed">仅已回放</option>
                <option value="all">全部状态</option>
              </select>
              <div className="rounded-none border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
                优先处理失败文档，再看详情排查原因
              </div>
            </div>
            <div className="chat-topic-panel__group-list">
              {isLoading ? (
                <div className="chat-topic-panel__empty">加载失败任务中...</div>
              ) : items.length === 0 ? (
                <div className="chat-topic-panel__empty">当前筛选下没有需要处理的失败任务</div>
              ) : (
                items.map((item) => {
                  const documentName = getDeadLetterDisplayName(item, documentNameById);
                  const isExpanded = expandedItemId === item.id;
                  return (
                    <div key={item.id} className="chat-topic-panel__task">
                      <div className="chat-topic-panel__task-head">
                        <strong title={documentName}>{documentName}</strong>
                        <span className={`chat-topic-panel__task-status ${getDeadLetterStatusClassName(item.status)}`}>
                          {item.statusLabel}
                        </span>
                      </div>
                      <div className="chat-topic-panel__task-meta">
                        <span>{item.collectionName ?? activeCollectionName}</span>
                        <span>{item.jobTypeLabel}</span>
                        <span>{formatTimestamp(item.lastFailedAt)}</span>
                      </div>
                      <div className="mt-2 text-sm font-medium leading-6 text-slate-900">{item.userMessage}</div>
                      {item.userAction ? <div className="mt-1 text-xs leading-5 text-slate-500">{item.userAction}</div> : null}
                      <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                        <span>{formatDeadLetterAttempts(item)}</span>
                        <span>{item.documentName ? "已识别文档" : `文档 ID ${item.documentId.slice(0, 8)}`}</span>
                      </div>
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          type="button"
                          disabled={replayBusyId === item.id || item.status !== "failed"}
                          onClick={() => onReplayDeadLetterItem(item)}
                          className="chat-topic-panel__inline-action"
                        >
                          {replayBusyId === item.id ? "回放中" : "回放"}
                        </button>
                        <button
                          type="button"
                          onClick={() => onToggleDeadLetterExpanded(item.id)}
                          className="chat-topic-panel__inline-action"
                        >
                          {isExpanded ? "收起详情" : "查看详情"}
                        </button>
                      </div>
                      {isExpanded ? (
                        <div className="mt-3 space-y-2 rounded-none border border-slate-200 bg-slate-50 px-3 py-3 text-[11px] leading-5 text-slate-600">
                          <div><strong className="text-slate-900">原始错误：</strong>{item.errorMessage ?? "无原始错误详情"}</div>
                          <div><strong className="text-slate-900">文档 ID：</strong>{item.documentId}</div>
                          <div><strong className="text-slate-900">任务 ID：</strong>{item.jobId}</div>
                          <div><strong className="text-slate-900">知识库 ID：</strong>{item.collectionId}</div>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                disabled={page <= 1 || isLoading}
                onClick={onPreviousPage}
                className="chat-topic-panel__inline-action"
              >
                上一页
              </button>
              <span className="chat-topic-panel__item-meta">第 {page} 页</span>
              <button
                type="button"
                disabled={page * pageSize >= total || isLoading}
                onClick={onNextPage}
                className="chat-topic-panel__inline-action"
              >
                下一页
              </button>
            </div>
          </div>

          {notice ? (
            <div className="chat-topic-panel__task-status chat-topic-panel__task-status--completed">{notice}</div>
          ) : null}
          {error ? (
            <div className="chat-topic-panel__task-status chat-topic-panel__task-status--failed">{error}</div>
          ) : null}
        </>
      </div>
    </aside>
  );
}
