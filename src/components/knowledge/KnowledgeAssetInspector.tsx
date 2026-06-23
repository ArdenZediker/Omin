import { FileImage as LucideFileImage } from "lucide-react";
import type { KnowledgeDocumentAsset } from "../../chat/knowledgeTypes";

type KnowledgeAssetInspectorProps = {
  assets: KnowledgeDocumentAsset[];
  selectedAssetId: string | null;
  selectedAsset: KnowledgeDocumentAsset | null;
  onSelectAsset: (assetId: string) => void;
};

export default function KnowledgeAssetInspector({
  assets,
  selectedAssetId,
  selectedAsset,
  onSelectAsset,
}: KnowledgeAssetInspectorProps) {
  return (
    <section className="omni-knowledge-assets-view flex min-h-0 flex-1 flex-col">
      <div className="omni-knowledge-assets-view__header">
        <div>
          <div className="omni-knowledge-assets-view__title">图片资产</div>
          <div className="omni-knowledge-assets-view__subtitle">
            {assets.length > 0
              ? `已提取 ${assets.length} 张图片，可在左侧切换查看。`
              : "当前文档没有可浏览的嵌入图片。"}
          </div>
        </div>
        {assets.length > 0 ? (
          <div className="omni-knowledge-assets-view__count">共 {assets.length} 张</div>
        ) : null}
      </div>

      {assets.length === 0 ? (
        <div className="omni-knowledge-assets-detail__empty">
          <LucideFileImage size={24} strokeWidth={1.8} />
          <span>当前文档还没有图片资产。</span>
        </div>
      ) : (
        <div className="omni-knowledge-assets-layout min-h-0 flex-1">
          <div className="omni-knowledge-assets-list">
            {assets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                onClick={() => onSelectAsset(asset.id)}
                aria-pressed={asset.id === selectedAssetId}
                className={`omni-knowledge-asset-card ${asset.id === selectedAssetId ? "omni-knowledge-asset-card--active" : ""}`}
              >
                <div className="omni-knowledge-asset-card__thumb">
                  {asset.thumbnailDataUrl ? (
                    <img src={asset.thumbnailDataUrl} alt={asset.sourceName} className="h-full w-full object-cover" />
                  ) : (
                    <div className="omni-knowledge-asset-card__thumb-empty">
                      <LucideFileImage size={18} strokeWidth={1.8} />
                      <span>暂无缩略图</span>
                    </div>
                  )}
                </div>
                <div className="omni-knowledge-asset-card__body">
                  <div className="omni-knowledge-asset-card__name">{asset.sourceName}</div>
                  <div className="omni-knowledge-asset-card__meta">
                    资产 #{asset.assetIndex + 1}
                    {typeof asset.pageIndex === "number" ? ` · 第 ${asset.pageIndex + 1} 页` : ""}
                  </div>
                  <div className="omni-knowledge-asset-card__preview">
                    {asset.contentPreview?.trim() || asset.captionText?.trim() || asset.ocrText?.trim() || "暂无摘要"}
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div className="omni-knowledge-assets-detail">
            {selectedAsset ? (
              <div className="omni-knowledge-assets-workspace">
                <div className="omni-knowledge-assets-workspace__header">
                  <div>
                    <div className="omni-knowledge-assets-workspace__title">当前图片</div>
                    <div className="omni-knowledge-assets-workspace__subtitle">先看预览，再看 OCR 和描述内容。</div>
                  </div>
                </div>

                <div className="omni-knowledge-assets-detail__preview">
                  {selectedAsset.thumbnailDataUrl ? (
                    <img src={selectedAsset.thumbnailDataUrl} alt={selectedAsset.sourceName} className="max-h-[26rem] w-full object-contain" />
                  ) : (
                    <div className="omni-knowledge-assets-detail__preview-empty">
                      <LucideFileImage size={24} strokeWidth={1.8} />
                      <span>暂无可预览图片</span>
                    </div>
                  )}
                </div>

                <div className="omni-knowledge-assets-meta-grid">
                  <div className="omni-knowledge-assets-meta-card">
                    <div className="omni-knowledge-assets-meta-card__label">文件名</div>
                    <div className="omni-knowledge-assets-meta-card__value">{selectedAsset.sourceName}</div>
                  </div>
                  <div className="omni-knowledge-assets-meta-card">
                    <div className="omni-knowledge-assets-meta-card__label">资产序号</div>
                    <div className="omni-knowledge-assets-meta-card__value">#{selectedAsset.assetIndex + 1}</div>
                  </div>
                  <div className="omni-knowledge-assets-meta-card">
                    <div className="omni-knowledge-assets-meta-card__label">所在页</div>
                    <div className="omni-knowledge-assets-meta-card__value">
                      {typeof selectedAsset.pageIndex === "number" ? `第 ${selectedAsset.pageIndex + 1} 页` : "未记录"}
                    </div>
                  </div>
                </div>

                <div className="omni-knowledge-assets-reading-grid">
                  <section className="omni-knowledge-assets-reading-card">
                    <div className="omni-knowledge-assets-reading-card__label">OCR</div>
                    <div className="omni-knowledge-assets-reading-card__content">
                      {selectedAsset.ocrText?.trim() ? selectedAsset.ocrText : "暂无 OCR 文本"}
                    </div>
                  </section>
                  <section className="omni-knowledge-assets-reading-card">
                    <div className="omni-knowledge-assets-reading-card__label">图片描述</div>
                    <div className="omni-knowledge-assets-reading-card__content">
                      {selectedAsset.captionText?.trim() ? selectedAsset.captionText : "暂无图片描述"}
                    </div>
                  </section>
                </div>
              </div>
            ) : (
              <div className="omni-knowledge-assets-detail__empty">
                <LucideFileImage size={22} strokeWidth={1.8} />
                <span>请先从左侧选择一张图片。</span>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
