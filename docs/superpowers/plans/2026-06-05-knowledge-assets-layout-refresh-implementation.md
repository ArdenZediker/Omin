# Knowledge Assets Layout Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh Omni's document-detail `图片资产` page into the approved `A` workbench layout without changing any backend or asset-loading behavior.

**Architecture:** Keep the existing data flow in `KnowledgeBaseView.tsx` intact, but reorganize the `Assets` branch into a left navigation rail and a right reading workspace. Move the visual heavy lifting into the existing `omni-knowledge-assets-*` CSS namespace in `App.css`, and verify the result with a production build plus a local browser pass.

**Tech Stack:** React 19, TypeScript, Vite, Tailwind utility classes, shared `App.css`

---

## File Structure

### Existing files to modify

- `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`
  - Rework the `Assets` detail branch, keep existing state and selection logic, and localize the remaining English placeholder copy.
- `D:\AI-Coding\omni\src\App.css`
  - Replace the current utilitarian asset layout styling with the approved workbench treatment and responsive collapse rules.

### Existing files to verify but not modify

- `D:\AI-Coding\omni\docs\superpowers\specs\2026-06-05-knowledge-assets-layout-refresh-design.md`
  - Source-of-truth design doc for the approved `A` direction.

### Verification commands used in this plan

- TypeScript + Vite build: `npm run build`
- Optional local browser verification target: `http://127.0.0.1:5173`

## Task 1: Refresh the Assets JSX Structure

**Files:**
- Modify: `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`

- [ ] **Step 1: Re-read the current asset selection state and keep it unchanged**

Keep these existing lines and reuse them as-is:

```tsx
const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

const selectedAsset = useMemo(
  () => selectedDocumentDetail?.assets.find((asset) => asset.id === selectedAssetId) ?? null,
  [selectedAssetId, selectedDocumentDetail?.assets]
);

useEffect(() => {
  const firstAssetId = selectedDocumentDetail?.assets[0]?.id ?? null;
  setSelectedAssetId(firstAssetId);
}, [selectedDocumentDetail?.document.id, selectedDocumentDetail?.assets]);
```

- [ ] **Step 2: Replace the `Assets` section header with product-ready Chinese copy**

Replace the current header block:

```tsx
<div className="mb-3 flex items-center justify-between gap-3">
  <div className="min-w-0">
    <div className="text-sm font-semibold text-slate-950">Assets</div>
    <div className="mt-1 text-xs text-slate-500">
      {selectedDocumentDetail.assets.length > 0
        ? `${selectedDocumentDetail.assets.length} extracted image assets`
        : "No embedded images were extracted from this document."}
    </div>
  </div>
</div>
```

With:

```tsx
<div className="omni-knowledge-assets-view__header">
  <div className="min-w-0">
    <div className="omni-knowledge-assets-view__title">图片资产</div>
    <div className="omni-knowledge-assets-view__subtitle">
      {selectedDocumentDetail.assets.length > 0
        ? `已提取 ${selectedDocumentDetail.assets.length} 张图片，可在左侧切换查看。`
        : "当前文档还没有提取到可浏览的图片资产。"}
    </div>
  </div>
  {selectedDocumentDetail.assets.length > 0 ? (
    <div className="omni-knowledge-assets-view__count">共 {selectedDocumentDetail.assets.length} 张</div>
  ) : null}
</div>
```

- [ ] **Step 3: Replace the empty state and selected-state copy with Chinese UI text**

Replace these strings:

```tsx
"No embedded image assets yet."
"Preview unavailable"
"No OCR text"
"No caption summary"
"Select an asset to inspect it."
```

With:

```tsx
"当前文档还没有图片资产。"
"暂无可预览图片"
"暂无 OCR 文本"
"暂无图片描述"
"请先从左侧选择一张图片。"
```

- [ ] **Step 4: Restructure the asset list into a navigation rail**

Replace the current asset card body:

```tsx
<button
  key={asset.id}
  type="button"
  onClick={() => setSelectedAssetId(asset.id)}
  className={`omni-knowledge-asset-card ${asset.id === selectedAssetId ? "omni-knowledge-asset-card--active" : ""}`}
>
  <div className="omni-knowledge-asset-card__thumb">
    {asset.thumbnailDataUrl ? (
      <img src={asset.thumbnailDataUrl} alt={asset.sourceName} className="h-full w-full object-cover" />
    ) : (
      <div className="flex h-full w-full items-center justify-center bg-slate-100 text-xs font-medium text-slate-500">
        IMG
      </div>
    )}
  </div>
  <div className="mt-3 text-sm font-medium text-slate-900">{asset.sourceName}</div>
  <div className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{asset.contentPreview}</div>
</button>
```

With:

```tsx
<button
  key={asset.id}
  type="button"
  onClick={() => setSelectedAssetId(asset.id)}
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
```

- [ ] **Step 5: Restructure the right panel into preview, metadata strip, and reading cards**

Replace the current selected asset body:

```tsx
<div className="flex min-h-0 flex-1 flex-col">
  <div className="omni-knowledge-assets-detail__preview">
    {selectedAsset.thumbnailDataUrl ? (
      <img src={selectedAsset.thumbnailDataUrl} alt={selectedAsset.sourceName} className="max-h-[22rem] w-full object-contain" />
    ) : (
      <div className="flex h-56 items-center justify-center rounded-none border border-dashed border-slate-200 bg-slate-50 text-sm text-slate-500">
        Preview unavailable
      </div>
    )}
  </div>
  <div className="mt-4 flex items-center justify-between gap-3">
    <div>
      <div className="text-sm font-semibold text-slate-950">{selectedAsset.sourceName}</div>
      <div className="mt-1 text-xs text-slate-500">
        Asset #{selectedAsset.assetIndex + 1}
        {typeof selectedAsset.pageIndex === "number" ? ` · Page ${selectedAsset.pageIndex + 1}` : ""}
      </div>
    </div>
  </div>
  <div className="mt-4 grid gap-3 lg:grid-cols-2">
    <div className="rounded-none border border-slate-200 bg-slate-50 p-4">
      <div className="text-xs font-medium uppercase tracking-[0.12em] text-slate-400">OCR</div>
      <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">
        {selectedAsset.ocrText?.trim() ? selectedAsset.ocrText : "No OCR text"}
      </div>
    </div>
    <div className="rounded-none border border-slate-200 bg-slate-50 p-4">
      <div className="text-xs font-medium uppercase tracking-[0.12em] text-slate-400">Caption</div>
      <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">
        {selectedAsset.captionText?.trim() ? selectedAsset.captionText : "No caption summary"}
      </div>
    </div>
  </div>
</div>
```

With:

```tsx
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
```

- [ ] **Step 6: Preserve the no-selection fallback but localize it**

Keep the existing conditional branch, but replace it with:

```tsx
<div className="omni-knowledge-assets-detail__empty">
  <LucideFileImage size={22} strokeWidth={1.8} />
  <span>请先从左侧选择一张图片。</span>
</div>
```

## Task 2: Refresh the Assets CSS and Responsive Behavior

**Files:**
- Modify: `D:\AI-Coding\omni\src\App.css`

- [ ] **Step 1: Replace the current asset layout CSS block**

Replace the current block starting at `.omni-knowledge-assets-layout` with:

```css
.omni-knowledge-assets-view {
  gap: 18px;
  border-radius: 24px;
  border: 1px solid rgb(226 232 240);
  background:
    radial-gradient(circle at top right, rgba(59, 130, 246, 0.08), transparent 24%),
    linear-gradient(180deg, rgba(248, 251, 255, 0.96), rgba(241, 245, 249, 0.96));
  padding: 18px;
}

.omni-knowledge-assets-view__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.omni-knowledge-assets-view__title {
  font-size: 15px;
  font-weight: 700;
  color: rgb(15 23 42);
}

.omni-knowledge-assets-view__subtitle {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: rgb(100 116 139);
}

.omni-knowledge-assets-view__count {
  flex-shrink: 0;
  border-radius: 999px;
  border: 1px solid rgb(203 213 225);
  background: rgba(255, 255, 255, 0.85);
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 600;
  color: rgb(71 85 105);
}

.omni-knowledge-assets-layout {
  min-height: 0;
  flex: 1 1 auto;
  display: grid;
  grid-template-columns: minmax(17.5rem, 19.5rem) minmax(0, 1fr);
  gap: 18px;
}

.omni-knowledge-assets-list {
  min-height: 0;
  overflow-y: auto;
  display: grid;
  align-content: start;
  gap: 12px;
  padding-right: 4px;
}

.omni-knowledge-asset-card {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
  border-radius: 20px;
  border: 1px solid rgb(219 228 239);
  background: rgba(255, 255, 255, 0.92);
  padding: 10px;
  text-align: left;
  transition:
    border-color 140ms ease,
    box-shadow 140ms ease,
    background 140ms ease,
    transform 140ms ease;
}

.omni-knowledge-asset-card:hover {
  background: rgb(255 255 255);
  border-color: rgb(191 219 254);
  transform: translateY(-1px);
}

.omni-knowledge-asset-card--active {
  border-color: rgba(37, 99, 235, 0.42);
  box-shadow:
    inset 0 0 0 1px rgba(37, 99, 235, 0.24),
    0 10px 24px rgba(37, 99, 235, 0.08);
  background: linear-gradient(180deg, rgba(239, 246, 255, 0.98), rgba(255, 255, 255, 0.98));
}

.omni-knowledge-asset-card__thumb {
  height: 76px;
  overflow: hidden;
  border-radius: 14px;
  background: rgb(241 245 249);
}

.omni-knowledge-asset-card__thumb-empty {
  display: flex;
  height: 100%;
  width: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: rgb(100 116 139);
  font-size: 11px;
}

.omni-knowledge-asset-card__body {
  min-width: 0;
}

.omni-knowledge-asset-card__name {
  font-size: 13px;
  font-weight: 600;
  color: rgb(15 23 42);
}

.omni-knowledge-asset-card__meta {
  margin-top: 4px;
  font-size: 11px;
  color: rgb(100 116 139);
}

.omni-knowledge-asset-card__preview {
  margin-top: 8px;
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  font-size: 12px;
  line-height: 1.55;
  color: rgb(71 85 105);
}

.omni-knowledge-assets-detail {
  min-height: 0;
  overflow-y: auto;
  border-radius: 24px;
  border: 1px solid rgb(219 228 239);
  background: rgba(255, 255, 255, 0.95);
  padding: 16px;
}

.omni-knowledge-assets-workspace {
  display: grid;
  gap: 16px;
}

.omni-knowledge-assets-workspace__title {
  font-size: 15px;
  font-weight: 700;
  color: rgb(15 23 42);
}

.omni-knowledge-assets-workspace__subtitle {
  margin-top: 6px;
  font-size: 12px;
  color: rgb(100 116 139);
}

.omni-knowledge-assets-detail__preview {
  min-height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 24px;
  border: 1px solid rgb(226 232 240);
  background:
    radial-gradient(circle at top right, rgba(96, 165, 250, 0.12), transparent 24%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(241, 245, 249, 0.94));
  padding: 20px;
}

.omni-knowledge-assets-detail__preview-empty,
.omni-knowledge-assets-detail__empty {
  display: flex;
  min-height: 160px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: rgb(100 116 139);
  font-size: 13px;
  text-align: center;
}

.omni-knowledge-assets-meta-grid {
  display: grid;
  grid-template-columns: 1.2fr 0.8fr 0.8fr;
  gap: 12px;
}

.omni-knowledge-assets-meta-card,
.omni-knowledge-assets-reading-card {
  border-radius: 18px;
  border: 1px solid rgb(226 232 240);
  background: rgb(248 250 252);
  padding: 14px 16px;
}

.omni-knowledge-assets-meta-card__label {
  font-size: 11px;
  color: rgb(100 116 139);
}

.omni-knowledge-assets-meta-card__value {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 600;
  color: rgb(15 23 42);
}

.omni-knowledge-assets-reading-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.omni-knowledge-assets-reading-card__label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: rgb(37 99 235);
}

.omni-knowledge-assets-reading-card__content {
  margin-top: 10px;
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.75;
  color: rgb(51 65 85);
}
```

- [ ] **Step 2: Replace the current responsive media block**

Replace:

```css
@media (max-width: 960px) {
  .omni-knowledge-assets-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .omni-knowledge-assets-list {
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  }
}
```

With:

```css
@media (max-width: 1100px) {
  .omni-knowledge-assets-layout,
  .omni-knowledge-assets-reading-grid,
  .omni-knowledge-assets-meta-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .omni-knowledge-assets-list {
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  }
}

@media (max-width: 780px) {
  .omni-knowledge-assets-view {
    padding: 14px;
  }

  .omni-knowledge-assets-view__header {
    flex-direction: column;
  }

  .omni-knowledge-assets-list {
    padding-right: 0;
  }

  .omni-knowledge-asset-card {
    grid-template-columns: 80px minmax(0, 1fr);
  }

  .omni-knowledge-assets-detail__preview {
    min-height: 260px;
    padding: 16px;
  }
}
```

## Task 3: Verify the Refresh in Build Output and Browser

**Files:**
- Modify: `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`
- Modify: `D:\AI-Coding\omni\src\App.css`

- [ ] **Step 1: Run the production build after the JSX and CSS changes**

Run:

```bash
npm run build
```

Expected:

- TypeScript succeeds
- Vite build succeeds
- no new compile-time errors are introduced by the layout refresh

- [ ] **Step 2: Run the local Vite server for visual verification**

Run:

```bash
npm run dev -- --host 127.0.0.1 --port 5173
```

Expected:

- Vite dev server starts on `http://127.0.0.1:5173`
- the in-app browser can open the page for a manual check

- [ ] **Step 3: Visually verify the approved workbench outcomes**

Confirm in the browser:

```text
1. Left asset list feels like a navigation rail, not a competing content pane.
2. The selected preview is the strongest visual element.
3. OCR and 图片描述 cards are easier to read than before.
4. Chinese empty states appear in the refreshed Assets page.
5. Medium-width collapse keeps the page usable and intentional.
```

- [ ] **Step 4: Commit the layout refresh**

```bash
git add src/components/KnowledgeBaseView.tsx src/App.css docs/superpowers/plans/2026-06-05-knowledge-assets-layout-refresh-implementation.md
git commit -m "feat: refresh knowledge assets detail layout"
```

## Self-Review Notes

### Spec coverage

- workbench layout direction: Task 1 + Task 2
- lightweight left navigation rail: Task 1 Step 4 + Task 2 Step 1
- right preview workspace: Task 1 Step 5 + Task 2 Step 1
- Chinese copy cleanup: Task 1 Steps 2, 3, 6
- responsive collapse: Task 2 Step 2
- verification in build + browser: Task 3

### Placeholder scan

- no `TODO`
- no `TBD`
- no hand-wavy “write tests later”
- every code-changing step includes concrete replacement code

### Type consistency

- reuses existing `selectedAssetId`, `selectedAsset`, and `selectedDocumentDetail.assets`
- keeps the `omni-knowledge-assets-*` naming family
- does not introduce new frontend state or backend dependencies
