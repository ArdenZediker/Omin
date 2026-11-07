import { lazy, Suspense, useEffect, useId, useRef, useState } from "react";
import { BookOpen, ChevronUp } from "lucide-react";
import type { KnowledgeContextSource, KnowledgeDocumentDetail } from "../../chat/knowledgeTypes";
import { openPath } from "../../app/storageApi";
import { loadKnowledgeDocumentBinary, loadKnowledgeDocumentDetail } from "./knowledgeApi";
import "./knowledgeCitation.css";

const KnowledgeDocumentPreview = lazy(() => import("./KnowledgeDocumentPreview"));

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "未知错误";
}

function CitationArchive({ source }: { source: KnowledgeContextSource }) {
  const [detail, setDetail] = useState<KnowledgeDocumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const locationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    setOpenError(null);
    if (!source.documentId?.trim()) {
      setError("这条历史引用缺少文档标识，无法打开存档。历史摘录已保留。");
      return;
    }
    void loadKnowledgeDocumentDetail(source.documentId).then((loaded) => {
      if (cancelled) return;
      if (!loaded?.document || loaded.document.id !== source.documentId) {
        setError("引用的存档不存在或返回的文档不匹配。历史摘录已保留。");
        return;
      }
      setDetail(loaded);
    }).catch((reason: unknown) => {
      if (!cancelled) {
        setError(`无法读取存档，文档可能已删除或暂时不可用。历史摘录已保留。${errorMessage(reason)}`);
      }
    });
    return () => { cancelled = true; };
  }, [source.documentId, attempt]);

  const chunk = detail?.chunks.find((item) => item.id === source.chunkId && item.documentId === source.documentId);
  useEffect(() => {
    if (chunk) {
      locationRef.current?.focus({ preventScroll: true });
      locationRef.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
    }
  }, [chunk]);

  async function openArchiveFile() {
    setOpenError(null);
    try {
      // Only open the stored original; the historical source path may now point to a different file.
      const path = detail?.document.storedFilePath;
      if (!path) throw new Error("此文档没有存档原文件，可查看下方已保存的正文与片段。");
      await openPath(path);
    } catch (reason) {
      setOpenError(`打开存档原文件失败：${errorMessage(reason)}`);
    }
  }

  if (error) {
    return (
      <div className="knowledge-citation__feedback">
        <p role="alert">{error}</p>
        {source.documentId?.trim() && (
          <button type="button" className="knowledge-citation__button" onClick={() => setAttempt((value) => value + 1)}>
            重试读取存档
          </button>
        )}
      </div>
    );
  }
  if (!detail) return <p role="status">正在读取存档…</p>;

  return (
    <>
      <div className="knowledge-citation__location" ref={locationRef} tabIndex={-1} aria-label="引用片段定位">
        {chunk ? (
          <>
            <div className="knowledge-citation__label">已定位到存档片段 {chunk.chunkIndex + 1}{chunk.title ? ` · ${chunk.title}` : ""}</div>
            <p className="knowledge-citation__hint">以下为当前存档中的片段；上方保留回答生成时的历史摘录。</p>
            <pre className="knowledge-citation__chunk">{chunk.content}</pre>
          </>
        ) : (
          <p role="status">{source.chunkId
            ? "文档可能已更新或重新分块，原引用片段已不存在，无法精确定位。历史摘录已保留，下方可查看当前存档。"
            : "这条历史引用缺少片段标识，无法精确定位。历史摘录已保留，下方可查看当前存档。"}</p>
        )}
      </div>
      <div className="knowledge-citation__label">存档预览 · {detail.document.sourceName}</div>
      {openError && <p role="alert" className="knowledge-citation__feedback">{openError}</p>}
      <div className="knowledge-citation__preview">
        <Suspense fallback={<p role="status">正在加载预览…</p>}>
          <KnowledgeDocumentPreview
            document={detail.document}
            loadDocumentBinary={loadKnowledgeDocumentBinary}
            onOpenExternal={openArchiveFile}
          />
        </Suspense>
      </div>
    </>
  );
}

function CitationCard({ source }: { source: KnowledgeContextSource }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="message-knowledge-source knowledge-citation">
      <div className="message-knowledge-source__top">
        <div className="message-knowledge-source__title-block">
          <div className="message-knowledge-source__title">{source.chunkTitle || source.sourceName}</div>
          <div className="message-knowledge-source__collection">{source.collectionName}</div>
        </div>
        <div className="message-knowledge-source__score">score {source.score.toFixed(2)}</div>
      </div>
      <div className="message-knowledge-source__meta">
        {source.sourcePath ? <span>{source.sourcePath}</span> : null}
        {source.favorite ? <span>收藏</span> : null}
        {source.accessCount > 0 ? <span>访问 {source.accessCount}</span> : null}
      </div>
      <div className="message-knowledge-source__excerpt" aria-label="历史摘录">{source.excerpt}</div>
      <button
        type="button"
        ref={triggerRef}
        className="knowledge-citation__button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <BookOpen size={14} aria-hidden="true" />}
        {expanded ? "收起存档" : "打开存档并定位片段"}
      </button>
      {expanded && (
        <section id={panelId} className="knowledge-citation__archive" aria-label={`${source.sourceName} 的存档`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setExpanded(false);
              triggerRef.current?.focus();
            }
          }}>
          <CitationArchive source={source} />
        </section>
      )}
    </div>
  );
}

export default function KnowledgeSourceCard({ source }: { source: KnowledgeContextSource }) {
  return <CitationCard key={`${source.documentId}:${source.chunkId}`} source={source} />;
}
