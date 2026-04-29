# Omni - 桌面悬浮 AI 助手

> 基于 Tauri 2、React 19、Vite 7 构建的桌面 AI 助手，支持主窗口聊天、悬浮胶囊入口、全局快捷键与多模型切换。

## 项目状态

当前 `main` 分支是 Tauri 基线，不是 Electron 版本。

目前主线包含的核心能力：

- 主聊天窗口与设置面板
- 悬浮胶囊与 2D 角色模式
- 托盘菜单与全局快捷键唤起
- 多模型切换与多会话聊天
- 常见 AI 平台外部入口

## 技术栈

- 桌面框架：Tauri 2
- 前端框架：React 19
- 构建工具：Vite 7
- 样式方案：Tailwind CSS 4
- 语言：TypeScript 5、Rust
- 包管理：pnpm

## 目录结构

```text
omni/
├─ public/                 # 静态资源
├─ src/                    # React 前端
├─ src-tauri/              # Tauri / Rust 端
├─ index.html
├─ package.json
├─ pnpm-lock.yaml
├─ pnpm-workspace.yaml
├─ tsconfig.json
├─ tsconfig.node.json
└─ vite.config.ts
```

## 环境要求

- Node.js 20+
- pnpm 10+
- Rust stable
- Windows 下已安装 Tauri 所需工具链

## 安装依赖

```bash
pnpm install
```

## 开发

仅启动前端：

```bash
pnpm dev
```

启动 Tauri 桌面应用：

```bash
pnpm tauri dev
```

## 构建

前端构建：

```bash
pnpm build
```

桌面应用构建：

```bash
pnpm tauri build
```

## 当前基线说明

- 当前仓库已经恢复为可构建状态
- `main` 分支依赖 Tauri 相关包
- `dist/` 为前端构建产物
- `src-tauri/` 负责托盘、快捷键和桌面窗口逻辑

## 后续建议

- 如果要继续做 Electron 迁移，建议从当前干净基线重新开分支
- 如果继续维护 Tauri 版本，建议继续做一轮全项目中文文案排查
