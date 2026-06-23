# 项目第一阶段优化设计

## 目标

在不改变 Omni 产品行为的前提下，改善项目近期的可维护性和前端性能。

已确认的第一阶段优化聚焦三件事：

- 将过大的 `KnowledgeBaseView.tsx` 拆分为职责清晰、便于测试的 UI 单元
- 对知识库与文档预览相关重代码做懒加载，让默认聊天路径更轻
- 增加最小化前端测试基础，先覆盖高风险纯逻辑和拆分后的视图辅助函数

这一阶段刻意保持保守。目标是降低后续开发摩擦，同时保留当前 Tauri 命令、数据库结构、知识处理 pipeline 行为和用户可见工作流。

## 当前问题

项目当前可以正常构建，但有几处会持续抬高迭代成本：

- `src/components/KnowledgeBaseView.tsx` 约 3.8k 行，混合了承载 collection 导航、文档详情、图片资产检查、任务中心、导入流程、渲染辅助函数和局部 UI 状态。
- `pnpm build` 会提示大 chunk 警告。主应用包里带着知识库与文档预览代码，但默认聊天首屏并不需要这些代码。
- 仓库目前没有前端自动化测试运行器。聊天上下文组合、存储兜底行为、未来拆出的知识库视图辅助函数，主要依赖构建检查和人工使用来兜底。
- 前端中一些有价值的逻辑嵌在大型组件内部，导致不渲染整个页面就很难测试或复用。

## 范围

本阶段包含：

- 从 `KnowledgeBaseView.tsx` 中拆分组件
- 在直接支持组件拆分或测试的地方抽取小型辅助函数
- 对知识库相关页面或重型文档预览依赖做懒加载
- 增加基于 Vitest 的前端测试配置
- 增加一组小而有价值的初始测试
- 构建验证和包体大小对比

本阶段不包含：

- Rust 模块重构
- SQLite schema 修改
- 知识处理 pipeline 行为修改
- 新产品功能
- 视觉重设计，除非为了搬迁代码需要做极小调整
- 模型适配器重写
- Tauri capability 权限收紧
- 完整端到端测试自动化

## 设计方向

采用保持行为不变的拆分，而不是重设计。

优化应让代码更容易理解，但不能迫使用户重新学习产品。现有 CSS class、界面文案、事件流和组件行为应尽量保持不变，除非拆分过程中确实需要极小调整。

第一轮实现应优先追求清晰文件边界，而不是聪明抽象。具有明确产品语义的重复 JSX 应变成命名组件。重复的格式化或选择逻辑，只有在确实复用或值得测试时才抽成纯函数。

## 知识库视图拆分

### 目标文件结构

创建聚焦的知识库组件目录：

```text
src/components/knowledge/
|-- KnowledgeBaseView.tsx
|-- KnowledgeCollectionSidebar.tsx
|-- KnowledgeDocumentList.tsx
|-- KnowledgeDocumentDetail.tsx
|-- KnowledgeAssetInspector.tsx
|-- KnowledgeProcessingPanel.tsx
|-- knowledgeViewHelpers.ts
|-- knowledgeViewTypes.ts
```

现有 `src/components/KnowledgeBaseView.tsx` 在本阶段仍保留为公开 import 路径。它可以变成轻量 re-export 或 wrapper，避免 `App.tsx` 等调用方产生不必要改动。

### 职责划分

`KnowledgeBaseView.tsx` 负责顶层数据加载、Tauri 命令编排和页面组合。

`KnowledgeCollectionSidebar.tsx` 负责 collection 选择、collection 操作和 collection 摘要展示。

`KnowledgeDocumentList.tsx` 负责文档列表渲染、筛选结果展示和文档选择控件。

`KnowledgeDocumentDetail.tsx` 负责选中文档的详情外壳、详情 tab、文档操作按钮和共享详情头部。

`KnowledgeAssetInspector.tsx` 负责嵌入图片资产 tab、选中资产展示、OCR/caption 展示和资产空状态。

`KnowledgeProcessingPanel.tsx` 负责任务中心、失败任务、dead-letter 展示，以及目前嵌在主视图中的任务操作控件。

`knowledgeViewHelpers.ts` 放置纯辅助函数，例如预览类型标签、安全文本截断、文件扩展名处理和小型展示转换，这些逻辑应能脱离 React 测试。

`knowledgeViewTypes.ts` 只放视图局部 prop 类型和辅助类型。共享领域类型继续保留在现有位置。

## 懒加载

### 知识库页面边界

`App.tsx` 中的 `knowledge` 视图应改为懒加载。多数会话以聊天视图作为首屏，因此知识库 UI 代码不应进入初始渲染路径。

期望行为：

- 从聊天切换到知识库时，如果 chunk 还在加载，则在应用壳内展示一个小型加载状态
- 加载完成后，知识库页面行为与现在一致
- 从知识库返回聊天时，不应重置当前聊天状态

### 重型预览依赖

PDF 和 DOCX 预览依赖应在实际需要它们的路径附近动态导入。

本阶段目标依赖：

- `pdfjs-dist`
- `docx-preview`
- `mammoth`，如果它只在导入或预览路径中需要

期望行为：

- 导入或预览受支持文档仍然可用
- 不支持的预览状态保持不变
- 加载失败时，沿用知识库视图现有风格展示用户可理解的错误

## 测试基础

增加 Vitest 作为最小化前端测试运行器。

建议文件：

```text
vitest.config.ts
src/test/setup.ts
src/chat/engine.test.ts
src/app/sqliteStorage.test.ts
src/components/knowledge/knowledgeViewHelpers.test.ts
```

第一组测试保持聚焦：

- 测试从知识库视图抽出的文件类型标签和文本截断辅助函数
- 测试浏览器/Tauri 可用性边界下的存储兜底逻辑，前提是 mock 成本可控
- 只有在不改变运行时行为的前提下安全抽取 token/cost 辅助函数时，才补充聊天引擎相关测试

本阶段不做大范围组件渲染测试。当前 UI 体量大、依赖 Tauri，尚不适合低成本 DOM 测试。组件测试可以等拆分边界稳定后再补。

## 错误处理

拆分必须保留现有错误行为：

- Tauri 命令失败时，继续展示当前错误界面
- 文档导入和重试失败不能被吞掉
- 懒加载失败时，转换为知识库视图已有的局部错误状态模式
- 缺少可选文档预览依赖时，不应导致整个应用壳崩溃

## 性能目标

优化效果应通过可观察的构建输出判断，而不是靠猜测。

实现前后都记录：

- `pnpm build` 输出
- 主应用 JS chunk 大小
- Vite 是否仍提示 chunk 警告

本阶段不要求消除所有警告。一个有价值的第一目标是：知识库与文档预览代码从初始应用 chunk 中移出，进入独立懒加载 chunk。

## 测试与验证

必须执行的验证：

- `pnpm build`
- 在 `src-tauri` 下执行 `cargo check`
- 增加测试运行器后执行 `pnpm test`

人工冒烟检查：

- 以开发模式启动应用
- 打开聊天视图
- 切换到知识库视图
- 选择 collection 和文档
- 打开文档详情 tab
- 在有可用资产时检查嵌入图片资产
- 如果本地有样本文档，导入或预览至少一种受支持文档类型

## 迁移策略

采用小步、保持行为不变的实现顺序：

1. 增加测试工具，并加入一个极小的辅助函数测试
2. 从 `KnowledgeBaseView.tsx` 抽取纯辅助函数
3. 抽取 `KnowledgeAssetInspector`
4. 抽取文档详情外壳
5. 抽取 collection/sidebar/list 部分
6. 抽取 processing panel
7. 懒加载知识库页面
8. 懒加载重型预览依赖
9. 运行构建并对比 chunk 输出

每一步都应保持应用可构建。

## 验收标准

本阶段完成后应满足：

- `src/components/KnowledgeBaseView.tsx` 缩减为顶层组合角色或兼容 wrapper
- 知识库 UI 职责拆分到 `src/components/knowledge/` 下的聚焦文件
- 默认聊天路径不再急切加载完整知识库视图实现
- PDF/DOCX 预览库只在对应功能路径需要时加载
- 项目拥有 Vitest 和一组小而有意义的初始测试
- `pnpm build`、`pnpm test`、`cargo check` 均通过
- 用户可见的知识库工作流行为与当前一致

## 后续阶段

以下优化刻意延后：

- 将 `src-tauri/src/lib.rs` 拆分为 Rust 命令模块
- 将 `src-tauri/src/knowledge_pipeline.rs` 拆分为 pipeline 状态、worker、embedding 和 dead-letter 模块
- 版本化 SQLite 迁移
- Tauri capability 权限收紧
- 更广泛的组件渲染测试
- Playwright 或 Tauri 端到端冒烟测试
