# Omni

Omni 是一个基于 Tauri 2 构建的桌面 AI 工作台，把主聊天窗口、助手管理、本地知识库、悬浮形态和桌面宠物整合在同一套应用里。

当前仓库维护的是正在持续演进的 Tauri 版本，不再是 Electron 迁移分支，也不是只有基础壳层的最小原型。

## 项目定位

Omni 现在更像一个桌面 AI 工作台，而不是单一聊天窗口。它关注的是：

- 在本地桌面环境里组织多话题对话
- 为不同任务配置不同助手、模型和能力边界
- 把本地文件整理进知识库并参与检索问答
- 提供悬浮窗、宠物和快捷入口，减少切换成本

## 当前能力

### 聊天工作台

- 多会话聊天与话题历史管理
- 助手切换、会话搜索、置顶和重命名
- 本地 slash 命令、内置技能入口和任务侧栏
- 主窗口、设置窗口、紧凑窗口之间的联动

### 助手系统

- 内置推荐助手预设
- 自定义助手标题、描述、系统提示词和头像
- 助手级模型、工具权限、记忆范围配置
- 助手与指定知识库的可选绑定

### 本地知识库

- 知识库 collection 管理
- 文档上传、原文预览、chunk 结果查看
- 文档处理状态、任务中心和失败回放
- `图片资产` 详情页，用于浏览嵌入图片、OCR 和图片描述

### 知识处理 Pipeline

- 本地任务队列
- `validate`、`parse`、`extract_assets`、`chunk`、`embed`、`index`、`finalize` 流程
- 重试、取消、重新解析、重新向量化
- embedding 失败时的降级和恢复逻辑
- dead-letter 处理与回放能力

### 多模态与嵌入图片

- 知识库图片 / 音频多模态模型配置
- `docx` / `pdf` 嵌入图片资产抽取
- 图片 OCR / caption 子 chunk 持久化
- 命中嵌入图片时回滚到父文本 chunk 展示

### 悬浮与宠物

- 紧凑悬浮窗口
- 桌面宠物模式
- 宠物思考气泡 / 思考窗口
- 托盘图标与全局快捷键唤起

### 设置与模型管理

- 聊天模型配置
- 知识库 embedding 模型配置
- 知识库多模态模型配置
- 主题、窗口行为、悬浮球和宠物相关设置

## 技术栈

- 桌面运行时：Tauri 2
- 前端：React 19 + TypeScript
- 构建工具：Vite 7
- 样式：Tailwind CSS 4 + 项目内共享 CSS
- 后端：Rust
- 本地数据层：SQLite + rusqlite
- 包管理：pnpm

## 目录结构

```text
omni/
|-- public/                  # 静态资源与宠物资源
|-- src/                     # React 前端、聊天界面、知识库界面、设置与悬浮交互
|-- src-tauri/               # Tauri 应用、Rust 命令、托盘/快捷键、知识库 pipeline
|-- docs/                    # 规格说明、计划文档、RAG 流程文档
|-- scripts/                 # 本地辅助脚本，主要用于宠物资源工作流
|-- output/                  # 生成产物与本地流程输出
|-- package.json
|-- vite.config.ts
|-- README.md
```

## 环境要求

- Node.js 20+
- pnpm 10+
- Rust stable
- Windows 环境下已安装 Tauri 所需工具链

## 安装依赖

```bash
pnpm install
```

## 开发

仅启动前端：

```bash
pnpm dev
```

启动桌面应用：

```bash
pnpm tauri dev
```

说明：

- Vite 开发端口固定为 `1420`
- `tauri dev` 会复用该端口作为前端入口

## 构建

前端构建：

```bash
pnpm build
```

桌面应用构建：

```bash
pnpm tauri build
```

## 知识库能力边界

当前知识库更适合本地文档整理和检索增强问答，上传与处理边界如下：

- 文本、Markdown、代码、`pdf`、`docx` 支持基础导入与解析
- 图片和音频文件需要在对应知识库开启并配置多模态模型后再上传
- 当前版本不支持视频上传到知识库

如果你想了解当前实现里的 RAG 流程，可以继续阅读 [docs/rag-flow.md](docs/rag-flow.md)。

## 宠物资源脚本

仓库内置了宠物 atlas 相关脚本：

```bash
pnpm pet:v2:plan
pnpm pet:v2:normalize
pnpm pet:v2:compose
pnpm pet:v3:plan
pnpm pet:v3:normalize
pnpm pet:v3:compose
```

这些脚本会操作 `output/` 下的生成资源。

## 当前状态

当前 `main` 分支已经包含：

- 可运行的 Tauri 桌面应用骨架
- 主聊天工作台与助手体系
- 本地知识库、处理 pipeline 与多模态配置
- 嵌入图片资产持久化与详情页浏览
- 紧凑窗口、宠物模式与相关设置面板
