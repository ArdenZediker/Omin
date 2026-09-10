// 文件差异结构（与 Rust office_export.rs::DiffResult 对齐）。
// diff 由后端 Rust `similar` 在写文件前读基线、内存算出 unified-diff 后随命令返回，
// 前端只消费、不计算（避免前端拿不到原始文件内容）。
export interface FileDiff {
  /** 文件名（仅用于展示，不含路径） */
  filename: string;
  /** 新增行数 */
  insertions: number;
  /** 删除行数 */
  deletions: number;
  /** 标准 unified-diff 文本（兼容 git diff 格式，头部 `--- a/`、`+++ b/`） */
  diffContent: string;
}

