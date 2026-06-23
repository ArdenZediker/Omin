# 项目第一阶段优化实施计划

> **给 agentic workers 的要求：** 实施本计划时逐项推进，步骤使用复选框记录。每个任务完成后都运行对应验证命令，避免把多个风险点混在一起。

**目标：** 在保持现有产品行为不变的前提下，降低知识库前端代码维护成本，减小默认聊天路径的初始加载负担，并建立最小前端测试基础。

**架构：** 第一阶段采用保守拆分：先抽取纯辅助函数和测试，再拆出知识库局部组件，最后通过 React 懒加载和动态 import 将重型依赖移出初始包。现有 `src/components/KnowledgeBaseView.tsx` 保留为公开入口，避免调用方大面积 churn。

**技术栈：** React 19、TypeScript、Vite 7、Vitest、Tauri 2、Rust/cargo。

---

## 文件结构

计划新增或修改的文件：

- 修改：`package.json`，增加 `test` 脚本和 Vitest 依赖。
- 修改：`pnpm-lock.yaml`，随依赖安装更新。
- 新增：`vitest.config.ts`，配置前端测试运行器。
- 新增：`src/test/setup.ts`，放测试环境基础设置。
- 新增：`src/components/knowledge/knowledgeViewHelpers.ts`，承载从知识库视图抽出的纯辅助函数。
- 新增：`src/components/knowledge/knowledgeViewHelpers.test.ts`，覆盖文件扩展名、预览类型、标签、文本截断等稳定逻辑。
- 新增或后续修改：`src/components/knowledge/KnowledgeAssetInspector.tsx`，承载图片资产详情区域。
- 修改：`src/components/KnowledgeBaseView.tsx`，改为引用抽取出的辅助函数和局部组件，并移除顶层重型预览依赖。
- 修改：`src/App.tsx`，将知识库视图改为懒加载。

## 任务 1：增加测试基础

- [ ] **步骤 1：安装测试依赖**

运行：

```powershell
pnpm add -D vitest jsdom @testing-library/react @testing-library/jest-dom
```

预期：`package.json` 和 `pnpm-lock.yaml` 更新。

- [ ] **步骤 2：增加测试脚本**

在 `package.json` 的 `scripts` 中加入：

```json
"test": "vitest run"
```

预期：`pnpm test` 可以调用 Vitest。

- [ ] **步骤 3：创建 `vitest.config.ts`**

配置应复用 React 插件并使用 `jsdom` 环境：

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
  },
});
```

- [ ] **步骤 4：创建测试 setup**

`src/test/setup.ts` 内容：

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **步骤 5：运行空测试验证**

运行：

```powershell
pnpm test -- --passWithNoTests
```

预期：Vitest 正常启动。

## 任务 2：抽取知识库纯辅助函数

- [ ] **步骤 1：创建 `knowledgeViewHelpers.ts`**

抽取并导出以下纯函数和常量：

- `getExtension`
- `getPreviewKindFromFileName`
- `getPreviewKindFromDocument`
- `getDocumentTypeLabel`
- `getVectorizationLabel`
- `getProcessingStatusLabel`
- `trimContentPreview`
- `splitPreviewLines`

- [ ] **步骤 2：更新 `KnowledgeBaseView.tsx` 引用**

从 `src/components/knowledge/knowledgeViewHelpers.ts` 引入这些函数，删除原文件中的重复定义。

- [ ] **步骤 3：新增辅助函数测试**

创建 `src/components/knowledge/knowledgeViewHelpers.test.ts`，覆盖：

- 大小写混合扩展名能被识别
- PDF/DOCX/图片/音频/视频/文本预览类型识别正确
- 未知类型返回 `unsupported`
- 文档类型标签输出中文标签
- 空 processing/vectorization 状态有稳定兜底
- 长文本截断不会超过预期长度

- [ ] **步骤 4：运行测试**

运行：

```powershell
pnpm test
```

预期：测试通过。

## 任务 3：懒加载重型文档预览依赖

- [ ] **步骤 1：移除顶层运行时导入**

从 `KnowledgeBaseView.tsx` 移除这些顶层运行时导入：

```ts
import mammoth from "mammoth/mammoth.browser";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
```

保留必要的 type-only import。

- [ ] **步骤 2：在 DOCX 解析路径动态导入 mammoth**

在实际需要 `extractRawText` 的函数内使用：

```ts
const { default: mammoth } = await import("mammoth/mammoth.browser");
```

- [ ] **步骤 3：在 PDF 预览路径动态导入 pdfjs**

在 PDF 预览组件或函数内使用：

```ts
const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
  import("pdfjs-dist"),
  import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
]);
GlobalWorkerOptions.workerSrc = workerModule.default;
```

- [ ] **步骤 4：运行构建验证**

运行：

```powershell
pnpm build
```

预期：构建通过，PDF worker 仍被正确输出为独立资源。

## 任务 4：懒加载知识库页面

- [ ] **步骤 1：修改 `App.tsx`**

使用 `lazy` 和 `Suspense` 懒加载知识库页面：

```ts
const KnowledgeBaseView = lazy(() => import("./components/KnowledgeBaseView"));
```

渲染知识库视图时包裹：

```tsx
<Suspense fallback={<div className="omni-view-loading">正在打开知识库...</div>}>
  <KnowledgeBaseView ... />
</Suspense>
```

- [ ] **步骤 2：补充轻量加载样式**

如果没有可复用 loading class，在 `src/App.css` 中增加简洁样式，避免懒加载期间出现空白。

- [ ] **步骤 3：运行构建并记录 chunk**

运行：

```powershell
pnpm build
```

预期：构建通过，知识库相关代码进入独立 chunk 或主 chunk 体积下降。

## 任务 5：抽取图片资产检查组件

- [ ] **步骤 1：定位资产 JSX**

在 `KnowledgeBaseView.tsx` 中定位 `detailView === "assets"` 分支和 `selectedAsset` 相关渲染。

- [ ] **步骤 2：创建 `KnowledgeAssetInspector.tsx`**

将资产列表、选中资产预览、OCR/caption 区域搬入新组件，props 明确传入：

- `assets`
- `selectedAssetId`
- `selectedAsset`
- `onSelectAsset`

- [ ] **步骤 3：保持 class 和文案不变**

保留原有 CSS class 和中文文案，避免本阶段变成视觉重设计。

- [ ] **步骤 4：运行构建**

运行：

```powershell
pnpm build
```

预期：构建通过，资产 tab 行为不变。

## 任务 6：最终验证

- [ ] **步骤 1：运行前端测试**

```powershell
pnpm test
```

预期：全部测试通过。

- [ ] **步骤 2：运行前端构建**

```powershell
pnpm build
```

预期：TypeScript 和 Vite 构建通过。

- [ ] **步骤 3：运行 Rust 检查**

```powershell
cargo check
```

工作目录：`src-tauri`

预期：Rust 检查通过。

- [ ] **步骤 4：检查 git 状态**

```powershell
git status --short
```

预期：只包含本次优化相关文件。

## 自审清单

- 所有新增文档和说明使用中文。
- 没有引入用户可见行为变化。
- 没有改动 Rust pipeline 或 SQLite schema。
- 懒加载失败有可理解的 fallback。
- 所有新增测试都能在 `pnpm test` 中运行。
- `pnpm build` 和 `cargo check` 均通过。
