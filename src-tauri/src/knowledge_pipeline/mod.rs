//! 知识库处理流水线。
//!
//! 原 knowledge_pipeline.rs（5156 行）按职责拆分为以下子模块；
//! 对外（crate 内）的可见性通过下面的 glob 重导出保持与拆分前完全一致。

mod types;
mod schema;
mod connection;
mod helpers;
mod multimodal;
mod import;
mod records;
mod queries;
mod control;
mod embedded_images;
mod worker;

#[cfg(test)]
mod tests;

pub(crate) use types::*;
pub(crate) use schema::*;
pub(crate) use connection::*;
pub(crate) use helpers::*;
pub(crate) use multimodal::*;
pub(crate) use import::*;
pub(crate) use records::*;
pub(crate) use queries::*;
pub(crate) use control::*;
pub(crate) use embedded_images::*;
pub(crate) use worker::*;
