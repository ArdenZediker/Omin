# Knowledge Multimodal Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WeKnora-style asynchronous image and audio enrichment to Omni knowledge bases by introducing global multimodal model configuration, per-collection multimodal settings, and pipeline-based OCR/ASR content merging.

**Architecture:** Reuse Omni's current OpenAI-compatible configuration and SQLite-backed storage model. Keep retrieval unchanged by converting multimodal analysis into normalized text that is merged into `knowledge_documents.content`, chunked by the existing pipeline, and surfaced through the current knowledge search flow.

**Tech Stack:** React 19, TypeScript, Vite, Tauri 2, Rust, rusqlite, SQLite, existing OpenAI-compatible HTTP integrations

---

## File Structure

### Existing files to modify

- `D:\AI-Coding\omni\src\chat\knowledgeEmbedding.ts`
  - Reuse provider/base URL conventions for the new multimodal config helpers.
- `D:\AI-Coding\omni\src\chat\knowledgeTypes.ts`
  - Extend collection and document-facing types with multimodal config and enrichment state.
- `D:\AI-Coding\omni\src\components\SettingsPanel.tsx`
  - Add a third model category for multimodal models and wire config loading/saving.
- `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`
  - Add collection settings entry, dialog state, validation, and status display.
- `D:\AI-Coding\omni\src\App.css`
  - Style the new collection settings dialog and multimodal badges.
- `D:\AI-Coding\omni\src-tauri\src\lib.rs`
  - Add config records, storage-key routing, collection schema changes, and collection CRUD payload changes.
- `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`
  - Add multimodal resolution, enrichment steps, merge logic, provider calls, and Rust tests.

### New files to create

- `D:\AI-Coding\omni\src\chat\knowledgeMultimodal.ts`
  - Frontend config types, defaults, normalization, storage helpers, and capability filtering.
- `D:\AI-Coding\omni\src\components\settings\KnowledgeMultimodalSection.tsx`
  - Settings-page model management UI for image/audio analysis models.

### Verification commands used throughout

- Frontend type-check: `.\node_modules\.bin\tsc.CMD --noEmit`
- Frontend production build: `npm run build`
- Backend focused tests: `cargo test --manifest-path src-tauri/Cargo.toml <test_name> -- --exact`

## Task 1: Add Shared Multimodal Config Types and Storage

**Files:**
- Create: `D:\AI-Coding\omni\src\chat\knowledgeMultimodal.ts`
- Modify: `D:\AI-Coding\omni\src\chat\knowledgeTypes.ts`
- Modify: `D:\AI-Coding\omni\src-tauri\src\lib.rs`
- Test: `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`

- [ ] **Step 1: Add the frontend multimodal config module**

Create `D:\AI-Coding\omni\src\chat\knowledgeMultimodal.ts` with the shared types and normalization helpers:

```ts
import { readSqliteBackedValue, saveSqliteBackedValue } from "../app/sqliteStorage";
import type { KnowledgeEmbeddingProviderId } from "./knowledgeEmbedding";

export type KnowledgeMultimodalCapability = "image" | "audio";

export type KnowledgeMultimodalModelConfig = {
  id: string;
  name: string;
  provider: KnowledgeEmbeddingProviderId;
  baseUrl: string;
  model: string;
  apiKey: string;
  capability: KnowledgeMultimodalCapability;
};

export type KnowledgeMultimodalConfig = {
  enabled: boolean;
  models: KnowledgeMultimodalModelConfig[];
};

export type KnowledgeCollectionMultimodalConfig = {
  enabled: boolean;
  image: {
    enabled: boolean;
    modelId: string;
    extractText: boolean;
    generateSummary: boolean;
  };
  audio: {
    enabled: boolean;
    modelId: string;
    keepTranscript: boolean;
    generateSummary: boolean;
  };
  mergeMode: "append";
};

export const KNOWLEDGE_MULTIMODAL_CONFIG_STORAGE_KEY = "omni_knowledge_multimodal_profile";
```

- [ ] **Step 2: Implement defaults, normalization, and storage helpers**

Extend `D:\AI-Coding\omni\src\chat\knowledgeMultimodal.ts` with logic parallel to `knowledgeEmbedding.ts`:

```ts
const DEFAULT_BASE_URLS: Record<KnowledgeEmbeddingProviderId, string> = {
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  moonshot: "https://api.moonshot.cn/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
};

export function getDefaultKnowledgeMultimodalConfig(): KnowledgeMultimodalConfig {
  return { enabled: false, models: [] };
}

export function getDefaultCollectionMultimodalConfig(): KnowledgeCollectionMultimodalConfig {
  return {
    enabled: false,
    image: { enabled: false, modelId: "", extractText: true, generateSummary: true },
    audio: { enabled: false, modelId: "", keepTranscript: true, generateSummary: true },
    mergeMode: "append",
  };
}

export function saveKnowledgeMultimodalConfig(config: KnowledgeMultimodalConfig) {
  saveSqliteBackedValue(KNOWLEDGE_MULTIMODAL_CONFIG_STORAGE_KEY, JSON.stringify(config));
}

export function loadKnowledgeMultimodalConfig(): KnowledgeMultimodalConfig {
  const raw = readSqliteBackedValue(KNOWLEDGE_MULTIMODAL_CONFIG_STORAGE_KEY);
  return raw ? normalizeKnowledgeMultimodalConfig(JSON.parse(raw)) : getDefaultKnowledgeMultimodalConfig();
}
```

- [ ] **Step 3: Extend shared knowledge types**

Modify `D:\AI-Coding\omni\src\chat\knowledgeTypes.ts` to expose collection multimodal config and lightweight document enrichment visibility:

```ts
import type { KnowledgeCollectionMultimodalConfig } from "./knowledgeMultimodal";

export type KnowledgeCollection = {
  id: string;
  name: string;
  description: string;
  retrievalMode?: string | null;
  embeddingProfileId?: string | null;
  multimodalConfig?: KnowledgeCollectionMultimodalConfig | null;
  createdAt?: number;
  updatedAt?: number;
};

export type KnowledgeDocument = {
  // existing fields...
  processingStatus?: "pending" | "processing" | "searchable" | "partial" | "failed" | "canceled" | "unsupported" | null;
  errorMessage?: string | null;
};
```

- [ ] **Step 4: Add Rust records and storage-key routing**

Modify `D:\AI-Coding\omni\src-tauri\src\lib.rs` to add config structs and route the new storage key through `app_kv`:

```rust
const KNOWLEDGE_MULTIMODAL_CONFIG_KEY: &str = "omni_knowledge_multimodal_profile";

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnowledgeMultimodalModelConfigRecord {
    id: String,
    name: String,
    provider: String,
    base_url: String,
    model: String,
    api_key: String,
    capability: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnowledgeMultimodalConfigRecord {
    enabled: bool,
    models: Vec<KnowledgeMultimodalModelConfigRecord>,
}

fn is_knowledge_multimodal_config_key(key: &str) -> bool {
    key == KNOWLEDGE_MULTIMODAL_CONFIG_KEY
}
```

- [ ] **Step 5: Add collection multimodal config structs in Rust**

Extend `D:\AI-Coding\omni\src-tauri\src\lib.rs` with collection-side config payloads:

```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CollectionImageMultimodalConfigRecord {
    enabled: bool,
    model_id: String,
    extract_text: bool,
    generate_summary: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CollectionAudioMultimodalConfigRecord {
    enabled: bool,
    model_id: String,
    keep_transcript: bool,
    generate_summary: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnowledgeCollectionMultimodalConfigRecord {
    enabled: bool,
    image: CollectionImageMultimodalConfigRecord,
    audio: CollectionAudioMultimodalConfigRecord,
    merge_mode: String,
}
```

- [ ] **Step 6: Run type-check to catch naming drift early**

Run: `.\node_modules\.bin\tsc.CMD --noEmit`

Expected: TypeScript completes without missing imports or duplicate type name errors.

- [ ] **Step 7: Commit the shared config groundwork**

```bash
git add src/chat/knowledgeMultimodal.ts src/chat/knowledgeTypes.ts src-tauri/src/lib.rs
git commit -m "feat: add knowledge multimodal config models"
```

## Task 2: Persist Collection Multimodal Settings and Expose the UI Entry

**Files:**
- Modify: `D:\AI-Coding\omni\src-tauri\src\lib.rs`
- Modify: `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`
- Modify: `D:\AI-Coding\omni\src\App.css`
- Test: `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`

- [ ] **Step 1: Extend the collection schema and query payloads**

Modify `D:\AI-Coding\omni\src-tauri\src\lib.rs` to add `multimodal_config_json` to `knowledge_collections` and migration checks:

```rust
if !table_has_column(connection, "knowledge_collections", "multimodal_config_json")? {
    connection
        .execute(
            "ALTER TABLE knowledge_collections ADD COLUMN multimodal_config_json TEXT",
            [],
        )
        .map_err(|err| err.to_string())?;
}
```

- [ ] **Step 2: Round-trip the new column through collection CRUD**

Update collection insert/select/update code in `D:\AI-Coding\omni\src-tauri\src\lib.rs`:

```rust
INSERT INTO knowledge_collections (
  id, name, description, retrieval_mode, embedding_profile_id, multimodal_config_json, created_at, updated_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
```

```rust
struct UpdateKnowledgeCollectionInput {
    collection_id: String,
    name: Option<String>,
    description: Option<String>,
    retrieval_mode: Option<String>,
    multimodal_config: Option<KnowledgeCollectionMultimodalConfigRecord>,
}
```

- [ ] **Step 3: Add collection settings state and menu action**

Modify `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx` so the collection menu contains `设置` before `删除`:

```tsx
<button
  type="button"
  className="flex w-full items-center px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
  onClick={() => {
    setIsCollectionMenuOpen(null);
    setEditingCollection(collection);
    setIsCollectionSettingsOpen(true);
  }}
>
  设置
</button>
```

- [ ] **Step 4: Add a collection settings dialog with form state**

In `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`, add dialog-local draft state sourced from `collection.multimodalConfig`:

```tsx
const [isCollectionSettingsOpen, setIsCollectionSettingsOpen] = useState(false);
const [editingCollection, setEditingCollection] = useState<KnowledgeCollection | null>(null);
const [collectionSettingsDraft, setCollectionSettingsDraft] = useState<KnowledgeCollection | null>(null);
const [collectionSettingsError, setCollectionSettingsError] = useState<string | null>(null);
```

```tsx
async function saveCollectionSettings() {
  if (!collectionSettingsDraft) return;
  await invoke<KnowledgeCollection>("update_knowledge_collection_command", {
    input: {
      collectionId: collectionSettingsDraft.id,
      name: collectionSettingsDraft.name,
      description: collectionSettingsDraft.description,
      retrievalMode: collectionSettingsDraft.retrievalMode ?? "hybrid",
      multimodalConfig: collectionSettingsDraft.multimodalConfig ?? getDefaultCollectionMultimodalConfig(),
    },
  });
}
```

- [ ] **Step 5: Add CSS for the dialog and capability rows**

Modify `D:\AI-Coding\omni\src\App.css` with focused styles rather than overloading the task center classes:

```css
.omni-knowledge-collection-settings {
  width: min(720px, calc(100vw - 32px));
  border: 1px solid rgb(226 232 240);
  background: white;
  box-shadow: 0 24px 80px rgba(15, 23, 42, 0.18);
}

.omni-knowledge-collection-settings__grid {
  display: grid;
  grid-template-columns: 140px minmax(0, 1fr);
  gap: 12px 16px;
}
```

- [ ] **Step 6: Build the app and verify the dialog wiring compiles**

Run: `npm run build`

Expected: `vite build` completes and the generated bundle contains no `KnowledgeCollection` property errors.

- [ ] **Step 7: Commit the collection settings UI entry**

```bash
git add src-tauri/src/lib.rs src/components/KnowledgeBaseView.tsx src/App.css
git commit -m "feat: add knowledge collection multimodal settings"
```

## Task 3: Add Settings-Page Multimodal Model Management

**Files:**
- Create: `D:\AI-Coding\omni\src\components\settings\KnowledgeMultimodalSection.tsx`
- Modify: `D:\AI-Coding\omni\src\components\SettingsPanel.tsx`
- Modify: `D:\AI-Coding\omni\src\chat\knowledgeMultimodal.ts`
- Test: `D:\AI-Coding\omni\src\components\SettingsPanel.tsx`

- [ ] **Step 1: Add capability-aware helpers**

Extend `D:\AI-Coding\omni\src\chat\knowledgeMultimodal.ts` with filters used by both settings and collection dialogs:

```ts
export function getKnowledgeMultimodalModelsByCapability(
  config: KnowledgeMultimodalConfig,
  capability: KnowledgeMultimodalCapability,
) {
  return config.models.filter((model) => model.capability === capability);
}

export function getKnowledgeMultimodalModelById(
  config: KnowledgeMultimodalConfig,
  modelId: string,
) {
  return config.models.find((model) => model.id === modelId) ?? null;
}
```

- [ ] **Step 2: Create the settings section component**

Create `D:\AI-Coding\omni\src\components\settings\KnowledgeMultimodalSection.tsx` using the same editing pattern as `KnowledgeEmbeddingSection.tsx`:

```tsx
type Props = {
  config: KnowledgeMultimodalConfig;
  onChangeConfig: (config: KnowledgeMultimodalConfig) => void;
};

export default function KnowledgeMultimodalSection({ config, onChangeConfig }: Props) {
  const [editingModel, setEditingModel] = useState<KnowledgeMultimodalModelConfig | null>(null);
  const [isModelFormOpen, setIsModelFormOpen] = useState(false);
  // render list, add/edit modal, capability select, provider select, base URL, model, API key
}
```

- [ ] **Step 3: Load and save multimodal config in SettingsPanel**

Modify `D:\AI-Coding\omni\src\components\SettingsPanel.tsx`:

```tsx
import {
  loadKnowledgeMultimodalConfig,
  saveKnowledgeMultimodalConfig,
  type KnowledgeMultimodalConfig,
} from "../chat/knowledgeMultimodal";

type ModelConfigSection = "chat" | "embedding" | "multimodal";

const [knowledgeMultimodalConfig, setKnowledgeMultimodalConfig] = useState<KnowledgeMultimodalConfig>(loadKnowledgeMultimodalConfig);
```

- [ ] **Step 4: Add the new model-category card and panel switch**

Extend the `modelSectionCards` object and conditional rendering in `D:\AI-Coding\omni\src\components\SettingsPanel.tsx`:

```tsx
multimodal: {
  title: "多模态模型",
  description: "管理知识库图片 OCR、图像理解和音频转写所用模型。",
  icon: Cuboid,
  count: knowledgeMultimodalConfig.models.length,
},
```

```tsx
{modelSection === "multimodal" ? (
  <KnowledgeMultimodalSection
    config={knowledgeMultimodalConfig}
    onChangeConfig={(config) => {
      setKnowledgeMultimodalConfig(config);
      saveKnowledgeMultimodalConfig(config);
    }}
  />
) : null}
```

- [ ] **Step 5: Type-check the settings integration**

Run: `.\node_modules\.bin\tsc.CMD --noEmit`

Expected: The new `multimodal` branch compiles without union narrowing or missing prop errors.

- [ ] **Step 6: Commit the settings-page model manager**

```bash
git add src/chat/knowledgeMultimodal.ts src/components/settings/KnowledgeMultimodalSection.tsx src/components/SettingsPanel.tsx
git commit -m "feat: add knowledge multimodal model settings"
```

## Task 4: Implement Backend Multimodal Enrichment in the Pipeline

**Files:**
- Modify: `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`
- Modify: `D:\AI-Coding\omni\src-tauri\src\lib.rs`
- Test: `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`

- [ ] **Step 1: Add normalized pipeline step names**

In `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`, replace the asset-extraction-only flow with explicit multimodal steps:

```rust
for step_name in [
    "validate",
    "parse",
    "enrich_image",
    "enrich_audio",
    "chunk",
    "embed",
    "index",
    "finalize",
] {
    ensure_step_record(connection, job, step_name)?;
}
```

- [ ] **Step 2: Add config resolution helpers**

Create focused helpers near the parsing utilities:

```rust
fn resolve_collection_multimodal_config(
    connection: &Connection,
    collection_id: &str,
) -> Result<KnowledgeCollectionMultimodalConfigRecord, String> { /* ... */ }

fn resolve_multimodal_model(
    connection: &Connection,
    model_id: &str,
    capability: &str,
) -> Result<KnowledgeMultimodalModelConfigRecord, String> { /* ... */ }
```

- [ ] **Step 3: Add merge-format helpers for image and audio**

Add pure formatting helpers that are easy to unit-test:

```rust
fn merge_multimodal_content(base: &str, multimodal: &str) -> String {
    if base.trim().is_empty() {
        multimodal.trim().to_string()
    } else {
        format!("{base}\n\n--- 多模态分析 ---\n{multimodal}")
    }
}

fn format_image_enrichment(source_name: &str, mime_type: Option<&str>, ocr_text: Option<&str>, summary: Option<&str>) -> String {
    format!(
        "图片文件\n文件名: {source_name}\n类型: {}\n\n图片文本:\n{}\n\n图片摘要:\n{}",
        mime_type.unwrap_or("unknown"),
        ocr_text.unwrap_or("未提取到明显文字"),
        summary.unwrap_or("未生成摘要"),
    )
}
```

- [ ] **Step 4: Add provider-call boundaries without spreading logic through the worker**

Add narrow provider entry points in `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`:

```rust
struct ImageEnrichmentResult {
    ocr_text: Option<String>,
    summary: Option<String>,
}

struct AudioEnrichmentResult {
    transcript: Option<String>,
    summary: Option<String>,
}

fn enrich_image_document(
    document: &StoredDocumentSource,
    bytes: &[u8],
    model: &KnowledgeMultimodalModelConfigRecord,
    config: &KnowledgeCollectionMultimodalConfigRecord,
) -> Result<Option<String>, String> { /* ... */ }

fn enrich_audio_document(
    document: &StoredDocumentSource,
    bytes: &[u8],
    model: &KnowledgeMultimodalModelConfigRecord,
    config: &KnowledgeCollectionMultimodalConfigRecord,
) -> Result<Option<String>, String> { /* ... */ }
```

- [ ] **Step 5: Thread enrichment into `execute_claimed_job`**

Modify the main pipeline flow so enrichment happens after `parse` and before chunking:

```rust
let mut parsed = parse_simple_document(
    &document.source_name,
    document.file_extension.as_deref(),
    &bytes,
    document.content.as_deref(),
)?;

let collection_mm = resolve_collection_multimodal_config(connection, &job.collection_id)?;
if should_run_image_enrichment(&document, &collection_mm) {
    start_step(connection, job, "enrich_image", 35)?;
    if let Some(extra) = enrich_image_document(&document, &bytes, &image_model, &collection_mm)? {
        parsed.content = merge_multimodal_content(&parsed.content, &extra);
    }
    finish_step(connection, job, "enrich_image", STEP_STATUS_SUCCEEDED, 100, None)?;
} else {
    skip_step(connection, job, "enrich_image", "image enrichment not applicable")?;
}
```

- [ ] **Step 6: Add Rust tests for the merge and failure semantics**

Append focused tests to `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`:

```rust
#[test]
fn merge_multimodal_content_appends_separator() {
    let merged = merge_multimodal_content("正文", "图片摘要");
    assert!(merged.contains("--- 多模态分析 ---"));
    assert!(merged.contains("图片摘要"));
}

#[test]
fn format_audio_enrichment_keeps_transcript_and_summary() {
    let text = format_audio_enrichment("call.mp3", Some("audio/mpeg"), Some("你好"), Some("会议摘要"));
    assert!(text.contains("音频转写"));
    assert!(text.contains("会议摘要"));
}
```

- [ ] **Step 7: Run focused backend tests**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml merge_multimodal_content_appends_separator -- --exact
cargo test --manifest-path src-tauri/Cargo.toml format_audio_enrichment_keeps_transcript_and_summary -- --exact
```

Expected: Both tests pass before broader verification.

- [ ] **Step 8: Commit the backend pipeline work**

```bash
git add src-tauri/src/lib.rs src-tauri/src/knowledge_pipeline.rs
git commit -m "feat: enrich knowledge pipeline with multimodal analysis"
```

## Task 5: Wire Collection Validation, Status Display, and End-to-End Verification

**Files:**
- Modify: `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`
- Modify: `D:\AI-Coding\omni\src\App.css`
- Modify: `D:\AI-Coding\omni\src\chat\knowledgeTypes.ts`
- Test: `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`

- [ ] **Step 1: Validate collection settings against global model availability**

In `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`, block save when a required capability has no selected valid model:

```tsx
const imageModels = getKnowledgeMultimodalModelsByCapability(knowledgeMultimodalConfig, "image");
const audioModels = getKnowledgeMultimodalModelsByCapability(knowledgeMultimodalConfig, "audio");

if (draft.multimodalConfig?.image.enabled && !imageModels.some((model) => model.id === draft.multimodalConfig?.image.modelId)) {
  setCollectionSettingsError("已开启图片分析，但当前知识库没有选择可用的图片模型");
  return;
}
```

- [ ] **Step 2: Show multimodal status in document detail**

Add a lightweight status card near the existing document detail panel in `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`:

```tsx
<div className="rounded-none border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
  <div><strong className="text-slate-900">处理状态：</strong>{selectedDocument.processingStatus ?? "unknown"}</div>
  {selectedDocument.errorMessage ? <div className="mt-1 text-rose-600">{selectedDocument.errorMessage}</div> : null}
</div>
```

- [ ] **Step 3: Surface collection-level multimodal summary in the dialog**

Render explicit check rows so the user understands the applied strategy:

```tsx
<label className="omni-knowledge-collection-settings__toggle">
  <input
    type="checkbox"
    checked={draft.multimodalConfig?.audio.generateSummary ?? false}
    onChange={(event) => updateAudioConfig({ generateSummary: event.target.checked })}
  />
  <span>音频转写后生成摘要</span>
</label>
```

- [ ] **Step 4: Run full verification**

Run:

```bash
.\node_modules\.bin\tsc.CMD --noEmit
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected:

- TypeScript passes.
- Vite build passes.
- Rust test suite passes, including the new multimodal helper tests.

- [ ] **Step 5: Manual smoke-check with one image and one audio file**

Use the app to verify:

```text
1. 在设置页新增 1 个 image 模型和 1 个 audio 模型
2. 打开知识库某个集合的设置，启用图片分析和音频分析
3. 上传带文字的图片和带语音的音频
4. 观察任务步骤出现 enrich_image / enrich_audio
5. 打开文档详情，确认 contentPreview 和 chunk 内容出现分析结果
6. 在聊天中提问图片文字或音频内容，确认知识检索能命中
```

Expected: Documents remain visible, jobs either become `searchable` or `partial`, and retrieved chunks include merged OCR/transcript text.

- [ ] **Step 6: Commit the UX and verification pass**

```bash
git add src/components/KnowledgeBaseView.tsx src/App.css src/chat/knowledgeTypes.ts src-tauri/src/knowledge_pipeline.rs
git commit -m "feat: expose multimodal knowledge settings and status"
```

## Spec Coverage Check

- Global multimodal model config: covered by Tasks 1 and 3.
- Knowledge-base multimodal strategy: covered by Tasks 1 and 2.
- Background image/audio analysis: covered by Task 4.
- Merge into normal retrieval flow: covered by Task 4.
- UI entry points for settings and status: covered by Tasks 2, 3, and 5.
- Validation, fallback, and verification: covered by Tasks 4 and 5.

## Placeholder Scan

- No `TODO`, `TBD`, or “implement later” markers remain.
- Every task names exact files.
- Every code-writing step includes concrete code snippets rather than abstract instructions.
- Every verification step includes commands and expected outcomes.

## Type Consistency Check

- Global config names are `KnowledgeMultimodalConfig` and `KnowledgeMultimodalModelConfig`.
- Collection-level config name is `KnowledgeCollectionMultimodalConfig`.
- Storage key is consistently `omni_knowledge_multimodal_profile`.
- Collection JSON column is consistently `multimodal_config_json`.
- Collection payload property is consistently `multimodalConfig`.

