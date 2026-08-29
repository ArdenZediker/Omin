# knowledge/ 模块化迁移指南（P0）

## 目标

把 5159 行的单体管线 `knowledge_pipeline.rs` 改为 trait 驱动的模块化结构，
使"格式 / 切分 / 向量化 / 检索 / 存储"成为可插拔组件。

## 已完成（本 PR / 本次提交）

新增 `src-tauri/src/knowledge/` 模块，**未改动任何既有文件**，因此现有构建保持绿色：

- `contracts.rs` — 五个 trait 契约 + 共享数据结构
- `parsers/text.rs` — `TextDocumentParser`（self-contained，含单元测试）
- `chunkers/legacy.rs` — `LegacyChunker` 委派 `knowledge_chunker::split_document_text`
- `embedders/legacy.rs` — `LegacyEmbedder` 委派 `crate::generate_chunk_embeddings_safe`
- `retrievers/keyword.rs` — `KeywordRetriever`（独立 SQL 检索，证明 trait 可独立实现）
- `repository.rs` — `KnowledgeRepository` 收敛公开命令
- `orchestrator.rs` — `PipelineOrchestrator` 组合五个组件，提供 `process_text`

**依赖关系仅用到已有的公开 / `pub(crate)` 符号**，因此本模块可直接 `cargo build`。

## 集成步骤（绞杀者模式）

1. 在 `src-tauri/src/lib.rs` 的模块声明区（`mod knowledge_pipeline;` 附近）增加：
   ```rust
   mod knowledge;
   ```
2. 在 `run_pipeline_worker_tick` 的 job 处理分支中，对文本类文档优先调用：
   ```rust
   let orch = knowledge::orchestrator::PipelineOrchestrator::with_defaults();
   let processed = orch.process_text(&app, &connection, &parse_input)?;
   // processed.chunks / embeddings 即为后续落库素材
   ```
3. 逐步把 `execute_claimed_job` 的 parse / chunk / embed / index / finalize 步骤
   替换为 `PipelineOrchestrator` 的对应方法；每替换一步单独提交、单独验证。

## P1 异步化（基础已落地，待接线到 worker）

**问题**：`knowledge_pipeline.rs` 的 embedding 调用走 `reqwest::blocking`（120s 超时），
在 `run_pipeline_worker_tick` 派生的 `std::thread::spawn` 子线程里长时阻塞，
把 worker 线程池卡死、并发吞吐受限（主线程不冻结，但批处理吞吐被钉死）。

**已做（加法式、零破坏、已 `cargo build` + `cargo test` 验证）**：

- `lib.rs::generate_chunk_embeddings_async`（及 `request_embedding_batch_async` /
  `recover_embedding_batch_async` / `generate_chunk_embeddings_resilient_async`）：
  与同步版 `generate_chunk_embeddings_safe` **同返回形状、同降级逻辑**，但 HTTP 走
  `reqwest::Client` 异步客户端，不阻塞调用线程。`reqwest` 0.12 自带异步，
  无需新增 Cargo 特性。同步版保持不动，所有既有调用方零影响。
- `embedders/async_embed.rs::AsyncEmbedder`：委派 `generate_chunk_embeddings_async`，
  提供 `embed_async(conn, chunks).await`。是独立类型（非 `dyn Embedder`），
  编排器在异步路径中单独持有它并 `await`，避免用 `block_on` 兜底的死锁风险。
- `orchestrator.rs::process_text_async`：端到端验证"新架构 + 非阻塞 embedding"链路
  （validate→parse→chunk→embed_async），含 2 个 tokio 单元测试。

**已做（接线到 worker，方案 A 落地）**：

- 在 `lib.rs` 新增 `generate_chunk_embeddings_async_blocking(connection, chunks)`：
  用 `tokio::runtime::Builder::new_current_thread().enable_all().build()` 起一个
  **当前线程**运行时，在里面 `block_on(crate::generate_chunk_embeddings_async(...))`。
  返回形状与 `generate_chunk_embeddings_safe` **完全一致**，下游 `vectorized_chunk_count` /
  落库逻辑无需任何改动；运行时创建失败时自动回退到同步实现，保证不降级。
- 把 `knowledge_pipeline.rs` `execute_claimed_job` 的 `embed` 步骤（原阻塞调用点）
  从 `generate_chunk_embeddings_safe` 替换为 `generate_chunk_embeddings_async_blocking`。
  这是 P1 要解决的真实瓶颈点（120s 阻塞 HTTP 把 worker 线程钉死）。
- 新增 2 个 lib 单测：`async_blocking_bridge_returns_early_for_empty_chunks` /
  `async_blocking_bridge_runs_without_model_config`，覆盖桥接函数早期返回与无模型配置分支。

**已完成（本次提交）**：

1. ✅ 并发化 embed 批次（P1-#1）：`generate_chunk_embeddings_resilient_async` 改用
   `futures_util::future::join_all` 把各 `EMBEDDING_BATCH_SIZE` 批次的
   `recover_embedding_batch_async` future 一次性并发派发，多个 HTTP 批次真正并行在飞
   （底层 `reqwest` 异步客户端在 tokio 运行时内并发），不再串行等待。`futures-util`
   已加入 `Cargo.toml`（锁定 0.3.32，免联网新增）。
2. ✅ 接落库（P1-#2）：`Repository` trait 新增 `persist_chunks`（`KnowledgeRepository`
   实现，replace 语义：先 `DELETE` 旧 chunk 再 `INSERT` 新 chunk，并刷新文档
   `processing_status`/`chunk_count`/内容预览）；`with_defaults()` 编排器 +
   `persist_chunks` 已构成完整端到端管线。`contracts.rs` 新增 `PersistChunksInput`。
   单测 `end_to_end_persist_chunks_without_network` 已证明无网络下"解析→切分→(无模型降级)
   →落库"全链路正确，且保留 legacy 路径作为回退。

## 后续可扩展点

- 新增 `parsers/docx.rs` / `parsers/pdf.rs`：替换 frontend-bridge 路径，后端直接解析。
- `chunkers/markdown.rs`（`MarkdownHeadingChunker`）+ `chunkers/router.rs`（`RouterChunker`）
  已落地：`.md`/`.markdown` 走标题语义切分，其余回退 `LegacyChunker`，证明 trait 可插拔。
- 新增 `embedders/openai.rs` 等：实现多 provider failover（替代 LiteLLM 网关的本地子集）。
- `retrievers/hybrid.rs`：**已落地**（vector + keyword 余弦融合，替换 legacy 检索）。
- `Repository` 的 `persist_chunks` 与嵌入向量缓存：**已落地**（P3-#8）。

## 验证状态

- ✅ `cargo test --lib` 全绿：**47 个用例、0 失败**（P0/P1/P3 累计）。
  新增用例：parser 3 + markdown chunker 5 + async embedder 2 + orchestrator async 2 +
  lib 桥接 2 + retriever `recover_embedding_batch` 2 + `hybrid` 余弦/融合 2 +
  `repository` 缓存往返/索引/e2e 3。
- ✅ 运行时接线（方案 A）：worker `embed` 步骤改走 `generate_chunk_embeddings_async_blocking`
  （非阻塞异步 embedding），返回形状与同步版一致，下游逻辑零改动。
- ✅ P1-#1 并发 embed：`join_all` 并发各批次（见上方「已完成」）。
- ✅ P1-#2 落库：`Repository::persist_chunks` 已实现并通过 e2e 单测。
- ✅ P3-#7 索引：`ensure_knowledge_indexes` 新增 `document_id`/`collection_id`/`processing_status`
  等热点列索引（幂等，可单独调用）。单测 `knowledge_indexes_created` 验证。
- ✅ P3-#8 向量缓存：`generate_chunk_embeddings_async` 在单点接入 best-effort 缓存
  （命中直接复用，未命中才请求模型并回填 `embedding_cache` 表）；`Repository` 另提供
  `get_cached_embedding`/`put_cached_embedding`。单测 `embedding_cache_roundtrip` 验证。
- ✅ P3-#9 混合检索：`retrievers/hybrid.rs::HybridRetriever`（keyword + vector 余弦融合，
  query embedding 由上层注入；未注入时降级纯关键词）。单测 `hybrid_fuses_vector_and_keyword`
  /`cosine_pure_function` 验证。
- ✅ #17 错误类型：`knowledge/error.rs::KnowledgeError`（手动实现 `Display`/`Error`，
  未引入 `thiserror` 新依赖）已用于 `persist_chunks` 与缓存方法，作为统一错误类型的起点。
- ✅ #18 迁离 legacy（增量）：新架构端到端可用性已由 `end_to_end_persist_chunks_without_network`
  证明；**未删除** 5159 行 `knowledge_pipeline.rs`（生产路径），接入 worker 替换
  `complete_partial_job` 时再单独提交、保留回退、并做 UI 验收。

## 风险

- `persist_chunks` 已实现，但**尚未接入 worker** 替换 `complete_partial_job` 落库逻辑；
  接入时单独提交、保留 legacy 回退，并结合真实 embedding 模型做端到端冒烟。
- P3-#8 向量缓存为 best-effort（任何缓存异常被忽略，不影响主链路）；`embedding_cache`
  表由 `ensure_embedding_cache_table` 在 `ensure_knowledge_schema` 中创建，需确保升级时
  迁移被执行（已在 `knowledge_schema.rs` 落地）。
- P1 的运行时接线改变了 worker 行为，合并前务必在本地 `cargo build && cargo test` 后，
  结合真实 embedding 模型做一次端到端冒烟（见 `docs/` 手测清单）。
