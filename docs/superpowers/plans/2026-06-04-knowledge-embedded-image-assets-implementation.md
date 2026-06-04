# Knowledge Embedded Image Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WeKnora-style embedded-image assets to Omni so `docx` and `pdf` documents can extract image children, create `image_ocr` / `image_caption` child chunks, and roll child search hits back to parent text chunks.

**Architecture:** Keep `knowledge_documents` as the only top-level document entity, add a dedicated `knowledge_document_assets` table for persisted extracted images, and extend `knowledge_chunks` with WeKnora-compatible fields: `chunk_type`, `parent_chunk_id`, and `image_info`. Reuse Omni's existing multimodal model configuration and pipeline scaffolding, but stop using merge-only indexing for embedded document images: image OCR/caption should become child chunks, while search and chat display the parent text chunk with inline image enrichment.

**Tech Stack:** React 19, TypeScript, Vite, Tauri 2, Rust, rusqlite, SQLite, reqwest, zip, quick-xml, lopdf, image

---

## File Structure

### Existing files to modify

- `D:\AI-Coding\omni\src-tauri\Cargo.toml`
  - Add Rust crates for `.docx` media extraction, PDF embedded-image traversal, and thumbnail generation.
- `D:\AI-Coding\omni\src-tauri\src\lib.rs`
  - Extend SQLite schema, Rust payload structs, document-detail loading, delete cleanup, and search result rollback payloads.
- `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`
  - Keep the current pipeline orchestration, but change embedded-document image handling from merge-only text enrichment to persisted assets plus child chunks.
- `D:\AI-Coding\omni\src\chat\knowledgeTypes.ts`
  - Extend document, chunk, asset, and search result contracts.
- `D:\AI-Coding\omni\src\chat\knowledgeContext.ts`
  - Build knowledge blocks from `displayChunk`, surface matched-source labels, and inline `image_info` as XML.
- `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`
  - Add `Assets` detail tab, asset preview state, and default text-only chunk rendering.
- `D:\AI-Coding\omni\src\App.css`
  - Style the new assets tab, selected asset panel, and matched-image metadata blocks.

### New files to create

- `D:\AI-Coding\omni\src-tauri\src\knowledge_embedded_images.rs`
  - Focused Rust module for embedded-image extraction, asset thumbnails, `image_info` JSON assembly, and child-chunk attachment helpers.

### Notes about current codebase state

- `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs` already contains in-progress merge-only multimodal enrichment work for standalone image/audio documents.
- This plan must preserve that behavior for standalone image/audio uploads.
- For embedded images inside `docx` / `pdf`, do not add a second merge-only path. Refactor the pipeline to create persisted assets and child chunks instead.

### Verification commands used throughout

- Rust focused test: `cargo test --manifest-path src-tauri/Cargo.toml <test_name> -- --exact`
- Rust full backend test file: `cargo test --manifest-path src-tauri/Cargo.toml knowledge_pipeline -- --nocapture`
- Frontend type-check: `.\node_modules\.bin\tsc.CMD --noEmit`
- Frontend production build: `npm run build`

## Task 1: Add Schema and Shared Contracts

**Files:**
- Modify: `D:\AI-Coding\omni\src-tauri\src\lib.rs`
- Modify: `D:\AI-Coding\omni\src\chat\knowledgeTypes.ts`
- Test: `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`

- [ ] **Step 1: Write the failing Rust schema test**

Add this test near the existing schema tests in `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`:

```rust
#[test]
fn ensure_knowledge_schema_adds_embedded_image_columns() {
    let connection = test_connection();

    crate::ensure_knowledge_schema(&connection).unwrap();

    assert!(crate::table_has_column(&connection, "knowledge_chunks", "chunk_type").unwrap());
    assert!(crate::table_has_column(&connection, "knowledge_chunks", "parent_chunk_id").unwrap());
    assert!(crate::table_has_column(&connection, "knowledge_chunks", "asset_id").unwrap());
    assert!(crate::table_has_column(&connection, "knowledge_chunks", "image_info").unwrap());
    assert!(crate::table_has_column(&connection, "knowledge_document_assets", "id").unwrap());
    assert!(crate::table_has_column(&connection, "knowledge_document_assets", "ocr_text").unwrap());
    assert!(crate::table_has_column(&connection, "knowledge_document_assets", "caption_text").unwrap());
}
```

- [ ] **Step 2: Run the schema test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml ensure_knowledge_schema_adds_embedded_image_columns -- --exact`

Expected: FAIL because `knowledge_document_assets` does not exist yet and the new `knowledge_chunks` columns are missing.

- [ ] **Step 3: Extend Rust payload structs for assets and chunk metadata**

Modify `D:\AI-Coding\omni\src-tauri\src\lib.rs` to add asset and chunk metadata records:

```rust
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnowledgeDocumentAssetRecord {
    id: String,
    document_id: String,
    collection_id: String,
    asset_kind: String,
    source_name: String,
    stored_file_path: String,
    mime_type: Option<String>,
    file_extension: Option<String>,
    preview_type: String,
    thumbnail_data_url: Option<String>,
    ocr_text: Option<String>,
    caption_text: Option<String>,
    content_preview: String,
    page_index: Option<i64>,
    asset_index: i64,
    metadata_json: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct KnowledgeChunkImageInfoRecord {
    asset_id: String,
    source_name: String,
    page_index: Option<i64>,
    asset_index: i64,
    original_markdown: Option<String>,
    thumbnail_data_url: Option<String>,
    ocr_text: Option<String>,
    caption_text: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeChunkRecord {
    id: String,
    document_id: String,
    collection_id: String,
    chunk_index: i64,
    title: Option<String>,
    content: String,
    chunk_type: Option<String>,
    parent_chunk_id: Option<String>,
    asset_id: Option<String>,
    image_info: Option<String>,
    embedding_json: Option<String>,
    embedding_model_key: Option<String>,
    created_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeDocumentDetailPayload {
    document: KnowledgeDocumentRecord,
    assets: Vec<KnowledgeDocumentAssetRecord>,
    chunks: Vec<KnowledgeChunkRecord>,
}
```

- [ ] **Step 4: Add SQLite migrations for assets and chunk metadata**

Extend `ensure_knowledge_schema` in `D:\AI-Coding\omni\src-tauri\src\lib.rs`:

```rust
if !table_has_column(connection, "knowledge_chunks", "chunk_type")? {
    connection
        .execute(
            "ALTER TABLE knowledge_chunks ADD COLUMN chunk_type TEXT NOT NULL DEFAULT 'text'",
            [],
        )
        .map_err(|err| err.to_string())?;
}

if !table_has_column(connection, "knowledge_chunks", "parent_chunk_id")? {
    connection
        .execute(
            "ALTER TABLE knowledge_chunks ADD COLUMN parent_chunk_id TEXT",
            [],
        )
        .map_err(|err| err.to_string())?;
}

if !table_has_column(connection, "knowledge_chunks", "asset_id")? {
    connection
        .execute("ALTER TABLE knowledge_chunks ADD COLUMN asset_id TEXT", [])
        .map_err(|err| err.to_string())?;
}

if !table_has_column(connection, "knowledge_chunks", "image_info")? {
    connection
        .execute("ALTER TABLE knowledge_chunks ADD COLUMN image_info TEXT", [])
        .map_err(|err| err.to_string())?;
}

connection.execute(
    r#"
    CREATE TABLE IF NOT EXISTS knowledge_document_assets (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      asset_kind TEXT NOT NULL,
      source_name TEXT NOT NULL,
      stored_file_path TEXT NOT NULL,
      mime_type TEXT,
      file_extension TEXT,
      preview_type TEXT NOT NULL,
      thumbnail_data_url TEXT,
      ocr_text TEXT,
      caption_text TEXT,
      content_preview TEXT NOT NULL,
      page_index INTEGER,
      asset_index INTEGER NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
    "#,
    [],
)
.map_err(|err| err.to_string())?;

connection.execute(
    "CREATE INDEX IF NOT EXISTS idx_knowledge_document_assets_document ON knowledge_document_assets (document_id, asset_index)",
    [],
)
.map_err(|err| err.to_string())?;
connection.execute(
    "CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_parent_chunk_id ON knowledge_chunks (parent_chunk_id)",
    [],
)
.map_err(|err| err.to_string())?;
connection.execute(
    "CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_asset_id ON knowledge_chunks (asset_id)",
    [],
)
.map_err(|err| err.to_string())?;
```

- [ ] **Step 5: Extend the TypeScript contracts**

Modify `D:\AI-Coding\omni\src\chat\knowledgeTypes.ts`:

```ts
export type KnowledgeChunkImageInfo = {
  assetId: string;
  sourceName: string;
  pageIndex?: number | null;
  assetIndex: number;
  originalMarkdown?: string | null;
  thumbnailDataUrl?: string | null;
  ocrText?: string | null;
  captionText?: string | null;
};

export type KnowledgeDocumentAsset = {
  id: string;
  documentId: string;
  collectionId: string;
  assetKind: "embedded_image";
  sourceName: string;
  storedFilePath: string;
  mimeType?: string | null;
  fileExtension?: string | null;
  previewType: "image";
  thumbnailDataUrl?: string | null;
  ocrText?: string | null;
  captionText?: string | null;
  contentPreview: string;
  pageIndex?: number | null;
  assetIndex: number;
  metadataJson?: string | null;
  createdAt: number;
  updatedAt: number;
};

export type KnowledgeDocumentChunk = {
  id: string;
  documentId: string;
  collectionId: string;
  chunkIndex: number;
  title?: string | null;
  content: string;
  chunkType?: "text" | "image_ocr" | "image_caption";
  parentChunkId?: string | null;
  assetId?: string | null;
  imageInfo?: string | null;
  embeddingJson?: string | null;
  embeddingModelKey?: string | null;
  createdAt: number;
};

export type KnowledgeDocumentDetail = {
  document: KnowledgeDocument & { content?: string | null };
  assets: KnowledgeDocumentAsset[];
  chunks: KnowledgeDocumentChunk[];
};
```

- [ ] **Step 6: Re-run Rust and TypeScript verification**

Run:

- `cargo test --manifest-path src-tauri/Cargo.toml ensure_knowledge_schema_adds_embedded_image_columns -- --exact`
- `.\node_modules\.bin\tsc.CMD --noEmit`

Expected:

- Rust test PASS
- TypeScript PASS

- [ ] **Step 7: Commit the schema groundwork**

```bash
git add src-tauri/src/lib.rs src/chat/knowledgeTypes.ts src-tauri/src/knowledge_pipeline.rs
git commit -m "feat: add embedded image asset schema and contracts"
```

## Task 2: Create the Embedded Image Extraction Module

**Files:**
- Modify: `D:\AI-Coding\omni\src-tauri\Cargo.toml`
- Modify: `D:\AI-Coding\omni\src-tauri\src\lib.rs`
- Create: `D:\AI-Coding\omni\src-tauri\src\knowledge_embedded_images.rs`
- Test: `D:\AI-Coding\omni\src-tauri\src\knowledge_embedded_images.rs`

- [ ] **Step 1: Add the failing `.docx` extraction test**

Create `D:\AI-Coding\omni\src-tauri\src\knowledge_embedded_images.rs` with this test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn build_docx_with_embedded_png() -> Vec<u8> {
        let cursor = std::io::Cursor::new(Vec::<u8>::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options = SimpleFileOptions::default();

        writer.start_file("[Content_Types].xml", options).unwrap();
        writer.write_all(br#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
</Types>"#).unwrap();

        writer.start_file("word/media/image1.png", options).unwrap();
        writer.write_all(&[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
            0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
            0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
            0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41,
            0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
            0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D,
            0xB1, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
            0x44, 0xAE, 0x42, 0x60, 0x82,
        ]).unwrap();

        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn extract_docx_embedded_images_returns_media_entries() {
        let bytes = build_docx_with_embedded_png();
        let assets = extract_docx_embedded_images(&bytes).unwrap();

        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].source_name, "image1.png");
        assert_eq!(assets[0].mime_type.as_deref(), Some("image/png"));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml extract_docx_embedded_images_returns_media_entries -- --exact`

Expected: FAIL because the new module and extraction function do not exist yet.

- [ ] **Step 3: Add extraction dependencies and module wiring**

Modify `D:\AI-Coding\omni\src-tauri\Cargo.toml` and `D:\AI-Coding\omni\src-tauri\src\lib.rs`:

```toml
[dependencies]
zip = "2.2.0"
quick-xml = "0.37.2"
lopdf = "0.35.0"
image = "0.25.5"
```

```rust
mod knowledge_chunker;
mod knowledge_embedded_images;
mod knowledge_pipeline;
```

- [ ] **Step 4: Implement the new Rust helper module**

Add the core extraction helpers in `D:\AI-Coding\omni\src-tauri\src\knowledge_embedded_images.rs`:

```rust
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use image::ImageFormat;
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read};
use zip::ZipArchive;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddedImageAssetCandidate {
    pub source_name: String,
    pub mime_type: Option<String>,
    pub file_extension: Option<String>,
    pub bytes: Vec<u8>,
    pub page_index: Option<i64>,
    pub asset_index: i64,
    pub anchor_text: Option<String>,
    pub ocr_text: Option<String>,
    pub caption_text: Option<String>,
    pub thumbnail_data_url: Option<String>,
}

pub fn extract_docx_embedded_images(bytes: &[u8]) -> Result<Vec<EmbeddedImageAssetCandidate>, String> {
    let cursor = Cursor::new(bytes.to_vec());
    let mut archive = ZipArchive::new(cursor).map_err(|err| err.to_string())?;
    let mut assets = Vec::new();

    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(|err| err.to_string())?;
        let name = file.name().to_string();
        if !name.starts_with("word/media/") {
            continue;
        }

        let mut image_bytes = Vec::new();
        file.read_to_end(&mut image_bytes).map_err(|err| err.to_string())?;
        let source_name = name.rsplit('/').next().unwrap_or("embedded-image").to_string();
        let extension = source_name.rsplit('.').next().map(|value| value.to_lowercase());
        let mime_type = match extension.as_deref() {
            Some("png") => Some("image/png".to_string()),
            Some("jpg") | Some("jpeg") => Some("image/jpeg".to_string()),
            Some("gif") => Some("image/gif".to_string()),
            Some("webp") => Some("image/webp".to_string()),
            Some("bmp") => Some("image/bmp".to_string()),
            _ => None,
        };

        assets.push(EmbeddedImageAssetCandidate {
            source_name,
            mime_type,
            file_extension: extension,
            bytes: image_bytes.clone(),
            page_index: None,
            asset_index: assets.len() as i64,
            anchor_text: None,
            ocr_text: None,
            caption_text: None,
            thumbnail_data_url: build_thumbnail_data_url(&image_bytes),
        });
    }

    Ok(assets)
}

pub fn build_thumbnail_data_url(bytes: &[u8]) -> Option<String> {
    let image = image::load_from_memory(bytes).ok()?;
    let thumbnail = image.thumbnail(240, 240);
    let mut encoded = Vec::new();
    thumbnail.write_to(&mut Cursor::new(&mut encoded), ImageFormat::Png).ok()?;
    Some(format!("data:image/png;base64,{}", BASE64_STANDARD.encode(encoded)))
}
```

- [ ] **Step 5: Re-run the extraction test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml extract_docx_embedded_images_returns_media_entries -- --exact`

Expected: PASS

- [ ] **Step 6: Commit the extraction module**

```bash
git add src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/src/knowledge_embedded_images.rs
git commit -m "feat: add embedded image extraction helpers"
```

## Task 3: Persist `.docx` Assets and Create Child Chunks

**Files:**
- Modify: `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`
- Modify: `D:\AI-Coding\omni\src-tauri\src\knowledge_embedded_images.rs`
- Test: `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`

- [ ] **Step 1: Write the failing pipeline test for `.docx` child chunks**

Add this test in `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`:

```rust
#[test]
fn pipeline_docx_embedded_images_create_assets_and_child_chunks() {
    let connection = test_connection();
    let (collection_id, document_id) = seed_collection_and_document(&connection);

    connection.execute(
        "UPDATE knowledge_documents SET source_name = ?2, file_extension = 'docx', preview_type = 'docx', content = ?3 WHERE id = ?1",
        params![document_id, "report.docx", "标题\n\n正文"],
    ).unwrap();

    let now = current_timestamp_ms();
    let job = insert_job_record(
        &connection,
        &document_id,
        &collection_id,
        "initial_import",
        0,
        1,
        0,
        0,
        None,
        None,
        now,
    ).unwrap();
    let claim = PipelineJobClaim {
        id: job.id.clone(),
        document_id: document_id.clone(),
        collection_id: collection_id.clone(),
    };

    let parsed = ParsedDocument {
        content: "标题\n\n正文".to_string(),
        preview_type: "docx".to_string(),
        metadata_json: None,
    };

    let chunks = split_parsed_document_into_chunks(&parsed, "report.docx", Some("docx"));
    assert!(!chunks.is_empty());

    let assets = vec![crate::knowledge_embedded_images::EmbeddedImageAssetCandidate {
        source_name: "image1.png".to_string(),
        mime_type: Some("image/png".to_string()),
        file_extension: Some("png".to_string()),
        bytes: vec![1, 2, 3],
        page_index: None,
        asset_index: 0,
        anchor_text: Some("正文".to_string()),
        ocr_text: Some("图中写着数据库连接串".to_string()),
        caption_text: Some("这是一张系统架构图".to_string()),
        thumbnail_data_url: None,
    }];

    let derived = build_embedded_image_child_chunks(&chunks, &assets, &document_id, &collection_id, now);
    assert_eq!(derived.assets.len(), 1);
    assert!(derived.child_chunks.iter().any(|chunk| chunk.chunk_type == "image_ocr" || chunk.chunk_type == "image_caption"));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pipeline_docx_embedded_images_create_assets_and_child_chunks -- --exact`

Expected: FAIL because `build_embedded_image_child_chunks` and the asset persistence path do not exist.

- [ ] **Step 3: Add the child-chunk assembly structs**

Extend `D:\AI-Coding\omni\src-tauri\src\knowledge_embedded_images.rs`:

```rust
#[derive(Debug, Clone)]
pub struct EmbeddedImageChildChunkCandidate {
    pub title: Option<String>,
    pub content: String,
    pub chunk_type: String,
    pub parent_chunk_index: usize,
    pub parent_chunk_id: Option<String>,
    pub asset_id: String,
    pub image_info: String,
}

#[derive(Debug, Clone)]
pub struct EmbeddedImageBuildOutput {
    pub assets: Vec<crate::KnowledgeDocumentAssetRecord>,
    pub child_chunks: Vec<EmbeddedImageChildChunkCandidate>,
}
```

- [ ] **Step 4: Implement parent attachment and image child chunk creation**

Add this helper in `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`:

```rust
fn build_embedded_image_child_chunks(
    text_chunks: &[knowledge_chunker::ChunkSlice],
    assets: &[crate::knowledge_embedded_images::EmbeddedImageAssetCandidate],
    document_id: &str,
    collection_id: &str,
    now: i64,
) -> EmbeddedImageBuildOutput {
    let mut asset_rows = Vec::new();
    let mut child_chunks = Vec::new();

    for asset in assets {
        let asset_id = uuid::Uuid::new_v4().to_string();
        let parent_chunk_index = asset
            .anchor_text
            .as_deref()
            .and_then(|anchor| text_chunks.iter().position(|chunk| chunk.content.contains(anchor)))
            .unwrap_or_else(|| if text_chunks.is_empty() { 0 } else { text_chunks.len() - 1 });

        let image_info = serde_json::json!({
            "assetId": asset_id,
            "sourceName": asset.source_name,
            "pageIndex": asset.page_index,
            "assetIndex": asset.asset_index,
            "thumbnailDataUrl": asset.thumbnail_data_url,
        })
        .to_string();

        asset_rows.push(crate::KnowledgeDocumentAssetRecord {
            id: asset_id.clone(),
            document_id: document_id.to_string(),
            collection_id: collection_id.to_string(),
            asset_kind: "embedded_image".to_string(),
            source_name: asset.source_name.clone(),
            stored_file_path: String::new(),
            mime_type: asset.mime_type.clone(),
            file_extension: asset.file_extension.clone(),
            preview_type: "image".to_string(),
            thumbnail_data_url: asset.thumbnail_data_url.clone(),
            ocr_text: asset.ocr_text.clone(),
            caption_text: asset.caption_text.clone(),
            content_preview: asset.source_name.clone(),
            page_index: asset.page_index,
            asset_index: asset.asset_index,
            metadata_json: None,
            created_at: now,
            updated_at: now,
        });

        if let Some(ocr_text) = asset.ocr_text.as_deref().filter(|value| !value.trim().is_empty()) {
            child_chunks.push(EmbeddedImageChildChunkCandidate {
                title: Some(format!("Embedded image {} OCR", asset.asset_index + 1)),
                content: format!("Image OCR\nSource: {}\nText:\n{}", asset.source_name, ocr_text),
                chunk_type: "image_ocr".to_string(),
                parent_chunk_index,
                parent_chunk_id: None,
                asset_id: asset_id.clone(),
                image_info: image_info.clone(),
            });
        }

        if let Some(caption_text) = asset
            .caption_text
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            child_chunks.push(EmbeddedImageChildChunkCandidate {
                title: Some(format!("Embedded image {} Caption", asset.asset_index + 1)),
                content: format!("Image Caption\nSource: {}\nSummary:\n{}", asset.source_name, caption_text),
                chunk_type: "image_caption".to_string(),
                parent_chunk_index,
                parent_chunk_id: None,
                asset_id,
                image_info,
            });
        }
    }

    EmbeddedImageBuildOutput {
        assets: asset_rows,
        child_chunks,
    }
}
```

- [ ] **Step 5: Wire `.docx` asset persistence into the pipeline**

Modify the chunk/index section in `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs` so text chunks remain first, child chunks get unique trailing `chunk_index` values, and assets are persisted:

```rust
let text_chunks = split_parsed_document_into_chunks(&parsed, source_name, file_extension);
let doc_assets = if parsed.preview_type == "docx" {
    crate::knowledge_embedded_images::extract_docx_embedded_images(&bytes)?
} else {
    Vec::new()
};
let embedded = build_embedded_image_child_chunks(
    &text_chunks,
    &doc_assets,
    &job.document_id,
    &job.collection_id,
    now,
);

tx.execute(
    "DELETE FROM knowledge_document_assets WHERE document_id = ?1",
    params![job.document_id],
)?;

let mut next_chunk_index = text_chunks.len() as i64;
for child in &embedded.child_chunks {
    stmt.execute(params![
        uuid::Uuid::new_v4().to_string(),
        job.document_id,
        job.collection_id,
        next_chunk_index,
        child.title.clone(),
        child.content.clone(),
        child.chunk_type.clone(),
        child.parent_chunk_id.clone(),
        Some(child.asset_id.clone()),
        Some(child.image_info.clone()),
        Option::<String>::None,
        Option::<String>::None,
        now,
    ])?;
    next_chunk_index += 1;
}
```

- [ ] **Step 6: Re-run the pipeline test**

Run: `cargo test --manifest-path src-tauri/Cargo.toml pipeline_docx_embedded_images_create_assets_and_child_chunks -- --exact`

Expected: PASS

- [ ] **Step 7: Commit the `.docx` child-chunk pipeline work**

```bash
git add src-tauri/src/knowledge_pipeline.rs src-tauri/src/knowledge_embedded_images.rs
git commit -m "feat: persist docx embedded image assets and child chunks"
```

## Task 4: Load Assets in Document Detail and Clean Them Up on Rebuild/Delete

**Files:**
- Modify: `D:\AI-Coding\omni\src-tauri\src\lib.rs`
- Modify: `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`
- Test: `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`

- [ ] **Step 1: Write the failing detail/cleanup tests**

Add these tests in `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`:

```rust
#[test]
fn load_knowledge_document_includes_assets() {
    let connection = test_connection();
    let (collection_id, document_id) = seed_collection_and_document(&connection);
    let now = current_timestamp_ms();

    connection.execute(
        r#"
        INSERT INTO knowledge_document_assets (
          id, document_id, collection_id, asset_kind, source_name, stored_file_path, preview_type,
          content_preview, asset_index, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'embedded_image', 'image1.png', 'tmp/image1.png', 'image', 'image1.png', 0, ?4, ?4)
        "#,
        params!["asset-1", document_id, collection_id, now],
    ).unwrap();

    let detail = crate::load_knowledge_document(&connection, &document_id).unwrap();
    assert_eq!(detail.assets.len(), 1);
    assert_eq!(detail.assets[0].source_name, "image1.png");
}

#[test]
fn delete_knowledge_document_removes_assets() {
    let connection = test_connection();
    let (collection_id, document_id) = seed_collection_and_document(&connection);
    let now = current_timestamp_ms();

    connection.execute(
        r#"INSERT INTO knowledge_document_assets (
          id, document_id, collection_id, asset_kind, source_name, stored_file_path, preview_type,
          content_preview, asset_index, created_at, updated_at
        ) VALUES (?1, ?2, ?3, 'embedded_image', 'image1.png', 'tmp/image1.png', 'image', 'image1.png', 0, ?4, ?4)"#,
        params!["asset-1", document_id, collection_id, now],
    ).unwrap();

    crate::delete_knowledge_document(&connection, &document_id).unwrap();

    let count: i64 = connection.query_row(
        "SELECT COUNT(1) FROM knowledge_document_assets WHERE document_id = ?1",
        params![document_id],
        |row| row.get(0),
    ).unwrap();
    assert_eq!(count, 0);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

- `cargo test --manifest-path src-tauri/Cargo.toml load_knowledge_document_includes_assets -- --exact`
- `cargo test --manifest-path src-tauri/Cargo.toml delete_knowledge_document_removes_assets -- --exact`

Expected: FAIL because `load_knowledge_document` does not return assets and delete cleanup does not touch the new table.

- [ ] **Step 3: Load assets and full chunk metadata in document detail**

Modify `D:\AI-Coding\omni\src-tauri\src\lib.rs`:

```rust
let mut asset_stmt = connection
    .prepare(
        r#"
        SELECT id, document_id, collection_id, asset_kind, source_name, stored_file_path, mime_type,
               file_extension, preview_type, thumbnail_data_url, ocr_text, caption_text, content_preview,
               page_index, asset_index, metadata_json, created_at, updated_at
        FROM knowledge_document_assets
        WHERE document_id = ?1
        ORDER BY asset_index ASC, created_at ASC, id ASC
        "#,
    )
    .map_err(|err| err.to_string())?;
let assets = asset_stmt
    .query_map(params![document_id], |row| {
        Ok(KnowledgeDocumentAssetRecord {
            id: row.get(0)?,
            document_id: row.get(1)?,
            collection_id: row.get(2)?,
            asset_kind: row.get(3)?,
            source_name: row.get(4)?,
            stored_file_path: row.get(5)?,
            mime_type: row.get(6)?,
            file_extension: row.get(7)?,
            preview_type: row.get(8)?,
            thumbnail_data_url: row.get(9)?,
            ocr_text: row.get(10)?,
            caption_text: row.get(11)?,
            content_preview: row.get(12)?,
            page_index: row.get(13)?,
            asset_index: row.get(14)?,
            metadata_json: row.get(15)?,
            created_at: row.get(16)?,
            updated_at: row.get(17)?,
        })
    })?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|err| err.to_string())?;
```

Also update the chunk query:

```rust
SELECT id, document_id, collection_id, chunk_index, title, content, chunk_type, parent_chunk_id, asset_id, image_info, embedding_json, embedding_model_key, created_at
FROM knowledge_chunks
WHERE document_id = ?1
ORDER BY chunk_index ASC, created_at ASC, id ASC
```

- [ ] **Step 4: Remove assets during rebuild and delete**

Modify `D:\AI-Coding\omni\src-tauri\src\lib.rs` and `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`:

```rust
tx.execute(
    "DELETE FROM knowledge_document_assets WHERE document_id = ?1",
    params![document_id],
)
.map_err(|err| err.to_string())?;
```

Add a helper to remove stored asset files:

```rust
fn delete_stored_asset_files(connection: &Connection, document_id: &str) -> Result<(), String> {
    let mut stmt = connection
        .prepare("SELECT stored_file_path FROM knowledge_document_assets WHERE document_id = ?1")
        .map_err(|err| err.to_string())?;
    let paths = stmt
        .query_map(params![document_id], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())?;

    for path in paths {
        let _ = fs::remove_file(path);
    }

    Ok(())
}
```

- [ ] **Step 5: Re-run the detail/cleanup tests**

Run:

- `cargo test --manifest-path src-tauri/Cargo.toml load_knowledge_document_includes_assets -- --exact`
- `cargo test --manifest-path src-tauri/Cargo.toml delete_knowledge_document_removes_assets -- --exact`

Expected: PASS

- [ ] **Step 6: Commit the detail payload and cleanup work**

```bash
git add src-tauri/src/lib.rs src-tauri/src/knowledge_pipeline.rs
git commit -m "feat: load embedded image assets in document detail"
```

## Task 5: Roll Child Search Hits Back to Parent Text Chunks

**Files:**
- Modify: `D:\AI-Coding\omni\src-tauri\src\lib.rs`
- Modify: `D:\AI-Coding\omni\src\chat\knowledgeTypes.ts`
- Modify: `D:\AI-Coding\omni\src\chat\knowledgeContext.ts`
- Test: `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`

- [ ] **Step 1: Write the failing rollback test**

Add this test in `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`:

```rust
#[test]
fn search_knowledge_chunks_rolls_child_hits_back_to_parent() {
    let connection = test_connection();
    let (collection_id, document_id) = seed_collection_and_document(&connection);
    let now = current_timestamp_ms();

    connection.execute(
        "DELETE FROM knowledge_chunks WHERE document_id = ?1",
        params![document_id],
    ).unwrap();

    connection.execute(
        r#"
        INSERT INTO knowledge_chunks (
          id, document_id, collection_id, chunk_index, title, content, chunk_type, parent_chunk_id, asset_id, image_info, created_at
        ) VALUES (?1, ?2, ?3, 0, '正文', '这是父正文段落，包含系统设计说明。', 'text', NULL, NULL, NULL, ?4)
        "#,
        params!["text-1", document_id, collection_id, now],
    ).unwrap();

    connection.execute(
        r#"
        INSERT INTO knowledge_chunks (
          id, document_id, collection_id, chunk_index, title, content, chunk_type, parent_chunk_id, asset_id, image_info, created_at
        ) VALUES (?1, ?2, ?3, 1, 'Image OCR', '数据库连接串在图片里', 'image_ocr', 'text-1', 'asset-1', '{"assetId":"asset-1","sourceName":"diagram.png"}', ?4)
        "#,
        params!["ocr-1", document_id, collection_id, now],
    ).unwrap();

    let results = crate::search_knowledge_chunks(
        &connection,
        crate::SearchKnowledgeChunksInput {
            query: "数据库连接串".to_string(),
            limit: Some(5),
            collection_id: Some(collection_id),
            query_embedding: None,
            query_embedding_model_key: None,
        },
    ).unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].matched_chunk.as_ref().unwrap().id, "ocr-1");
    assert_eq!(results[0].display_chunk.as_ref().unwrap().id, "text-1");
    assert_eq!(results[0].chunk.id, "text-1");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml search_knowledge_chunks_rolls_child_hits_back_to_parent -- --exact`

Expected: FAIL because search results currently only return a single flat `chunk`.

- [ ] **Step 3: Extend the backend search result shape**

Modify `D:\AI-Coding\omni\src-tauri\src\lib.rs`:

```rust
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchKnowledgeChunkResult {
    chunk: KnowledgeChunkRecord,
    matched_chunk: Option<KnowledgeChunkRecord>,
    display_chunk: Option<KnowledgeChunkRecord>,
    matched_chunk_type: Option<String>,
    parent_chunk_id: Option<String>,
    image_info: Option<String>,
    matched_asset: Option<KnowledgeDocumentAssetRecord>,
    score: f64,
    source_name: String,
    source_path: Option<String>,
    collection_name: String,
    tags: Vec<String>,
    favorite: bool,
    access_count: i64,
    last_accessed_at: Option<i64>,
    title_hierarchy: Option<String>,
}
```

- [ ] **Step 4: Resolve display chunks and deduplicate by parent**

Add a helper in `D:\AI-Coding\omni\src-tauri\src\lib.rs`:

```rust
fn resolve_display_chunk(
    connection: &Connection,
    candidate: &KnowledgeSearchCandidate,
) -> Result<(KnowledgeChunkRecord, Option<KnowledgeChunkRecord>), String> {
    let matched = KnowledgeChunkRecord {
        id: candidate.chunk_id.clone(),
        document_id: candidate.document_id.clone(),
        collection_id: candidate.collection_id.clone(),
        chunk_index: candidate.chunk_index,
        title: candidate.title.clone(),
        content: candidate.content.clone(),
        chunk_type: candidate.chunk_type.clone(),
        parent_chunk_id: candidate.parent_chunk_id.clone(),
        asset_id: candidate.asset_id.clone(),
        image_info: candidate.image_info.clone(),
        embedding_json: candidate.embedding_json.clone(),
        embedding_model_key: candidate.embedding_model_key.clone(),
        created_at: candidate.created_at,
    };

    if matches!(candidate.chunk_type.as_deref(), Some("image_ocr" | "image_caption")) {
        let parent = load_chunk_record_by_id(connection, candidate.parent_chunk_id.as_deref().unwrap_or_default())?;
        return Ok((parent, Some(matched)));
    }

    Ok((matched.clone(), Some(matched)))
}
```

Then deduplicate after scoring:

```rust
let mut by_display_id: HashMap<String, SearchKnowledgeChunkResult> = HashMap::new();
for (score, candidate) in scored {
    let (display_chunk, matched_chunk) = resolve_display_chunk(connection, &candidate)?;
    let entry = SearchKnowledgeChunkResult {
        chunk: display_chunk.clone(),
        matched_chunk: matched_chunk.clone(),
        display_chunk: Some(display_chunk.clone()),
        matched_chunk_type: candidate.chunk_type.clone(),
        parent_chunk_id: candidate.parent_chunk_id.clone(),
        image_info: candidate.image_info.clone(),
        matched_asset: None,
        score,
        source_name: candidate.source_name.clone(),
        source_path: candidate.source_path.clone(),
        collection_name: candidate.collection_name.clone(),
        tags: candidate.tags.clone(),
        favorite: candidate.favorite,
        access_count: candidate.access_count,
        last_accessed_at: candidate.last_accessed_at,
        title_hierarchy: candidate.title_hierarchy.clone(),
    };

    match by_display_id.get(&display_chunk.id) {
        Some(existing) if existing.score >= score => {}
        _ => {
            by_display_id.insert(display_chunk.id.clone(), entry);
        }
    }
}
```

- [ ] **Step 5: Teach the frontend to consume `displayChunk` and inline `image_info`**

Modify `D:\AI-Coding\omni\src\chat\knowledgeTypes.ts` and `D:\AI-Coding\omni\src\chat\knowledgeContext.ts`:

```ts
export type SearchKnowledgeChunkResult = {
  chunk: KnowledgeDocumentChunk;
  matchedChunk?: KnowledgeDocumentChunk | null;
  displayChunk?: KnowledgeDocumentChunk | null;
  matchedChunkType?: "text" | "image_ocr" | "image_caption" | null;
  parentChunkId?: string | null;
  imageInfo?: string | null;
  matchedAsset?: KnowledgeDocumentAsset | null;
  score: number;
  sourceName: string;
  sourcePath?: string | null;
  collectionName: string;
  tags: string[];
  favorite: boolean;
  accessCount: number;
  lastAccessedAt?: number | null;
  titleHierarchy?: string | null;
};

function buildImageInfoBlock(result: SearchKnowledgeChunkResult) {
  if (!result.imageInfo) return "";
  return `\n<image_match>\n<match_type>${result.matchedChunkType ?? "text"}</match_type>\n<image_info>${result.imageInfo}</image_info>\n</image_match>`;
}
```

Use `displayChunk ?? chunk` when building sources:

```ts
const displayChunk = item.displayChunk ?? item.chunk;
const imageBlock = buildImageInfoBlock(item);
excerpt: clipText(`${displayChunk.content}${imageBlock}`, 420),
```

- [ ] **Step 6: Re-run backend and frontend verification**

Run:

- `cargo test --manifest-path src-tauri/Cargo.toml search_knowledge_chunks_rolls_child_hits_back_to_parent -- --exact`
- `.\node_modules\.bin\tsc.CMD --noEmit`
- `npm run build`

Expected:

- Rust test PASS
- TypeScript PASS
- Vite build PASS

- [ ] **Step 7: Commit the rollback search behavior**

```bash
git add src-tauri/src/lib.rs src/chat/knowledgeTypes.ts src/chat/knowledgeContext.ts src-tauri/src/knowledge_pipeline.rs
git commit -m "feat: roll embedded image hits back to parent chunks"
```

## Task 6: Add the Assets Tab and Default Text-Only Chunk View

**Files:**
- Modify: `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`
- Modify: `D:\AI-Coding\omni\src\App.css`
- Test: `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`

- [ ] **Step 1: Add the `assets` view branch first so the build fails on missing state**

Modify `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`:

```tsx
type KnowledgeDocumentDetailView = "preview" | "assets" | "chunks" | "processing";

// Inside the detail tab buttons
<button
  type="button"
  onClick={() => setSelectedDocumentDetailView("assets")}
  className={selectedDocumentDetailView === "assets" ? "bg-slate-950 text-white" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"}
>
  Assets
</button>

// Inside the detail body switch
) : selectedDocumentDetailView === "assets" ? (
  <div className="omni-knowledge-assets-view">
    {selectedDocumentDetail.assets.map((asset) => (
      <button
        key={asset.id}
        type="button"
        onClick={() => setSelectedAssetId(asset.id)}
        className={asset.id === selectedAssetId ? "omni-knowledge-asset-card omni-knowledge-asset-card--active" : "omni-knowledge-asset-card"}
      >
        {asset.sourceName}
      </button>
    ))}
  </div>
```

- [ ] **Step 2: Run the frontend build to verify it fails**

Run: `npm run build`

Expected: FAIL with a TypeScript error like `Cannot find name 'selectedAssetId'`.

- [ ] **Step 3: Implement asset selection state and text-only chunk filtering**

Extend `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`:

```tsx
const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

useEffect(() => {
  const firstAssetId = selectedDocumentDetail?.assets[0]?.id ?? null;
  setSelectedAssetId(firstAssetId);
}, [selectedDocumentDetail?.document.id, selectedDocumentDetail?.assets]);

const visibleDocumentChunks = useMemo(() => {
  const chunks = selectedDocumentDetail?.chunks ?? [];
  const textChunks = chunks.filter((chunk) => (chunk.chunkType ?? "text") === "text");
  const normalizedQuery = normalizeSearchText(chunkSearchQuery);
  if (!normalizedQuery) {
    return textChunks;
  }
  return textChunks.filter((chunk) =>
    normalizeSearchText([chunk.title ?? "", chunk.content].join(" ")).includes(normalizedQuery)
  );
}, [chunkSearchQuery, selectedDocumentDetail?.chunks]);

const selectedAsset = useMemo(
  () => selectedDocumentDetail?.assets.find((asset) => asset.id === selectedAssetId) ?? null,
  [selectedAssetId, selectedDocumentDetail?.assets]
);
```

- [ ] **Step 4: Render the asset preview panel and empty state**

Add this JSX in `D:\AI-Coding\omni\src\components\KnowledgeBaseView.tsx`:

```tsx
<div className="omni-knowledge-assets-view">
  {selectedDocumentDetail.assets.length === 0 ? (
    <div className="rounded-none border border-dashed border-slate-200 px-4 py-10 text-center text-sm text-slate-500">
      当前文档没有提取到嵌入图片。
    </div>
  ) : (
    <div className="omni-knowledge-assets-layout">
      <div className="omni-knowledge-assets-list">
        {selectedDocumentDetail.assets.map((asset) => (
          <button
            key={asset.id}
            type="button"
            onClick={() => setSelectedAssetId(asset.id)}
            className={asset.id === selectedAssetId ? "omni-knowledge-asset-card omni-knowledge-asset-card--active" : "omni-knowledge-asset-card"}
          >
            {asset.thumbnailDataUrl ? <img src={asset.thumbnailDataUrl} alt={asset.sourceName} className="h-20 w-full object-cover" /> : null}
            <div className="mt-2 text-sm font-medium text-slate-900">{asset.sourceName}</div>
            <div className="mt-1 text-xs text-slate-500">{asset.contentPreview}</div>
          </button>
        ))}
      </div>

      <div className="omni-knowledge-assets-detail">
        {selectedAsset ? (
          <>
            {selectedAsset.thumbnailDataUrl ? (
              <img src={selectedAsset.thumbnailDataUrl} alt={selectedAsset.sourceName} className="max-h-[22rem] w-full object-contain" />
            ) : null}
            <div className="mt-4 text-sm font-medium text-slate-900">{selectedAsset.sourceName}</div>
            <pre className="mt-3 whitespace-pre-wrap rounded-none bg-slate-50 p-4 text-sm text-slate-700">
              {selectedAsset.ocrText || selectedAsset.captionText || "暂无 OCR 或描述内容。"}
            </pre>
          </>
        ) : null}
      </div>
    </div>
  )}
</div>
```

- [ ] **Step 5: Add the CSS for the assets tab**

Modify `D:\AI-Coding\omni\src\App.css`:

```css
.omni-knowledge-assets-layout {
  display: grid;
  grid-template-columns: minmax(16rem, 22rem) minmax(0, 1fr);
  gap: 16px;
  min-height: 0;
}

.omni-knowledge-assets-list {
  display: grid;
  gap: 12px;
  align-content: start;
  overflow-y: auto;
  padding-right: 4px;
}

.omni-knowledge-asset-card {
  border: 1px solid rgb(226 232 240);
  background: white;
  padding: 12px;
  text-align: left;
}

.omni-knowledge-asset-card--active {
  border-color: rgb(15 23 42);
  box-shadow: inset 0 0 0 1px rgb(15 23 42);
}

.omni-knowledge-assets-detail {
  min-height: 0;
  overflow-y: auto;
  border: 1px solid rgb(226 232 240);
  background: white;
  padding: 16px;
}
```

- [ ] **Step 6: Re-run frontend verification**

Run:

- `.\node_modules\.bin\tsc.CMD --noEmit`
- `npm run build`

Expected:

- TypeScript PASS
- Vite build PASS

- [ ] **Step 7: Commit the detail-view UI**

```bash
git add src/components/KnowledgeBaseView.tsx src/App.css
git commit -m "feat: add embedded image assets tab"
```

## Task 7: Add PDF Embedded-Image Extraction and Regression Coverage

**Files:**
- Modify: `D:\AI-Coding\omni\src-tauri\src\knowledge_embedded_images.rs`
- Modify: `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`
- Test: `D:\AI-Coding\omni\src-tauri\src\knowledge_embedded_images.rs`
- Test: `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`

- [ ] **Step 1: Write the failing PDF no-image test**

Add this test in `D:\AI-Coding\omni\src-tauri\src\knowledge_embedded_images.rs`:

```rust
#[test]
fn extract_pdf_embedded_images_returns_empty_without_failure() {
    use lopdf::{dictionary, Document, Object, Stream};

    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let page_id = doc.new_object_id();
    let contents_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));

    doc.objects.insert(
        page_id,
        Object::Dictionary(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => contents_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
        }),
    );
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => vec![page_id.into()],
            "Count" => 1,
        }),
    );
    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).unwrap();

    let assets = extract_pdf_embedded_images(&bytes).unwrap();
    assert!(assets.is_empty());
}
```

- [ ] **Step 2: Run the PDF test to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml extract_pdf_embedded_images_returns_empty_without_failure -- --exact`

Expected: FAIL because `extract_pdf_embedded_images` does not exist yet.

- [ ] **Step 3: Implement best-effort PDF embedded-image extraction**

Extend `D:\AI-Coding\omni\src-tauri\src\knowledge_embedded_images.rs`:

```rust
pub fn extract_pdf_embedded_images(bytes: &[u8]) -> Result<Vec<EmbeddedImageAssetCandidate>, String> {
    let document = lopdf::Document::load_mem(bytes).map_err(|err| err.to_string())?;
    let mut assets = Vec::new();

    for (page_index, page_id) in document.get_pages().values().enumerate() {
        let page = document.get_object(*page_id).map_err(|err| err.to_string())?;
        let resources = page
            .as_dict()
            .ok()
            .and_then(|dict| dict.get(b"Resources").ok())
            .and_then(|obj| obj.as_reference().ok())
            .and_then(|id| document.get_object(id).ok())
            .and_then(|obj| obj.as_dict().ok());

        let Some(resources) = resources else {
            continue;
        };
        let Some(xobjects) = resources.get(b"XObject").ok().and_then(|obj| obj.as_dict().ok()) else {
            continue;
        };

        for (name, reference) in xobjects {
            let Ok(object_id) = reference.as_reference() else { continue };
            let Ok(stream) = document.get_object(object_id).and_then(|obj| obj.as_stream()) else { continue };
            let Ok(subtype) = stream.dict.get(b"Subtype").and_then(|obj| obj.as_name()) else { continue };
            if subtype != b"Image" {
                continue;
            }

            let bytes = stream.decompressed_content().unwrap_or_else(|_| stream.content.clone());
            let source_name = format!("page-{}-{}.bin", page_index + 1, String::from_utf8_lossy(name));
            assets.push(EmbeddedImageAssetCandidate {
                source_name,
                mime_type: None,
                file_extension: None,
                bytes: bytes.clone(),
                page_index: Some(page_index as i64),
                asset_index: assets.len() as i64,
                anchor_text: None,
                ocr_text: None,
                caption_text: None,
                thumbnail_data_url: build_thumbnail_data_url(&bytes),
            });
        }
    }

    Ok(assets)
}
```

- [ ] **Step 4: Call PDF extraction from the pipeline without touching standalone image/audio behavior**

Modify `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`:

```rust
let doc_assets = match parsed.preview_type.as_str() {
    "docx" => crate::knowledge_embedded_images::extract_docx_embedded_images(&bytes)?,
    "pdf" => crate::knowledge_embedded_images::extract_pdf_embedded_images(&bytes)?,
    _ => Vec::new(),
};
```

Keep this rule intact:

```rust
if parsed.preview_type == "image" {
    // existing standalone image multimodal logic remains unchanged
}

if parsed.preview_type == "audio" {
    // existing standalone audio multimodal logic remains unchanged
}
```

- [ ] **Step 5: Add the final regression test for legacy standalone image/audio behavior**

Add this test in `D:\AI-Coding\omni\src-tauri\src\knowledge_pipeline.rs`:

```rust
#[test]
fn standalone_image_and_audio_paths_do_not_create_document_assets() {
    let connection = test_connection();
    let (collection_id, document_id) = seed_collection_and_document(&connection);

    connection.execute(
        "UPDATE knowledge_documents SET preview_type = 'image', file_extension = 'png' WHERE id = ?1",
        params![document_id],
    ).unwrap();

    let count: i64 = connection.query_row(
        "SELECT COUNT(1) FROM knowledge_document_assets WHERE document_id = ?1",
        params![document_id],
        |row| row.get(0),
    ).unwrap();

    assert_eq!(count, 0);
    let _ = collection_id;
}
```

- [ ] **Step 6: Run the final focused verification**

Run:

- `cargo test --manifest-path src-tauri/Cargo.toml extract_pdf_embedded_images_returns_empty_without_failure -- --exact`
- `cargo test --manifest-path src-tauri/Cargo.toml standalone_image_and_audio_paths_do_not_create_document_assets -- --exact`
- `cargo test --manifest-path src-tauri/Cargo.toml knowledge_pipeline -- --nocapture`
- `npm run build`

Expected:

- focused PDF test PASS
- standalone regression test PASS
- backend knowledge pipeline tests PASS
- frontend build PASS

- [ ] **Step 7: Commit the PDF and regression hardening**

```bash
git add src-tauri/src/knowledge_embedded_images.rs src-tauri/src/knowledge_pipeline.rs
git commit -m "feat: add pdf embedded image extraction"
```

## Self-Review Notes

### Spec coverage

- `knowledge_document_assets` table: Task 1, Task 3, Task 4
- `chunk_type` / `parent_chunk_id` / `image_info`: Task 1, Task 3, Task 5
- `.docx` embedded image extraction: Task 2, Task 3
- `.pdf` embedded image extraction: Task 7
- search rollback to parent text chunk: Task 5
- `Assets` detail tab: Task 6
- cleanup on delete/rebuild: Task 4
- standalone image/audio regression: Task 7

### Placeholder scan

- No `TODO`
- No `TBD`
- No “implement later”
- Every code-changing step contains a concrete code block

### Type consistency

- Rust chunk metadata fields use `chunk_type`, `parent_chunk_id`, `asset_id`, `image_info`
- TypeScript mirrors them as `chunkType`, `parentChunkId`, `assetId`, `imageInfo`
- Search rollback uses `matchedChunk` + `displayChunk`, with `chunk` preserved as the display alias for backward compatibility
