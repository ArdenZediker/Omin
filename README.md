# Omni - 多模态 AI 悬浮助手

> 一个跨平台桌面悬浮 AI 助手，支持多服务商、多模型、多模态（文本+图片），通过全局快捷键随时唤起。

## 项目概述

Omni 是一款轻量级桌面悬浮窗 AI 助手，基于 Tauri 2 + React 19 构建。它以透明无边框悬浮窗的形式常驻桌面，用户通过 `Alt+Space` 全局快捷键随时唤起或隐藏，不干扰任何正在使用的工作流。

### 核心特性

- **多模型统一接入** — 支持 OpenAI、Anthropic Claude、Google Gemini、DeepSeek、Ollama 五大服务商
- **多模态对话** — 支持纯文本及图片粘贴输入（Vision 模型）
- **流式响应** — 所有模型均支持 SSE 流式输出，实时逐字渲染
- **全局快捷键** — `Alt+Space` 一键唤起/隐藏，跨应用全局生效
- **悬浮窗设计** — 透明毛玻璃背景、无边框、置顶、不占任务栏
- **本地配置持久化** — API Key 和服务商配置保存在 localStorage，无需后端

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| 桌面框架 | Tauri | 2.x |
| 前端框架 | React | 19.1 |
| 构建工具 | Vite | 7.x |
| 样式方案 | TailwindCSS | 4.x |
| 语言 | TypeScript | 5.8 |
| 后端语言 | Rust | 1.95 (stable-msvc) |
| 包管理 | pnpm | - |

## 项目结构

```
omni/
├── index.html                  # 入口 HTML（透明背景）
├── package.json                # 前端依赖和脚本
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── vite.config.ts              # Vite 配置（Tauri 集成）
├── tsconfig.json
├── tsconfig.node.json
├── public/
├── src/                        # 前端源码
│   ├── main.tsx                # React 入口
│   ├── App.tsx                 # 主应用组件（聊天/设置视图切换）
│   ├── App.css                 # 全局样式（Tailwind + 自定义）
│   ├── adapters/               # AI 适配器层（核心架构）
│   │   ├── types.ts            # 统一接口定义 + 内置模型列表
│   │   ├── registry.ts         # 模型注册中心（单例）
│   │   ├── openai.ts           # OpenAI 适配器
│   │   ├── claude.ts           # Anthropic Claude 适配器
│   │   ├── gemini.ts           # Google Gemini 适配器
│   │   ├── deepseek.ts         # DeepSeek 适配器
│   │   └── ollama.ts           # Ollama 本地模型适配器
│   └── components/             # UI 组件
│       ├── TitleBar.tsx        # 标题栏（拖拽 + 隐藏到托盘）
│       ├── ModelSelector.tsx   # 模型选择下拉框
│       ├── ChatMessage.tsx     # 消息气泡 + Markdown 渲染
│       ├── ChatInput.tsx       # 输入框 + 图片粘贴
│       └── SettingsPanel.tsx   # 服务商设置面板
└── src-tauri/                  # Rust 后端
    ├── Cargo.toml              # Rust 依赖
    ├── Cargo.lock
    ├── build.rs                # Tauri 构建脚本
    ├── tauri.conf.json         # Tauri 窗口/打包配置
    ├── capabilities/
    │   └── default.json        # Tauri 权限配置
    ├── .cargo/
    │   └── config.toml         # Cargo 镜像源配置（项目级）
    ├── src/
    │   ├── main.rs             # Rust 入口（Windows 控制台隐藏）
    │   └── lib.rs              # Tauri 应用主逻辑
    ├── icons/                  # 应用图标
    ├── gen/                    # Tauri 自动生成的代码
    └── target/                 # 编译输出
```

## 架构设计

### 适配器模式（Adapter Pattern）

项目核心架构采用适配器模式，将不同 AI 服务商的 API 差异封装在各自适配器中，上层代码通过统一接口交互。

```
┌──────────────┐
│   App.tsx    │  ← 主应用，视图管理、消息流
└──────┬───────┘
       │
┌──────▼───────┐
│  ModelRegistry  │  ← 单例注册中心，管理适配器实例
└──────┬───────┘
       │
  ┌────┼────┬────┬────┐
  │    │    │    │    │
┌─▼─┐┌─▼─┐┌▼──┐┌▼──┐┌▼───┐
│OAI││CLD││GEM││DSK││OLM │
│   ││   ││   ││   ││    │
└───┘└───┘└───┘└───┘└────┘
OpenAI Claude Gemini DeepSeek Ollama
```

**统一接口 `ModelAdapter`：**

```typescript
interface ModelAdapter {
  readonly provider: string;
  readonly models: ModelConfig[];
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse>;
  validate(): Promise<boolean>;
}
```

**数据流：**

1. 用户在 `ChatInput` 输入消息（可选粘贴图片）
2. `App.tsx` 构造 `Message`，通过 `modelRegistry.chatStream()` 发送
3. `ModelRegistry` 根据当前模型 ID 查找对应适配器
4. 适配器将统一请求格式转换为目标 API 格式
5. 流式响应通过 `onChunk` 回调逐字更新 UI

### 关键设计决策

| 决策 | 说明 |
|------|------|
| 适配器模式 | 解耦服务商差异，新增服务商只需实现 `ModelAdapter` 接口 |
| 单例 Registry | 全局唯一，管理适配器生命周期和模型路由 |
| localStorage 持久化 | 无需后端，API Key 存储在客户端本地 |
| SSE 流式输出 | 所有适配器均支持 `chatStream`，实时渲染体验 |
| CSP 设为 null | 允许前端直接请求任意 AI API 端点 |

## 支持的 AI 模型

| 服务商 | 模型 | 视觉 | 最大上下文 |
|--------|------|------|-----------|
| OpenAI | GPT-4o | ✅ | 128K |
| OpenAI | GPT-4o Mini | ✅ | 128K |
| OpenAI | o1 | ✅ | 200K |
| OpenAI | o3 Mini | ❌ | 200K |
| Anthropic | Claude Sonnet 4 | ✅ | 200K |
| Anthropic | Claude Opus 4 | ✅ | 200K |
| Google | Gemini 2.5 Pro | ✅ | 1M |
| Google | Gemini 2.5 Flash | ✅ | 1M |
| DeepSeek | DeepSeek V3 | ❌ | 64K |
| DeepSeek | DeepSeek R1 | ❌ | 64K |
| Ollama | Llama 3 (本地) | ❌ | 8K |
| Ollama | LLaVA (本地) | ✅ | 4K |

## Rust 后端

### 插件配置

| 插件 | 用途 |
|------|------|
| `tauri-plugin-opener` | 打开外部链接/文件 |
| `tauri-plugin-clipboard-manager` | 系统剪贴板读写 |
| `tauri-plugin-shell` | 调用系统 Shell |
| `tauri-plugin-global-shortcut` | 全局快捷键（Alt+Space） |

### 全局快捷键逻辑

```rust
// Alt+Space 按下时：
//   - 如果窗口可见 → 隐藏
//   - 如果窗口隐藏 → 显示并聚焦
```

### Tauri 权限（capabilities）

```json
{
  "permissions": [
    "core:default",
    "core:window:allow-show",
    "core:window:allow-hide",
    "core:window:allow-close",
    "core:window:allow-set-focus",
    "core:window:allow-set-always-on-top",
    "core:window:allow-start-dragging",
    "global-shortcut:allow-register",
    "clipboard-manager:allow-read-text",
    "clipboard-manager:allow-write-text",
    "shell:allow-open"
  ]
}
```

### 窗口配置

```json
{
  "width": 420,
  "height": 560,
  "minWidth": 360,
  "minHeight": 400,
  "decorations": false,      // 无边框
  "transparent": true,       // 透明背景
  "alwaysOnTop": true,       // 置顶
  "skipTaskbar": true,       // 不显示任务栏
  "resizable": true
}
```

## 开发环境配置

### 前置要求

- **Node.js** >= 18
- **pnpm**（推荐最新版）
- **Rust** stable（通过 rustup 安装）
- **Windows**: MSVC 构建工具（Visual Studio Build Tools）

### 安装依赖

```bash
# 前端依赖
cd omni
pnpm install

# Rust 依赖（cargo check 时自动拉取）
cd src-tauri
cargo check
```

### 开发运行

```bash
# 在项目根目录执行
pnpm tauri dev
```

这将同时启动：
1. Vite 开发服务器（前端 HMR，端口 1420）
2. Tauri 应用（Rust 编译 + WebView 窗口）

### 生产构建

```bash
pnpm tauri build
```

输出安装包位于 `src-tauri/target/release/bundle/`。

### 国内镜像配置

Rust 依赖下载使用 rsproxy.cn 镜像（项目级 `.cargo/config.toml` 已配置）：

```toml
[source.crates-io]
replace-with = "rsproxy-sparse"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[registry]
protocol = "sparse"

[net]
git-fetch-with-cli = true
```

Rustup 工具链更新使用环境变量：

```powershell
$env:RUSTUP_DIST_SERVER = "https://rsproxy.cn"
$env:RUSTUP_UPDATE_ROOT = "https://rsproxy.cn/rustup"
```

## 使用指南

### 首次使用

1. 启动应用后，点击「配置 AI 服务商」按钮
2. 选择一个服务商（如 OpenAI）
3. 输入 API Key，可选填自定义 Base URL（支持代理/兼容接口）
4. 点击「保存并验证」
5. 验证成功后即可开始对话

### 日常使用

- **唤起/隐藏**：`Alt+Space`
- **发送消息**：`Enter`
- **换行**：`Shift+Enter`
- **粘贴图片**：直接 `Ctrl+V` 粘贴（需选择支持视觉的模型）
- **切换模型**：点击顶部模型名称下拉选择
- **清空对话**：点击聊天区工具栏垃圾桶图标
- **隐藏窗口**：点击标题栏最小化按钮（隐藏到托盘）

## 新增服务商指南

1. 在 `src/adapters/` 下创建新文件，如 `mistral.ts`
2. 实现 `ModelAdapter` 接口：

```typescript
import type { ModelAdapter, ModelConfig, ChatRequest, ChatResponse, StreamChunk, ProviderConfig } from "./types";

const MISTRAL_MODELS: ModelConfig[] = [
  { id: "mistral-large", name: "Mistral Large", provider: "mistral", maxTokens: 128000, supportsVision: false, supportsStreaming: true },
];

export class MistralAdapter implements ModelAdapter {
  readonly provider = "mistral";
  readonly models = MISTRAL_MODELS;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) { this.config = config; }

  async chat(request: ChatRequest): Promise<ChatResponse> { /* ... */ }
  async chatStream(request: ChatRequest, onChunk: (chunk: StreamChunk) => void): Promise<ChatResponse> { /* ... */ }
  async validate(): Promise<boolean> { /* ... */ }
}
```

3. 在 `src/adapters/types.ts` 的 `BUILTIN_MODELS` 数组中添加模型定义
4. 在 `src/adapters/registry.ts` 中注册适配器：

```typescript
import { MistralAdapter } from "./mistral";

const ADAPTER_MAP: Record<string, AdapterConstructor> = {
  // ...existing
  mistral: MistralAdapter,
};
```

5. 在 `src/components/SettingsPanel.tsx` 中添加服务商展示信息：

```typescript
const PROVIDER_NAMES = { /* ... */ mistral: "Mistral AI" };
const PROVIDER_DESC = { /* ... */ mistral: "Mistral Large, Medium" };
const DEFAULT_BASE_URLS = { /* ... */ mistral: "https://api.mistral.ai/v1" };
```

## 注意事项

- **API Key 安全**：密钥存储在浏览器 localStorage，仅限本机使用
- **CSP 策略**：当前设为 `null`（允许所有外部请求），生产环境建议收紧
- **Rust 不需要虚拟环境**：Cargo 的 `Cargo.lock` + 项目级 `target/` 已保证依赖隔离
- **Windows 编译**：需要 MSVC 工具链（默认已安装），不需要 GNU 工具链
