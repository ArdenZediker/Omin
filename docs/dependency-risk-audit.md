# 项目依赖与风险清单

## 1. 技术栈与依赖结构

> 清单核对时间：2026-09-05，与 `package.json` / `src-tauri/Cargo.toml` 对齐。

前端（运行时）：
- React 19.1 / react-dom
- TypeScript 5.8（严格模式）
- Vite 7 + `@vitejs/plugin-react`
- Tailwind CSS 4（`@tailwindcss/vite` 插件）
- Zustand 5（仅 `src/store/uiStore.ts` 一处）
- `@tauri-apps/api` 2
- react-markdown 10 + remark-gfm + rehype-sanitize（Markdown 渲染，带 sanitize）
- `@file-viewer/react` 3 + `@file-viewer/preset-office` 3（PDF / Office 内嵌预览，懒加载约 7.7MB）
- `pdfjs-dist` 5（知识库摄取链路在用）
- `mammoth`（docx 转 HTML）
- lucide-react、`@lobehub/icons-static-svg`（图标）
- `@tanstack/react-virtual`（长列表虚拟滚动）
- `@fontsource-variable/noto-sans-sc`（PDF CJK 字体兜底，构建期必需）

前端（开发时）：
- Vitest 4 + jsdom + Testing Library（207 个用例）
- `@tauri-apps/cli` 2、`iconv-lite`

桌面端：
- Tauri 2（features：`protocol-asset`、`tray-icon`）
- tauri-plugin-opener / global-shortcut / clipboard-manager / shell / **dialog**

Rust 侧：
- serde / serde_json
- reqwest 0.12（blocking / json / multipart / stream）
- tokio 1（full）+ futures-util
- rusqlite 0.32（bundled）
- **regex 1 / ignore 0.4 / globset 0.4**（文件 glob 与内容搜索，ripgrep 同款底层库）
- **zip 2.2 / quick-xml 0.37 / lopdf 0.35 / image 0.25**（Office 与 PDF 解析、图像处理）
- sha2 0.10 / base64 0.22 / uuid 1

存储：
- SQLite（rusqlite bundled）为主存储
- **localStorage 是前端读取缓存，且会明文镜像敏感数据**（详见第 3 节第 1 条）

## 2. 审计结果说明

本次没有拿到完整在线漏洞库审计结果，原因如下：
- `pnpm audit` 受当前镜像源限制，审计接口不可用
- `cargo audit` 当前环境未安装

因此本结论不等于“零漏洞”，而是“未完成官方漏洞数据库核验”。

## 3. 已确认风险

### 高优先级

1. Provider API Key 明文落地（风险仍未消除）
- 配置的持久化写入走 `saveAppKvEntry` → `invoke("save_app_kv")` 落 SQLite（`adapters/registry.ts:223` 的 `omni_provider_configs`，内容含 `apiKey`），该写入路径本身不写 localStorage
- 但每次启动 `bootstrapSqliteStorage` 的 key 列表包含 `"omni_provider_configs"`（`useMainWindowController.ts:96`），它会从 SQLite 读回该值并 `localStorage.setItem` 写回（`sqliteStorage.ts:52`）
- 因此 localStorage 仍持有明文 API Key 副本，并在每次启动时被刷新（可能滞后于最近一次保存，但密钥本身始终在）
- 本机可直接读取该明文密钥：原文档“已改造为仅 SQLite、不再依赖 localStorage 副本”并不准确——localStorage 副本由 bootstrap 维持，风险未消除

2. 桌面窗口状态链路复杂
- `main` / `compact` 的显示、隐藏、焦点、悬浮菜单、自动关闭之间存在多条状态链
- 风险是桌面入口不稳定，出现窗口不可见、菜单打不开等行为
- 这是当前项目最大的稳定性风险

### 中优先级

3. 工作区文件读取能力较强
- 前端可通过 Tauri command 调用：
  - `list_workspace_files`
  - `read_workspace_file`
  - `search_workspace_files`
- 当前 Rust 侧已做相对路径归一化与工作区约束
- 但从能力边界看，仍属于高权限桌面应用，应避免未来无边界自动执行

4. localStorage 历史兜底仍保留较多状态
- 包括聊天、记忆、自动化、窗口状态等，以及经 bootstrap 回写的 `omni_provider_configs` 明文 API Key（见第 3.1 条）
- 风险是数据多副本、调试困难、敏感信息残留

### 低优先级

5. 文案与 README 存在编码问题
- 不属于安全漏洞
- 但会影响维护、交接和审计判断

## 4. 已确认的安全正向项

- 未发现 `dangerouslySetInnerHTML`
- 未发现前端直接 `eval`
- 未发现 Rust 侧任意系统命令执行
- 文件读取命令具备工作区路径限制
- Tauri capability 虽然较宽，但大体与当前功能匹配

## 5. 建议处理顺序

1. 完成 Provider API Key 去 localStorage 化
2. 收敛 `main/compact` 窗口状态机
3. 为文件读取类工具增加更清晰的权限与开关边界
4. 清理历史兼容逻辑与乱码文案
5. 切回官方 registry 后重新执行 `pnpm audit`
6. 安装 `cargo-audit` 后补 Rust 依赖审计

