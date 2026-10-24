# Omni 项目交接文档

> 更新：2026-10-25 ｜ 依据：工作区实况（不是设计愿景）
> 本文档只写**代码里能取证的事**与**接手后一定会遇到的坑**。功能清单见 `README.md`。

---

## 0. 三十秒版

| 问题 | 答案 |
|---|---|
| 这是什么 | Tauri 2 + React 19 + Rust 的本地优先 AI 桌面工作台，数据全在本机 SQLite |
| 现在能跑吗 | Windows：能（dev / build / 打包都验证过） |
| 能打 Mac 包吗 | **代码已完成 macOS 双架构适配**；Intel/Apple Silicon 的 DMG 由 `.github/workflows/macos-build.yml` 在 macOS runner 实构 |
| 测试能跑吗 | 能：66 个文件、729 个用例全部通过，见 §6.4 |
| 工作区干净吗 | **不干净**，有 5 个主题的未提交改动，见 §7。**先看 §7 再动手** |
| 最该先做什么 | 把 §7 的改动按主题提交，否则下一轮改动会和它们混在一起 |

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
npm install        # 本机 pnpm 坏了，见 §8.1；环境正常时用 pnpm install
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
| 任务历史 | SQLite 表 `omni_task_history` |
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
`shellcmd.rs` 已给 Windows 受限 token 调用加平台边界，非 Windows 请求沙箱时明确拒绝。
一次性命令与持久 Shell 在 macOS 使用用户默认 Shell，应用启动时恢复登录 Shell 的 PATH。
`.github/workflows/macos-build.yml` 分别在 Apple Silicon 和 Intel runner 上构建 DMG，挂载检查 app 包、二进制架构和代码签名后再上传。
主窗口使用透明无边框样式；当前 Tauri 2.10.3 在 macOS 需要
`tauri.conf.json` 的 `app.macOSPrivateApi = true` 与 `Cargo.toml` 的 `macos-private-api` feature。

GitHub Actions 透明窗口配置修正后的双架构构建已实跑成功：run `40137421597`（2026-10-25，验证分支 `PENGY/macos-build-verification`）。
`macos-15` Apple Silicon 与 `macos-15-intel` 两个 job 均通过并上传 DMG（53.1 MiB / 53.7 MiB）。随后加入 DMG 挂载、架构和签名校验，需以包含该校验步骤的下一次 run 作为最终 CI 验收。
本机 Windows 仍无法实测 macOS UI。CI 使用 ad-hoc 签名用于构建验证，不等同 Developer ID 签名或公证，公开分发仍需单独配置。

### 6.2 🟡 macOS 沙箱与路径围栏

macOS 尚未提供 OS 级沙箱。设置页禁用新开关；旧配置开启时可关闭，关闭前后端拒绝命令而非静默普通执行。
路径包含判断在非 Windows 平台按大小写敏感语义比较；macOS 另对系统目录、`~/Library`、`.ssh` 做保守禁写保护，临时目录仍放行。
若未来需要 macOS OS 级隔离，应单独实现平台沙箱后端。

### 6.3 🟠 `loadBasicSettings` 有两份实现，同名不同义

| 位置 | 行为 | 使用者 |
|---|---|---|
| `src/app/settings.ts:40` | 读后 `normalizeBasicSettings`（剥掉旧版 settingsWindow* 字段） | `chatRuntimeHelpers`、`shellEnv`、`localTools` |
| `src/app/settingsStore.ts:76` | **不 normalize** | `useChatRuntime` |

同一份设置经不同入口读出可能不同。**合并属行为变更**，本轮未动，需要产品口径确认。

### 6.4 ✅ 测试已可运行

`pnpm test` 当前通过 **66 个测试文件、729 个用例**。此前记录的 runner/config
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

---

## 7. 工作区未提交改动（⚠️ 接手第一件事）

工作区仍混有多批改动。下表按主题记录；全局清理 E 已独立验证，A-D 仍应按主题分别提交：

| 批次 | 文件 | 内容 | 验证 |
|---|---|---|---|
| A. 窗口几何物理化 | `src/app/window.ts`、`useCompactWindowController.ts`、`useCompactCharacterDrag.ts`、`useCompactMenus.ts`、`useCompactPetThoughtWindows.ts`、`useMainWindowController.ts`、`useCompactCharacterDrag.test.ts`、`src/app/window.compactPosition.test.ts`(新) | 紧凑窗/主窗位置统一到物理像素，修跨 DPI 屏出屏与「记不住位置」 | tsc ✅ |
| B. 单实例启动 | `src-tauri/Cargo.toml`、`Cargo.lock`、`src-tauri/src/lib.rs` | 加 `tauri-plugin-single-instance`，第二次启动唤起已有窗口 | cargo check ✅、双实例实测 ✅ |
| C. 第一轮死代码清理 | `src/App.tsx`、`adapters/paramCompat.ts`、`app/settings.ts`、`app/settingsStore.ts`、`chat/types.ts`、`plugins/mcp.ts`、`plugins/skillhubSkillsets.ts`、`src-tauri/src/gittools.rs`、`src/styles/*.css` | 删 7 处死导出 + 250 条死 CSS 规则（1597 行） | tsc ✅、vite build ✅、CSS 复扫 0 ✅ |
| D. 用户既有改动（**不是本轮做的**） | `src/components/plugins/InstalledSkillsetCard.tsx`、`src/styles/plugins.css` | 「插件卡片尺寸统一」，注释注明 2026-09-12 | 未验证 |
| E. 全局清理 | `index.html`、`package.json`、`pnpm-lock.yaml`、`src/adapters/*`、`src/chat/*`、`src/components/ArtifactsPanel.test.tsx`、模板图标与一次性脚本 | 删 5 个无效导出、3 个无引用 SVG、1 个一次性迁移脚本、3 个无用依赖 | tsc ✅、vite build ✅、cargo check ✅、vitest 720 ✅ |
| F. macOS 适配（本轮） | `src-tauri/Cargo.toml`、`main.rs`、`shellcmd.rs`、`shell_session.rs`、`sandbox.rs`、`office_export.rs`、`filemod.rs`、`workspace_files.rs`、设置 UI、`bashWriteScan.ts`、`.github/workflows/macos-build.yml` | 修复非 Windows 编译阻塞，适配用户 Shell/PATH，补系统路径护栏及 Intel/Apple Silicon DMG CI | Windows cargo check ✅、cargo test 136 ✅、pnpm test 729 ✅、pnpm build ✅；Mac CI 双架构 DMG ✅（run 40135570009） |

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
| `tsc --noEmit` | ✅ 通过 |
| `vite build` | ✅ 通过（1m07s），CSS 产物 346.26 kB → 310.27 kB |
| `cargo check` | ✅ 通过（52s） |
| 单实例行为 | ✅ 实测：两次启动后仍 1 个进程，第二 PID 不存活 |
| CSS 死规则复扫 | ✅ 0 条，9 文件 postcss 可解析 |
| **vitest** | ✅ 64 个文件、720 个用例全部通过 |
| **真机跨屏拖拽** | ❌ 未验证（需双屏手动操作） |
| **macOS 构建** | ❌ 未验证（预期失败，§6.1） |

---

## 9. 建议的接手顺序

1. **提交 §7 的 A-D 四批改动**（先跑一遍 §2.4 三条命令 + `pnpm test` 确认基线）。
2. 修 macOS 两处编译阻塞（§6.1），这是「能不能给别人用」的分水岭。
3. 统一 `loadBasicSettings`（§6.3），需要先定口径。
4. macOS 沙箱与路径围栏（§6.2）——安全语义问题，别拖到发布前。
5. 签名/公证（§6.5）——要在产品化之前排期。

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
