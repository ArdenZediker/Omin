# Omni 桌面版收尾验收用例

## 1. 元信息

| 项 | 内容 |
|---|---|
| 分支 | PENGY/macos-build-verification |
| 目标 | 按[收尾计划](../planning/IMPL_macos-build-verification-desktop-completion.md) C1–C8、T02–T12 和 Release Gate 逐门证明 |
| 与既有测试面 | 汇总现有实现测试与原生验收；不复制既有 fixture 或假装 mock 等于 live |
| 真相源 | 上述 IMPL 条款；原生输入来自[手测清单](../manual-smoke-checklist.md) |
| Profile | 本地/CI 自动测试、Windows live、macOS 双架构 runner |
| 资产 | src 中既有 Vitest 用例、src-tauri/src 的 Rust tests、macos-build.yml、手测清单；原生 runner 尚无，不能伪造 |

## 2. 测试哲学

自动化契约、打包构建、桌面观察是不同层的证据。绿单测不能替代双屏无闪烁、系统通知到达、Office 渲染或 macOS DMG。涉及迁移只用测试资料与空目标；非空目标必须拒绝且原字节不变。现有测试覆盖不足之处保持待验，不补容易通过但不能证明契约的重复 fixture。

## 3. 三层职责

| 层 | 责任与门 |
|---|---|
| 契约/单元 | 完整 Vitest 与 Rust lib 全绿；检查快照、任务、提醒、引用及导出关键断言 |
| 集成/打包 | 冻结依赖、类型检查、前端构建、Windows MSI/NSIS、macOS 双架构 DMG |
| Live | 手测清单逐条记录通过/失败/环境不可测；双屏/通知/迁移重启/Office 不可被 mock 签收 |
| 公开分发 | 签名/公证在本 IMPL 范围外；不能由此报告签收 |

## 4. 用例分类

- AD01（C1/T02）：窗口物理像素与显隐队列测试通过；LV01 双屏多 DPI 快速开合不闪/不跳/不出屏。
- AD02（C2/T03）：SQLite 拒写可见，恢复后最新值重试成功，旧值不能覆盖新值。
- AD03（C3/T04）：真实临时 SQLite、JSONL、知识文件、附件、persona 快照迁移；内路径重写；非空/父子目标拒绝且原字节不变；配置替换失败保留旧字节。LV02 应用重启后重新读取，旧根保留。
- AD04（C4/T05）：cron/时区、claim 先持久化、失败不自动重投、手动重试与 owner 限定；native 通知权限和发送错误不能记 delivered。LV03 系统通知真实可见，desktop 只填草稿，session 仅入指定会话。
- AD05（C5/T06）：中断/失败的 partial output 保留，running 启动恢复 aborted；任务按 sessionId 归属，最新任务状态显示在对应会话，成功新轮次清除旧中断提示；继续新轮次不重放旧写工具。LV04 完整 UI 停止/重启/继续。
- AD06（C6/T07）：review 只有真实检查才成功；空输出、失败工具、缺失产物显示非成功。
- AD07（C7/T08）：documentId/chunkId 定位应用存档；失效提示保留历史摘录。LV05 真实资料导入、引用、删除/重分块。
- AD08（C8/T09）：DOCX/XLSX/PPTX 可解析，重名/失败原子不覆盖。LV06 原生 Office 打开、版式和公式结果。
- AD09（T10/T11/T12）：配置入口与类型检查、Windows 安装包、macOS Intel/Apple Silicon DMG 当前提交双矩阵、文档按证据同步。

## 5. 覆盖勾稽矩阵

| IMPL 锚点 | 自动用例/现有绑定点 | Live 或平台门 |
|---|---|---|
| C1/T02 | AD01：compactWindowGeometry、window.compactPosition、CompactWindow.interaction tests | LV01：手测 §11 |
| C2/T03 | AD02：sqliteStorage.persistence、StorageSaveNotice tests | 不适用 |
| C3/T04 | AD03：backup_tests.rs、storage_paths.rs tests | LV02：手测 §12 |
| C4/T05 | AD04：scheduledTaskCron、scheduledTaskState、useScheduledTasks、systemNotifications tests | LV03：手测 §13 |
| C5/T06 | AD05：taskRunner、taskStorage、chatRunOutput、TaskStatusIndicators tests | LV04：手测 §13 |
| C6/T07 | AD06：taskValidation、taskExecutor tests | 不适用 |
| C7/T08 | AD07：KnowledgeSourceCard、ChatMessage tests | LV05：手测 §14 |
| C8/T09 | AD08：office_export_tests.rs + 三格式独立 Python 解析 | LV06：手测 §14 |
| T10 | AD09：settingsStore test、TypeScript 检查 | 不适用 |
| T11 | AD09：Windows 构建 + macos-build.yml | 双架构 run/artifact |
| T12 | AD09：README、HANDOVER、IMPL、TestReport 交叉核对 | 产品方回执 |

## 6. 执行时序

| 顺序 | 命令及目录 | 可判定门 |
|---|---|---|
| 1 | 仓库根：pnpm install --frozen-lockfile | 退出 0、lock 无漂移 |
| 2 | 仓库根：pnpm exec tsc --noEmit；pnpm test | 均退出 0，前端全量通过 |
| 3 | src-tauri：cargo test --lib --locked -- --test-threads=1 | 退出 0，Rust lib 全量通过 |
| 4 | 仓库根：pnpm build；pnpm tauri build --ci | 均退出 0，MSI 和 NSIS 产出 |
| 5 | 当前提交的 macos-build.yml | 双矩阵全绿、各一个 DMG、架构与 codesign 验证通过 |
| 6 | 手测清单 §11–14 | 每项有 live 结果；未测记 NEED-HUMAN-TEST |

## 7. 不在范围

- Developer ID、Hardened Runtime、公证及 Windows 代码签名（公开分发阶段）。
- Shell 脱离命令生命周期后的后台进程、外部工作区/SkillHub/pet 资源备份。
- 无原生 Office 软件的环境不能签收 LV06；Windows 构建不能替代 macOS 双架构构建。
