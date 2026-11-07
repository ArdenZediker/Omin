# Omni 项目交接文档

> 更新：2026-10-26 ｜ 依据：工作区实况（不是设计愿景）
> 本文档只写**代码里能取证的事**与**接手后一定会遇到的坑**。功能清单见 `README.md`。

---

## 0. 三十秒版

| 问题 | 答案 |
|---|---|
| 这是什么 | Tauri 2 + React 19 + Rust 的本地优先 AI 桌面工作台，数据位于本机 SQLite、会话 JSONL 与文件目录 |
| 现在能跑吗 | Windows：能（dev / build / 打包都验证过） |
| 能打 Mac 包吗 | **代码已完成 macOS 双架构适配**；Intel/Apple Silicon 的 DMG 由 `.github/workflows/macos-build.yml` 在 macOS runner 实构 |
| 测试能跑吗 | 能：2026-10-26 前端 78 文件、825 用例通过，Rust 166 passed、1 项忽略，见 §6.4 |
| 工作区干净吗 | **不干净**，多个主题的未提交改动并存，见 §7。**先看 §7 再动手** |
| 最该先做什么 | 先完成计划中剩余实机验收，再逐主题整理 §7 的改动 |

---

## 1. 技术栈与规模

| 层 | 技术 |
|---|---|
| 桌面壳 | Tauri 2.10（Rust 2021，`src-tauri/`） |
| 前端 | React 19 + TypeScript 5.8 + Vite 7 + Tailwind 4 |
| 状态 | React hooks + 模块级单例注册表（无 Redux/Zustand） |
| 存储 | SQLite（`rusqlite`，bundled）+ 会话 `session.jsonl` |
| 原生能力 | `portable-pty`（真 PTY）、`ignore`/`globset`（ripgrep 风格搜索）、`lopdf`/`zip`/`image` |
| 包管理 | pnpm（`pnpm-lock.yaml`） |

规模：`src/` 239 个文件（`chat/` 66、`components/` 77、`app/` 25、`hooks/` 23、`adapters/` 19）；
`src-tauri/src/` 约 35 个模块。

---

## 2. 跑起来（本机已验证的命令）

### 2.1 依赖

```bash
pnpm install --frozen-lockfile
```

### 2.2 开发

```bash
pnpm dev           # 只起前端，端口 15420（HMR 15421）
pnpm tauri dev     # 起完整桌面应用
```

⚠️ **端口必须 > 15000**：Windows 动态端口段（本机 1024–15000）会被 Hyper-V/WSL 整段预留，
落在其中的端口绑定失败会报 `EACCES`（**不是** `EADDRINUSE`，极易误判）。15420 是刻意选的。

### 2.3 打包

```bash
pnpm build                      # 前端产物 → dist/
pnpm tauri build                # 出 MSI + NSIS
```

产物落在 `D:\omni-cargo-target\release\`（本机 `~/.cargo/config.toml` 把 target-dir 移到了这里）：
`omni.exe`、`bundle\msi\Omni_0.1.0_x64_en-US.msi`、`bundle\nsis\Omni_0.1.0_x64-setup.exe`。

第一次 `tauri build` 约 18 分钟（release codegen）。GitHub 被墙时需设
`TAURI_BUNDLER_TOOLS_GITHUB_MIRROR`（WiX/NSIS 工具链从 GitHub 拉）。

### 2.4 验证命令（改完必跑）

```bash
# 前端类型（noUnusedLocals/noUnusedParameters 都开着，能抓出删代码后的悬空 import）
node node_modules/typescript/bin/tsc --noEmit

# Rust（⚠️ 必须 cd 到 src-tauri 再跑，原因见 §8.2）
cd src-tauri && cargo check

# 前端构建（CSS/资源问题只有这一步能暴露）
node node_modules/vite/bin/vite.js build
```

---

## 3. 架构总览

### 3.1 一切皆插件

技能、工具、连接器、专家、项目预设统一为 `PluginManifest`，由 `src/plugins/registry.ts`
**模块级单例** 管理。

连接器两种形态：

- 带 `provider` → 走模型适配器（`src/adapters/registry.ts`）
- 不带 `provider` → 走 **MCP**（`src/plugins/mcp.ts` → `src-tauri/src/mcp.rs`，Rust 侧拉起 stdio 子进程）

⚠️ 注册表**必须可订阅**：`subscribe()` / `getVersion()`，广播点只在 `save()` 一处。
展示插件状态的 UI 必须订阅，且 `useSyncExternalStore` 的 snapshot 要「变了才变」，否则无限重渲染。

### 3.2 一轮对话怎么走

```
输入 → executeInputTask（建会话/写用户消息）
     → buildChatTools() 产出 tools 数组
     → engine.runToolLoop
     → 适配器（openai/claude/gemini/deepseek/ollama）
     → 工具执行（本地 / MCP / 子 Agent）→ 结果回灌 → 下一轮
```

三条容易踩的约定：

1. **工具说明只经 function calling 的 `tools` 数组到达模型**（`promptContribution ?? description`，不截断）。
   **改工具说明 = 改模型行为**，不是改注释。
2. **多参工具必须声明 `parameters`**，否则模型拿到空 schema；执行器要能吃 JSON 和纯文本两种入参。
3. `buildChatTools()` **永不产出 `mcp__*`**；专家工具走 `chat/expertTools.ts::selectExpertTools()`。

### 3.3 多窗口与数据一致性

窗口：`main`（工作台）、`compact`（悬浮球/桌宠）、`petThought`（思考气泡）、`settings`。

- **「哪个会话还在输出」唯一来源** = `useChatRuntime.loadingSessionIds`
- **整快照写权归主窗**（`owner`），紧凑窗只窄写自己的会话，靠 `chat/crossWindowSync.ts` 增量广播同步
- **删会话必须广播**，否则紧凑窗留着幽灵条目
- 空 assistant 占位只存在内存，不落盘（`isPendingProjectPlaceholder`）

### 3.4 数据在哪

| 内容 | 位置 |
|---|---|
| 会话正文 | `<数据根>/chat-sessions/<桶>/<id>/session.jsonl` |
| 任务历史 | SQLite `app_kv` 中 `omni_task_history:main` / `omni_task_history:compact`（旧 `omni_task_history` 键仅供 main 迁移） |
| 设置/位置/模型配置 | SQLite kv（经 `app/sqliteStorage.ts` 同步到 localStorage） |
| 本机数据根 | `D:\ALL_Software_Data\Omni`（**本机实测位置**，由应用设置决定；仓库里搜不到该字面量） |

排查问题直接读文件/查表比看 UI 快。

---

## 4. 目录导航：要改什么去哪

| 想改 | 去 |
|---|---|
| 工具定义/执行 | `src/chat/localTools.ts`、`src/chat/toolActionMap.ts`、`src-tauri/src/shellcmd.rs` |
| 模型接入 | `src/adapters/*.ts`（新增适配器要注册到 `adapters/registry.ts`） |
| 系统提示词 | `src/chat/promptModules.ts`、`src/chat/storage.ts` |
| 会话/项目状态 | `src/hooks/useChatSessions.ts`、`src/hooks/useChatRuntime.ts` |
| 窗口几何/悬浮窗 | `src/app/window.ts`、`src/hooks/useCompact*.ts` |
| 插件/技能/专家 | `src/plugins/`、`src-tauri/src/skillhub.rs`、`connectorhub.rs` |
| 知识库 RAG | `src-tauri/src/knowledge/`、`src-tauri/src/knowledge_*.rs` |
| 样式 | `src/styles/*.css`（入口 `src/App.css` 负责 `@import` 顺序） |

---

## 5. 关键不变量（违反就出 bug，且多半不报错）

**① 会话创建口唯一**
`executeInputTask::onPrepareConversation` 是唯一建会话 + 写用户消息的地方，**每个分支都必须调**。
上屏 / 落库 / 送模型**必须共用同一份消息数组**。
曾经因为技能和工具两个分支漏调，表现为「敲 `/命令` 不建会话」。

**② 窗口位置一律物理像素**
`src/app/window.ts` 的位置 API 全部是物理像素（虚拟桌面坐标系）。写 `LogicalPosition` 时，
Windows 上 tao 用**窗口当前所在屏**的 scale 换算，跨 DPI 屏会把落点放大到屏外。
尺寸仍保持**逻辑像素**（`setSize(new LogicalSize(...))`）——这一条别跟着改。
完整推导见技能 `tauri-floating-window-drag`。

**③ 工具结果剪枝有预算门**
`shouldPruneToolResults` 只在 `> 0.75 × 窗口` 时才剪。若文案说「超出预算」而每轮都剪，先查代码是否真判了预算。

**④ 换行必须是 LF**
`.gitattributes` 写了 `text eol=lf`。本机 `core.autocrlf=true` 不要动。

**⑤ 「不可达」要区分「废弃」和「被改坏」**
遇到字面量守卫（`const flag = false`）挡住的死分支，先查：
声明字段是否还生效、注释/UI 文案是否仍承诺它、整条管线是否只断在这一处。
三项中两项成立 ⇒ 是回归，要修好，不是删掉。

---

## 6. 当前已知问题（按严重度）

### 6.1 ✅ macOS 编译阻塞已修复，已补双架构 CI

通用依赖已恢复到 `[dependencies]`；仅 `clipboard-win`、`windows-sys` 留在 Windows 专属段。
`shellcmd.rs` 在 Windows 与 macOS 分别进入受限 Token / Seatbelt 后端；Linux 等尚无原生后端的平台请求受限模式时明确拒绝且不执行命令。
一次性命令与持久 Shell 在 macOS 使用用户默认 Shell，应用启动时恢复登录 Shell 的 PATH。
`.github/workflows/macos-build.yml` 分别在 Apple Silicon 和 Intel runner 上构建 DMG，挂载检查 app 包、二进制架构和代码签名后再上传。
主窗口使用透明无边框样式；当前 Tauri 2.10.3 在 macOS 需要
`tauri.conf.json` 的 `app.macOSPrivateApi = true` 与 `Cargo.toml` 的 `macos-private-api` feature。

GitHub Actions 最终双架构验收已通过：run `40138777648`（2026-10-25，验证分支 `PENGY/macos-build-verification`）。
`macos-15` Apple Silicon 与 `macos-15-intel` 两个 job 均成功构建 DMG、挂载检查 `.app`、验证二进制架构和代码签名，并上传 artifact（53.1 MiB / 53.7 MiB）。
本机 Windows 仍无法实测 macOS UI。CI 使用 ad-hoc 签名用于构建验证，不等同 Developer ID 签名或公证，公开分发仍需单独配置。

### 6.2 🟡 文件权限沙箱：Windows 已实测，macOS Seatbelt 已实现待 runner 验收

文件权限已移植为 WorkDSH 三档语义：`read-only`、`workspace-write`、`danger-full-access`。旧配置
`sandboxEnabled=true` 迁移为 `workspace-write`，`false` 迁移为 `danger-full-access`；Windows 新安装默认
`workspace-write`。切换 `danger-full-access` 必须经过风险确认。

Windows 命令沙箱使用 `WRITE_RESTRICTED` Token、logon SID + Everyone + 工作区/临时目录能力 SID、
目录 ACL、Low Integrity 与 Low no-write-up mandatory label；后端初始化任一步失败都 fail-closed。
`workspace-write` 已实测工作区内可写、工作区外被系统拒绝，`read-only` 已实测工作区写入被拒绝。
工作区 DACL / integrity label 通过 RAII guard 在本次命令结束后恢复，测试同时断言用户随后仍能删除工作区。
同一 standing policy 也覆盖 `/write_file`、`/edit_file`、Markdown/Office 导出与 Git 写入，防止从
`bash` 切换到专用文件工具绕过限制。受限模式使用一次性进程，只有 `danger-full-access` 保留持久 PTY。

macOS 后端已按 WorkDSH 的 Seatbelt 方案落地：固定调用 `/usr/bin/sandbox-exec`，profile 使用
`(allow default)` + `(deny file-write*)`，仅 `/dev/null`、canonical 工作区、`/tmp` 与系统临时目录可写。
`read-only` 不放行任何工作区 subpath；`workspace-write` 放行 canonical 工作区与临时目录。
`sandbox-exec` 缺失、profile 生成失败或 runner 报错时命令不执行。设置页已在 macOS 开放只读与工作区写入档。
专用文件工具使用同一有效模式，工作区外写入必须先获得一次性的 `sandbox_permissions + justification` 批准；
批准不会修改常驻设置，也不能绕过 No-Go Zones。`workspacePath` 在 `danger-full-access` 升权后不再作为第二道
工作区围栏传给 Office 后端，否则会出现“用户已批准但仍被 Rust 拒绝”的死路。

macOS 原生 Seatbelt 实写测试已加入，但本机是 Windows，尚不能宣称 macOS 实机验收完成。必须等
`.github/workflows/macos-build.yml` 在当前提交上由 Apple Silicon 与 Intel runner 跑完，才算 CI 级验收；
公开分发前仍需 Mac 实机走一遍 `docs/manual-smoke-checklist.md`。

### 6.3 ✅ 设置读取口径已统一

`src/app/settingsStore.ts` 现在直接重导出 `src/app/settings.ts` 的 `loadBasicSettings`；读取时统一剥掉旧版 `settingsWindow*` 字段。保存入口仍位于 `settingsStore.ts`。

### 6.4 ✅ 测试已可运行

`pnpm test` 在当前工作区通过 **83 个测试文件、861 个用例**（2026-11-08）。Rust 库测试 **169 passed / 1 ignored**。此前记录的 runner/config
初始化失败已无法复现；后续改动应把全量测试纳入回归，而不是只依赖 `tsc` / `vite build`。

### 6.5 🟡 发布链路未完成

无 Developer ID 签名、Hardened Runtime、entitlements、公证。Windows 包也未签名。
内部分发可用，对外分发会被 Gatekeeper / SmartScreen 拦。

### 6.6 🟡 工具链缺口

`knip` / `ts-prune` / `eslint` 都没装；`cargo-clippy` 组件未安装。
死代码/未使用依赖目前只能靠自建脚本（见 §8.3）。

### 6.7 🟡 刻意保留的不可达分支

`src/hooks/useCompactPetThoughtWindows.ts:106` 的 `shouldUseDetachedThoughtWindow = false`
让整块分离窗口逻辑不可达。坐标空间已按物理像素修正（避免地雷），但**删功能是产品决策**，未删。

### 6.8 🟡 桌面版收尾（当前工作区，未提交）

任务历史在 `src/chat/taskStorage.ts` 按窗口分别落盘，启动时把遗留 running 任务归为 aborted；执行器保存开始/终态及失败或取消前已流出的正文、思考和工具步骤。调度只由主窗口在自动化数据 hydration 成功后启动，采用持久化 claim，通知走 Tauri notification 插件，失败在主窗口显示并提供手动重试。备份/恢复维护门覆盖存储、知识处理、应用发起的文件编辑/撤销、附件快照、Office 导出与 Shell 命令；并发测试验证 SQLite 与 JSONL 在途写入排空后才开始快照。通过 Shell 脱离的后台进程不受命令生命周期锁约束，不承诺其外部写入与备份原子一致。普通迁移和恢复默认位置也走同一完整快照流程，目标必须为空、旧目录保留；配置提交成功后当前进程继续使用旧数据根，重启才切换。默认位置已有旧文件时拒绝覆盖，需先人工处理。配置文件原子替换失败已通过真实临时文件故障注入，证明旧配置字节保留与暂存文件清理；真实应用重启及进程中断仍未验收。

Office 测试 fixture 已用三个独立 Python 阅读器解析通过；这不等于 Word/Excel/PowerPoint 原生打开与渲染已验收。通知插件曾因前端 2.7.0 / Rust 2.4.0 版本不匹配被 Tauri CLI 拦截；两侧现精确锁定 2.4.0。发送通知已改为 await 原生命令，测试拒绝权限与 native 命令错误可向调度层传播。当前工作区 `pnpm tauri build --ci` 已成功生成 Windows MSI/NSIS。当前 macOS 工作流包含类型检查、Vitest、Rust 测试与前端构建；本轮改动尚未在 GitHub runner 重跑。备份不包括仓库内宠物美术资源或 SkillHub 用户级安装目录。

---

## 7. 工作区未提交改动（⚠️ 接手第一件事）

工作区仍混有多批改动。下表按主题记录；提交前应逐批复核暂存内容：

| 批次 | 文件 | 内容 | 验证 |
|---|---|---|---|
| A. 窗口几何物理化 | `src/app/window.ts`、`useCompactWindowController.ts`、`useCompactCharacterDrag.ts`、`useCompactMenus.ts`、`useCompactPetThoughtWindows.ts`、`useMainWindowController.ts`、`useCompactCharacterDrag.test.ts`、`src/app/window.compactPosition.test.ts`(新) | 紧凑窗/主窗位置统一到物理像素，修跨 DPI 屏出屏与「记不住位置」 | tsc ✅ |
| B. 单实例启动 | `src-tauri/Cargo.toml`、`Cargo.lock`、`src-tauri/src/lib.rs` | 加 `tauri-plugin-single-instance`，第二次启动唤起已有窗口 | cargo check ✅、双实例实测 ✅ |
| C. 第一轮死代码清理 | `src/App.tsx`、`adapters/paramCompat.ts`、`app/settings.ts`、`app/settingsStore.ts`、`chat/types.ts`、`plugins/mcp.ts`、`plugins/skillhubSkillsets.ts`、`src-tauri/src/gittools.rs`、`src/styles/*.css` | 删 7 处死导出 + 250 条死 CSS 规则（1597 行） | tsc ✅、vite build ✅、CSS 复扫 0 ✅ |
| D. 用户既有改动（**不是本轮做的**） | `src/components/plugins/InstalledSkillsetCard.tsx`、`src/styles/plugins.css` | 「插件卡片尺寸统一」，注释注明 2026-09-12 | 未验证 |
| E. 全局清理 | `index.html`、`package.json`、`pnpm-lock.yaml`、`src/adapters/*`、`src/chat/*`、`src/components/ArtifactsPanel.test.tsx`、模板图标与一次性脚本 | 删 5 个无效导出、3 个无引用 SVG、1 个一次性迁移脚本、3 个无用依赖 | tsc ✅、vite build ✅、cargo check ✅、vitest 720 ✅ |
| F. macOS 适配（本轮） | `src-tauri/Cargo.toml`、`main.rs`、`shellcmd.rs`、`shell_session.rs`、`sandbox.rs`、`office_export.rs`、`filemod.rs`、`workspace_files.rs`、设置 UI、`bashWriteScan.ts`、`.github/workflows/macos-build.yml` | 修复非 Windows 编译阻塞，适配用户 Shell/PATH，补系统路径护栏及 Intel/Apple Silicon DMG CI | Windows cargo check ✅、cargo test 136 ✅、pnpm test 729 ✅、pnpm build ✅；Mac CI 双架构 DMG ✅（run 40135570009） |
| G. 桌面版收尾（当前未提交） | `src/chat/task*`、`src/hooks/useChatRuntime.ts`、`src/hooks/useScheduledTasks.ts`、`src-tauri/src/backup.rs`、`storage_paths.rs`、`storage_maintenance.rs`、知识 worker、Office 测试、README、docs、CI 等 | 任务中断/输出留存、提醒、备份恢复维护门、知识引用、Office 导出验收、发布验证门 | 2026-10-26：tsc ✅、Vitest 78/825 ✅、Rust 166+1 ignored ✅、Office 独立解析 ✅、Windows build/package ✅；原生手测和本轮 Mac CI 待验 |
| H. WorkDSH 文件权限体系（当前未提交） | `sandbox.rs`、`shellcmd.rs`、`filemod.rs`、`office_export.rs`、`localTools.ts`、设置 UI、工具 manifest、相关测试、macOS CI、Vitest 范围 | 三档权限、Windows Token/ACL/Low IL、macOS Seatbelt、工作区外拒绝、只读/写入工具统一策略、一次性升权确认 | Windows：cargo 169 passed + 1 ignored ✅、Vitest 83 files / 861 passed ✅、权限专项 79 ✅、tsc ✅、build ✅；macOS：代码与双架构 CI 门已完成，当前提交尚未由 macOS runner 实跑 |

F 批次与早先未提交的 A-E 修改共用 `Cargo.toml` 等文件，提交时需按主题暂存对应 hunk；本轮未提交其他主题，也未触碰既有构建缓存。

提交前注意：

- **`Temp/` 未进 `.gitignore`**，里面有 CSS 备份（`styles-backup-2026-10-21/`）和两个扫描脚本。
  备份建议留到手测通过，脚本可决定是否转正到 `scripts/`。
- 按主题拆 commit，别把 A/B/C/D 混在一起。

---

## 8. 验证状态与踩坑记录

### 8.1 pnpm 可用

本机 `pnpm` 10.19.0 已验证可正常安装、移除依赖和执行脚本。此前的 Corepack
路径错误已无法复现；遇到环境不一致时仍可直接调用 `node_modules` 内的二进制作为兜底。

### 8.2 cargo 按**当前目录**找 `.cargo/config.toml`（不是按 manifest 目录）

镜像配置在 `src-tauri/.cargo/config.toml`（rsproxy.cn）。从仓库根跑
`cargo check --manifest-path src-tauri/Cargo.toml` 会**跳过它**，直奔 crates.io，
在本机表现为 `CONNECT tunnel failed, response 502`（代理不放行）。
**正确姿势：`cd src-tauri && cargo check`。**

顺带：本机 `~/.cargo/config.toml` 把 `target-dir` 设为 `D:/omni-cargo-target`，
原因写在那个文件里（DLP 占句柄 + 用户目录枚举卡死）。换机器不需要沿用。

### 8.3 死代码扫描的两个陷阱（自建脚本在 `Temp/`）

1. **子串匹配会假阴性**：`CODE.includes("foo")` 会被 `foo-bar` 判成"在用"。
   Omni 实测：子串判据报 **0** 条死规则；词边界判据报 **300** 条。
2. **词边界又会假阳性**：代码里有 `foo--${state}` / `foo__${x}` 动态修饰符（实测 10 个基类），
   字面量搜不到 ⇒ 会误删正生效的样式。
3. **`React.lazy(() => import("./X"))` 取的是 default 导出**，符号引用分析看不见。
   本轮据此误删过 `FilePreview` 默认组件，`tsc` 当场报 `Property 'default' is missing` 才发现。

完整判据已写进技能 `css-dead-rule-audit`（SKILL.md 的「判据本身的两个陷阱」一节）。

### 8.4 本轮实际验证过 / 没验证的

| 项目 | 结果 |
|---|---|
| `pnpm exec tsc --noEmit` | ✅ 2026-11-08 当前工作区通过 |
| `pnpm build` | ✅ 2026-11-08 当前工作区通过；仅有既有 chunk/import 体积警告 |
| `cargo test --lib` | ✅ 2026-11-08，169 passed / 1 ignored |
| `pnpm tauri build --ci` | ✅ 2026-10-26 当前工作区生成 Windows MSI、NSIS；最终包散列见 TestReport §3。此前版本 `omni.exe` 启动进程响应正常；最终包安装、启动与 UI 尚未实测 |
| `pnpm test` | ✅ 2026-11-08，83 文件 / 861 用例；已限定只扫描 Omni `src`，不会误跑 `workdsh/` |
| `cargo fmt --check` | ⚠️ 未运行：stable toolchain 未安装 rustfmt 组件 |
| 单实例行为 | ✅ 早先实测：两次启动后仍 1 个进程，第二 PID 不存活；本轮未重测 |
| 真机跨屏拖拽及快速开合 | ❌ 本轮未验证，需双屏手动操作 |
| macOS 构建 | ✅ 2026-10-25 旧版 workflow 双架构通过（run `40139930802`）；本轮 Seatbelt 与权限升权修改尚未在 GitHub runner 重跑 |
| Office 系统打开/渲染及备份恢复后重启 | ❌ 本轮未实机验收 |

---

## 9. 建议的接手顺序

1. 先按 `docs/planning/IMPL_macos-build-verification-desktop-completion.md` 的未验收项做 Windows 原生窗口、备份重启、Office 与通知手测；不要把组件测试当作实机验收。
2. 在 GitHub runner 对当前提交后的代码重跑 macOS Intel / Apple Silicon 工作流，确认新增测试门与 DMG 构建都通过。
3. 按 §7 主题拆分现有未提交改动；先看 `git status`，不把用户原有修改混入本轮提交。
4. 公开分发前另行安排 macOS Developer ID 签名/公证与 Windows 签名，并在 Mac 实机按冒烟清单验证 Seatbelt 文件边界与一次性升权。

---

## 10. 参考资料

| 内容 | 位置 |
|---|---|
| 功能与卖点 | `README.md` |
| 手测清单 | `docs/manual-smoke-checklist.md` |
| RAG 流程 | `docs/rag-flow.md` |
| 依赖风险审计 | `docs/dependency-risk-audit.md` |
| 桌宠图集规范 | `docs/pet-atlas-spec.md`、`docs/pet-v3-atlas-plan.md` |
| 设计/计划稿 | `docs/superpowers/{specs,plans}/` |
| 历史决策与踩坑 | `.workbuddy/memory/YYYY-MM-DD.md`（按天）、`memory/MEMORY.md`（不变式）、`memory/topics/`（专题） |

**建议**：动窗口几何、插件注册、工具链之前，先读 `.workbuddy/memory/MEMORY.md` 的
「关键不变量」一节——那里每条都对应一次真实事故。
