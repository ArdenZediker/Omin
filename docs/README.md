# 文档索引

| 文档 | 用途 | 状态 |
|---|---|---|
| [HANDOVER.md](HANDOVER.md) | 当前实现、验证记录和接手提示 | 持续更新 |
| [planning/IMPL_macos-build-verification-desktop-completion.md](planning/IMPL_macos-build-verification-desktop-completion.md) | 桌面版八项收尾计划与逐项验收 | 已评审，实施中 |
| [manual-smoke-checklist.md](manual-smoke-checklist.md) | 原生桌面交互验收 | 待本轮复核 |
| [testing/TestCase-macos-build-verification-desktop-completion.md](testing/TestCase-macos-build-verification-desktop-completion.md) | 桌面版收尾验收用例与 C1–C8/T02–T12 覆盖映射 | 已建立，待终审执行 |
| [testing/TestReport-macos-build-verification-desktop-completion.md](testing/TestReport-macos-build-verification-desktop-completion.md) | 桌面版收尾亲验收报告骨架 | DRAFT，待独立复跑和原生验收 |
| [rag-flow.md](rag-flow.md) | 知识入库和检索流程 | 参考 |

### 技术调研

| 文档 | 用途 | 状态 |
|---|---|---|
| [research/macos-build-verification-悬浮球窗口框架调研.md](research/macos-build-verification-悬浮球窗口框架调研.md) | **技术调研**：比较 GitHub 上 Tauri、Electron、Qt/PyQt、WPF、Win32/Rust 的悬浮窗模式，并对比 Omni 当前架构 | 调研稿（2026-11-08，含方案建议） |
| [research/macos-build-verification-Tauri透明窗口浮层菜单闪烁.md](research/macos-build-verification-Tauri透明窗口浮层菜单闪烁.md) | **技术调研**：分析 Tauri/WebView2 透明窗口的几何与首帧时序风险，提供 instrumentation、固定宿主和独立 popup 的 A/B 决策门 | 调研稿（2026-11-08，静态分析；未做运行时验证） |
