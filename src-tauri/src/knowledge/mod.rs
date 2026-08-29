//! 知识库管线（P0 模块化重构）。
//!
//! 通过 `DocumentParser` / `Chunker` / `Embedder` / `Retriever` / `Repository`
//! 五个 trait 把"格式 / 切分 / 向量化 / 检索 / 存储"解耦为可插拔组件。
//! 新增文档格式或替换 embedding provider 时，只需新增一个实现文件，
//! 不必改动 5000+ 行的单体管线 `knowledge_pipeline.rs`。
//!
//! 设计约定（与既有代码保持一致）：
//! - 错误统一用 `Result<T, String>`，不引入 `thiserror` / `anyhow` 等新依赖。
//! - 所有 trait 均要求 `Send + Sync`，以适配 Tauri 既有的 per-job 线程模型
//!   （`run_pipeline_worker_tick` 中 `std::thread::spawn` 每任务一线程）。
//!
//! 集成方式（详见 `MIGRATION.md`）：
//! 1. 在 `src-tauri/src/lib.rs` 增加一行 `mod knowledge;`
//! 2. 在 `run_pipeline_worker_tick` 的 job 处理中，对文本类文档优先调用
//!    `knowledge::orchestrator::PipelineOrchestrator::with_defaults().process_text(...)`
//! 3. 逐步将 `execute_claimed_job` 的后续步骤迁移到 trait 实现（绞杀者模式）。

// 脚手架阶段：本模块的若干 `pub` 入口（`with_defaults` / `default_*` / `process_text`）
// 尚未被 `lib.rs` 接线，会触发 dead_code 警告；接入编排器后该属性可移除。
#![allow(dead_code)]

pub mod contracts;
pub mod error;
pub mod parsers;
pub mod chunkers;
pub mod embedders;
pub mod retrievers;
pub mod repository;
pub mod orchestrator;
// 编排器入口在接入 `run_pipeline_worker_tick` 前保持内部可达即可：
// `crate::knowledge::orchestrator::PipelineOrchestrator::with_defaults().process_text(...)`
