# Omni

基于 **Tauri 2 + React 19 + Rust** 构建的本地优先 AI 桌面工作台。

它不只是一个聊天窗口：模型可以直接调用 18 个内置工具读写你的本地文件、搜索代码、查 Git、导出 Office 文档，并在你确认后执行写操作；本地文件可以整理进知识库参与检索问答；界面还能收缩成悬浮窗或桌面宠物常驻桌面。

数据全部存放在本机的 SQLite 里，不依赖任何后端服务。

---

## 核心能力

### 1. 会动手的对话（Function Calling）

模型不是只能"说"，它可以调用工具真的去做事。内置 18 个工具，对所有会话和模型无条件开放：

| 分组 | 工具 | 说明 |
|---|---|---|
| 会话 | `search_sessions` `read_session` | 检索历史会话、读取指定会话内容 |
| 文件 | `list_files` `read_file` `search_files` | glob 列目录、分页读文件（带行号）、正则搜内容 |
| Git | `git_info` `git_commit` `git_pr` | 读 status/log/diff、提交、创建 PR |
| 导出 | `export_docx` `export_xlsx` `export_pptx` `export_md` | 生成 Office / Markdown 文档 |
| 网络 | `web_search` `web_fetch` | 网页搜索、抓取页面正文 |
| 助手 | `read_persona` `update_persona` `install_expert` `install_skill` | 读写助手人设、安装专家与技能 |

几个刻意打磨的细节：

- **`search_files` 是 ripgrep 风格的**：支持正则/字面量/忽略大小写/前后上下文行，自动跳过二进制文件，并尊重 `.gitignore`。
- **`read_file` 会告诉模型预算**：返回结构化元信息 `[file-meta total=N offset=A returned=B lines=S-E truncated=Y/N]`，文件被截断时模型知道还剩多少、该用什么 offset 续读，而不是默默丢内容。
- **读文件带行号**，与 `search_files` 命中的行号同一坐标系，模型给出的引用可以直接点开定位。
- **执行过程可见**：每一次工具调用在时间线上展开，你可以看到它读了哪个文件、搜了什么、产出了什么。

### 2. 本地知识库（RAG）

把本地文档整理成可检索的知识，参与问答：

- 文本、Markdown、代码、`pdf`、`docx` 的导入与解析
- 三种检索模式混用：**hybrid / vector / keyword**
- 完整处理管线：`validate → parse → extract_assets → chunk → embed → index → finalize`
- 失败可重试、可取消、可重新解析/重新向量化，还有 dead-letter 队列与回放
- **多模态**：`docx`/`pdf` 里的嵌入图片会被抽取成资产，图片走 OCR、音频走 caption，作为子 chunk 持久化；命中图片 chunk 时会回滚到父文本 chunk 展示

### 3. 不绑模型

同一套界面接 5 种模型后端，随时切换：

`OpenAI` · `Claude` · `Gemini` · `DeepSeek` · `Ollama`（本地模型）

流式响应、多模态输入、工具调用在各适配器层统一抽象。

### 4. 插件生态：一切皆插件

技能、工具、连接器、专家、模板统一抽象成 `PluginManifest`，由同一个注册表管理：

- **连接器**有两种形态——带 `provider` 的走模型适配器，不带的走 **MCP**（Model Context Protocol），由 Rust 侧拉起 stdio 子进程
- 内置 **SkillHub 市场**，可直接浏览安装社区技能与专家团
- MCP 服务器需**显式信任**才会被拉起，改了启动命令会自动重置信任态

### 5. 桌面形态

- 主窗口、设置窗口、**紧凑悬浮窗**多窗口联动
- **桌面宠物**模式（sprite 图集逐帧动画，含思考气泡/思考窗口）
- 系统托盘 + **全局快捷键**随时唤起
- 无边框透明窗口、窗口圆角与主题同步

### 6. 组织与自动化

- 按**项目**组织会话（而非平铺列表），每个项目可绑定工作目录、工具权限与知识库
- 会话历史搜索、置顶、重命名
- 定时任务与提醒（`ScheduledTask`）
- 助手系统：自定义人设、系统提示词、模型与工具权限，可绑定指定知识库

---

## 架构

### 分层

```text
┌──────────────────────────────────────────────────────────┐
│  前端 UI 层      React 19 · TypeScript · Vite 7          │
│                  Tailwind 4 · Zustand                    │
│  主窗口 / 悬浮窗 / 设置 / 知识库 / 产物 / 变更面板         │
├──────────────────────────────────────────────────────────┤
│  业务层          adapters（模型适配 · function calling）  │
│                  chat（引擎 · 工具 · 任务 · 知识库接入）   │
│                  plugins（技能 / 专家 / 模板 / MCP）      │
├─────────────── Tauri invoke / 事件 ──────────────────────┤
│  原生层 (Rust)   workspace_files（文件 · glob · 搜索）    │
│                  gittools · mcp · webtools · office_export│
│                  knowledge*（解析 · 分块 · 向量 · 检索）  │
│                  tray · global-shortcut · clipboard       │
├──────────────────────────────────────────────────────────┤
│  存储与外联       SQLite (rusqlite) · 本地文件系统         │
│                  远程模型 API · MCP 子进程                 │
└──────────────────────────────────────────────────────────┘
```

**职责边界**：UI 与业务逻辑全在 React/TypeScript，凡涉及文件、Git、数据库、子进程、外网的都下沉到 Rust，两侧只通过 Tauri 的 `invoke` 与事件通信。

### 关键设计

**一切皆插件**
技能、工具、连接器、专家、模板统一为 `PluginManifest`，由 `pluginRegistry` 单例管理。新增能力不需要改核心代码。

**工具循环（Tool Loop）**
`adapters/wireTools.ts` 把工具定义装配成模型的 function calling schema，`chat/engine.ts` 驱动「模型 → 调工具 → 拿结果 → 再问模型」的循环。工具步骤有明确的状态机：`running`（流式进行中）/ `interrupted`（已中断）/ 缺省（正常完成），中断后不会留下悬空的"假完成"步骤。

**三层隔离**
- **项目级**：工作目录、工具白名单、知识库按项目隔离
- **会话级**：消息按会话隔离，运行 ID 防止并发串扰
- **任务级**：每次请求一个 task，写类工具按工作目录串行化，冲突走并发写确认

**安全模型**

| 层级 | 机制 | 说明 |
|---|---|---|
| P0 | 信任门 | MCP 走旁路不经工具白名单，未信任不拉起、不注入、不执行 |
| P1 | 确认门 | 9 个写/安装类工具（`git_commit` `git_pr` `export_*` `update_persona` `install_*`）执行前必须人工确认 |
| P2 | 路径围栏 | 写/导出受 No-Go Zones 与工作区边界约束，越界走确认门，取消则回退工作区内 |

**读取完全放开**——模型拿到绝对路径可以直接读，不需要授权；写入才需要确认。此外对 `~/.ssh`、`~/.aws`、系统凭据文件等敏感路径有默认读取黑名单。

**产出归档**
导出物与会话快照按 `产出根目录/项目/会话` 三级目录落盘；上传的非图片附件会在发送时复制成快照，原文件被移动或删除后仍可读；可选把每场对话镜像成 Markdown 副本（SQLite 仍是主存储）。

---

## 为什么这样设计

**本地优先，数据在自己手里**
单文件 SQLite 存全部数据，没有后端、没有账号、没有云端同步。断网可用（除调用模型 API 外）。

**重活交给 Rust，界面不掉帧**
遍历几万文件、逐行正则匹配、解析 PDF/Office、跑向量检索——这些都在 Rust 侧。文件搜索直接用了 ripgrep 同款底层库（`ignore` + `globset` + `regex`），而不是在 WebView 里用 JS 硬扛。

**读写区别对待，而不是一刀切**
很多助手要么什么都问、要么什么都放行。Omni 的思路是：读取无摩擦（这是助手最常做的事），写入才拦截确认，再用路径围栏兜住最坏情况。既不让确认弹窗淹没你，也不会让模型误删文件。

**能力对模型透明**
工具返回结构化元信息而不是隐式字符串约定——文件被截断会明确告知总量与偏移，搜索结果带行号。模型知道自己"看到了多少"，才不会编造没读到的内容。

**不绑任何模型**
适配器层抽象掉厂商差异，云端模型与本地 Ollama 平权。换模型不需要改任何业务代码。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面运行时 | **Tauri 2**（多窗口、托盘、全局快捷键、protocol-asset）+ opener / shell / dialog / clipboard 官方插件 |
| 前端 | **React 19** · **TypeScript 5.8** · **Vite 7** · **Tailwind CSS 4** · Zustand |
| 渲染增强 | react-markdown + remark-gfm + rehype-sanitize、`@file-viewer`（PDF/Office 内嵌预览）、pdfjs-dist、mammoth、lucide-react、`@tanstack/react-virtual` |
| 原生层 | **Rust**：rusqlite（bundled）、reqwest + tokio、`ignore` + `globset` + `regex`、`zip` / `quick-xml` / `lopdf` / `image`、serde |
| 数据 | **SQLite** |
| 测试 | Vitest（前端，200+ 用例）· Cargo test（Rust，87 用例）· TypeScript 严格模式 |

---

## 目录结构

```text
omni/
├── src/                    # React 前端
│   ├── adapters/           # 模型适配器（OpenAI/Claude/Gemini/DeepSeek/Ollama）+ function calling
│   ├── chat/               # 对话引擎、工具执行、任务、权限、知识库接入
│   ├── plugins/            # 插件注册表、MCP 客户端、SkillHub
│   ├── components/         # 界面组件（聊天、产物、变更、知识库、宠物…）
│   ├── hooks/              # 运行时状态（useChatRuntime、窗口控制等）
│   ├── config/manifests/   # 工具与项目的单一事实来源
│   ├── app/                # 存储、设置、窗口、产出归档
│   └── store/              # Zustand UI 状态
├── src-tauri/              # Rust 原生层
│   ├── workspace_files.rs  # 文件读写、glob 列目录、内容搜索
│   ├── gittools.rs         # Git 只读/提交/PR
│   ├── mcp.rs              # MCP stdio 客户端
│   ├── office_export.rs    # 导出与路径围栏
│   ├── knowledge/          # 知识库：解析、分块、嵌入、检索
│   ├── knowledge_pipeline/ # 摄取管线、任务队列、多模态
│   └── webtools.rs         # 网页搜索与抓取
├── docs/                   # 规格、流程与计划文档
├── scripts/                # 宠物图集等工作流脚本
└── public/                 # 静态资源与宠物资源
```

---

## 快速开始

### 环境要求

- Node.js 20+
- pnpm 10+
- Rust stable
- Windows 需装好 Tauri 依赖的 MSVC 工具链

### 安装

```bash
pnpm install
```

### 运行

```bash
pnpm tauri dev
```

这会同时编译 Rust 后端与前端、拉起桌面窗口，并支持热重载。这是运行应用的**主要命令**。

> 只跑 `pnpm dev` 只会启动 Vite 网页，没有桌面窗口、没有 Tauri 运行时、也没有本地 SQLite，一般只用于纯前端调试。

Vite 开发端口固定为 `1420`，`tauri dev` 复用它作为前端入口。

### 构建

```bash
pnpm build          # 前端
pnpm tauri build    # 桌面应用
```

---

## 知识库能力边界

- 文本、Markdown、代码、`pdf`、`docx` 支持导入解析
- 图片和音频需在对应知识库开启并配置多模态模型后再上传
- 当前版本不支持视频上传

RAG 内部流程见 [docs/rag-flow.md](docs/rag-flow.md)。

---

## 宠物资源脚本

宠物图集（sprite atlas）相关工作流：

```bash
pnpm pet:v2:plan
pnpm pet:v2:normalize
pnpm pet:v2:compose
pnpm pet:v3:plan
pnpm pet:v3:normalize
pnpm pet:v3:compose
```

脚本会操作 `output/` 下的生成资源。

---

## 相关文档

- [docs/rag-flow.md](docs/rag-flow.md) — 知识库 RAG 流程
- [docs/manual-smoke-checklist.md](docs/manual-smoke-checklist.md) — 手工冒烟清单
- [docs/dependency-risk-audit.md](docs/dependency-risk-audit.md) — 依赖风险审计
- [docs/roadmap](docs/roadmap) — 路线图
- [docs/pet-v2-workflow.md](docs/pet-v2-workflow.md) — 宠物资源工作流
