# Omni 桌面版收尾亲验收报告（DRAFT · 等实施完成后执行）

> 状态：DRAFT；尚未裁决。对应 [TestCase](TestCase-macos-build-verification-desktop-completion.md) 与 [IMPL](../planning/IMPL_macos-build-verification-desktop-completion.md)。验收范围来自 IMPL C1–C8、T02–T12、Release Gate。当前自动化记录是实施过程证据，不替代终审独立复跑。

## 0. 执行环境

- 仓库：`D:\Code\ypeng\Omin`；Windows 11；PowerShell 7。
- 前端依赖：`pnpm install --frozen-lockfile`；Node/pnpm 版本由本机和 lockfile 实际记录，执行时填写。
- Rust 命令从 `src-tauri` 运行；不要并行运行 Cargo。
- macOS 两架构必须由 GitHub Actions 对待验收提交实际运行；不能用 Windows 结果替代。
- Live 项使用可丢弃测试资料/会话和新建空目录；不得覆盖真实非空数据目录。

## 1. 验收面、命令与结果槽

### ① 依赖锁定与工作区卫生（T01/T10）

```powershell
Set-Location D:\Code\ypeng\Omin
$lockBefore = (Get-FileHash .\pnpm-lock.yaml -Algorithm SHA256).Hash
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
$lockAfter = (Get-FileHash .\pnpm-lock.yaml -Algorithm SHA256).Hash
if ($lockBefore -ne $lockAfter) { throw 'pnpm-lock.yaml changed' }
git status --short
```

门：依赖安装退出码 0；安装不改动 lockfile。工作区既有改动须按主题识别，不因验收清理或覆盖。
- [ ] 结果／证据：__________

### ② TypeScript 与前端全量测试（T02–T10）

```powershell
Set-Location D:\Code\ypeng\Omin
pnpm exec tsc --noEmit
pnpm test
```

门：两命令退出码均为 0；记录 Vitest 完整文件数、用例数及失败数；必须为完整单次套件，不得以受影响子集替代。
- [ ] 结果／证据：__________

### ③ Rust lib 全量测试（T04/T07/T09/T11）

```powershell
Set-Location D:\Code\ypeng\Omin\src-tauri
cargo test --lib --locked -- --test-threads=1
```

门：退出码 0；记录 passed/failed/ignored；ignored 用例逐项核对其独立替代验收，不得将 ignored 计为通过。
- [ ] 结果／证据：__________

### ④ Office 产物独立解析（T09）

PowerShell 7 下生成本次 fixture，并从测试输出提取实际目录：

```powershell
Set-Location D:\Code\ypeng\Omin\src-tauri
$officeVenv = Join-Path $env:TEMP 'omni-office-acceptance-venv'
if (-not (Test-Path -LiteralPath (Join-Path $officeVenv 'Scripts\python.exe'))) { python -m venv $officeVenv }
& (Join-Path $officeVenv 'Scripts\python.exe') -m pip install --index-url https://pypi.org/simple -r .\requirements-office-test.txt
if ($LASTEXITCODE -ne 0) { throw 'Office parser dependencies failed to install' }
$env:OMNI_OFFICE_TEST_OUTPUT = (New-Item -ItemType Directory -Force ..\Temp\office-acceptance).FullName
$fixtureRun = cargo test --lib --locked generate_office_delivery_fixtures -- --ignored --nocapture 2>&1
if ($LASTEXITCODE -ne 0) { throw 'fixture generation failed' }
$fixturePath = [regex]::Match(($fixtureRun -join "`n"), 'OFFICE_DELIVERY_OUTPUT=([^\r\n]+)').Groups[1].Value.Trim()
if (-not (Test-Path -LiteralPath $fixturePath -PathType Container)) { throw 'fixture output missing' }
& (Join-Path $officeVenv 'Scripts\python.exe') .\src\office_export_parse_test.py $fixturePath
if ($LASTEXITCODE -ne 0) { throw 'independent Office parsing failed' }
```

门：Rust fixture 生成和 Python 解析退出码均为 0；DOCX/XLSX/PPTX ZIP、XML、关键文本/结构检查均成功。`Temp/office-acceptance` 中的产物供复核，不自动清理；本项不证明 Office 原生渲染或公式重算。
- [ ] 实际命令／结果／证据：__________

### ⑤ 前端产物构建（T11）

```powershell
Set-Location D:\Code\ypeng\Omin
pnpm build
```

门：退出码 0；Vite 产物生成。记录已有 chunk/import 警告，不能把 warning 描述成 error。
- [ ] 结果／证据：__________

### ⑥ Windows 桌面包与启动（T11）

```powershell
Set-Location D:\Code\ypeng\Omin
pnpm tauri build --ci
```

门：退出码 0；MSI/NSIS 产物存在，记录大小与 SHA-256；实际安装后启动并观察 UI，不能只以构建成功或进程存活判 UI 通过。
- [ ] 构建／散列结果：__________
- [ ] 安装及 UI 结果：__________

### ⑦ macOS Apple Silicon 与 Intel CI（T11）

```text
GitHub Actions：打开待验收提交对应的 macOS build workflow run
检查 apple-silicon 与 intel 两个 matrix job 及各自上传的 DMG artifact
```

门：两个 job 均对应待验收 SHA 且全绿；每个 job 恰有一个 DMG；workflow 内 lipo 架构检查与 `codesign --verify --deep --strict` 成功；下载产物并记录文件名、大小、SHA-256。
- [ ] commit SHA／run URL：__________
- [ ] Apple Silicon job／DMG／SHA-256：__________
- [ ] Intel job／DMG／SHA-256：__________

### ⑧ 原生桌面、通知、迁移、任务及 Office Live（T02–T09）

```text
按 docs/manual-smoke-checklist.md §11–14 逐项操作
```

门：每项记录通过/失败/环境不可测、系统版本与必要环境信息；不得用 mock、CI 或 Windows 测试替代 macOS 原生观察。迁移和恢复只对可丢弃资料执行，验证重启后切换及旧目录保留。
- [ ] T02 双屏/DPI/悬浮球：__________
- [ ] T04 备份恢复/迁移/重启：__________
- [ ] T05 通知真实到达及提醒投递：__________
- [ ] T06 停止/重启/主动继续 UI：__________
- [ ] T08 知识资料生命周期与引用：__________
- [ ] T09 Office 原生打开/排版/公式：__________

## 2. 断言实质抽查

- [ ] 备份/迁移测试确认真实 SQLite 快照及会话、附件、知识文件内容，不仅断言函数调用。
- [ ] 调度测试确认 claim 持久化先于投递；失败不虚报成功、不自动重投；通知 native invoke 错误能到达失败状态。
- [ ] 中断/继续测试确认保留部分输出，启动时 running 转 aborted，继续不重放旧工具调用。
- [ ] Office 检查覆盖文件可解析、目标会话路径、同名保护及失败时原文件字节不变。
- [ ] 对关键新增测试源码抽查边界/失败分支，避免只有 happy path 或 mock 自证。

结果：__________

## 3. 机器复核快照（2026-11-08；非最终裁决）

以下是在当前工作树独立复跑的结果，用于保留新证据；不代表 T02–T12 全部收口，也不预判终审裁决。

| 验收面 | 实际结果 | 证据／限制 |
|---|---|---|
| 依赖锁定 | 通过 | `pnpm install --frozen-lockfile` 退出码 0；lockfile SHA-256 前后均为 `7E82416C4A8A5260D0D4A8CF2B0E529A1254E4980BA4659DA436FB5B46D92213` |
| TypeScript | 通过，退出码 0 | 提交 `14f23a5` 上执行 `pnpm exec tsc --noEmit` |
| 前端全量 | 通过，102 文件 / 978 用例 | 提交 `14f23a5` 上单次完整 `pnpm test` |
| Rust lib 全量 | 通过，182 passed / 0 failed / 1 ignored | 从 `src-tauri` 执行 `cargo test --lib --locked -- --test-threads=1`；ignored 为显式 Office fixture 生成器 |
| Agent Host smoke | 通过 | `pnpm agent-host:smoke`：16 events、2 model calls、restart replay ok |
| Rust 格式 | 通过 | `cargo fmt --check` 退出码 0 |
| Office 独立解析 | 通过 | 保留在 `Temp/office-acceptance/office-delivery-1aaa3a40-ae5d-444b-b673-343fda017bc3`；DOCX/XLSX/PPTX 独立读库、ZIP CRC、XML 与内容断言全过。Python 依赖安装在 `%TEMP%\omni-office-acceptance-venv`，版本见 `src-tauri/requirements-office-test.txt` |
| 前端构建 | 通过，Vite build 20.78s | `pnpm tauri build --ci` 的 beforeBuildCommand 执行成功；有既存 stream externalized、chunk、循环依赖、动态/静态 import 警告 |
| Windows Tauri 包 | 通过，退出码 0 | 提交 `14f23a5`：MSI 88,596,480 bytes，SHA-256 `747F62B113DC073BE73E6A899F7DE181AED0AA37FC3201F5112EB97A12F8B1E1`；NSIS 75,116,502 bytes，SHA-256 `EE011D459619E4185FDF92B49B4D4806A7D73F96578DCED7D2D2ECD47BADC490` |
| Windows release smoke | 通过（有限） | release `omni.exe` 主窗口响应；WebView2 与 Agent Host sidecar 启动；关闭主窗口后 sidecar 不残留。未执行安装器安装和完整 UI 流程 |
| macOS CI | 通过 | run `42467041924`，提交 `14f23a5`；Apple Silicon 与 Intel job 均全绿，覆盖 sidecar 构建、前端/Rust/Seatbelt 测试、DMG 构建/挂载、架构和 codesign 检查 |
| macOS artifacts | 已上传 | artifact ID 13612512175 / 13613080484；归档 92,643,917 bytes / 约 90.2 MiB。GitHub artifact digest 见 §1 ⑦，归档 digest 不等同 DMG SHA-256 |
| 原生 Live | 未执行 | 双屏、通知、重启迁移、继续/中断 UI、Office 原生渲染仍需逐项操作 |

工具版本：Node `v22.22.3`、pnpm `10.34.5`、Cargo/Rust `1.98.0`。

T06 当前工作树新增了任务记录与会话关联、侧栏中断标记和会话内风险提示；目标会话有更新运行时隐藏旧中断标记。`TaskStatusIndicators.test.tsx` 覆盖中断提示、成功任务不显示提示及可访问标签。自动面通过不替代停止/重启/继续的完整 UI live 流程。

## 4. 终审裁决

- 自动化机器面：[ ] ACCEPTED / [ ] REWORK；依据：__________
- 原生产品面：[ ] 已完成 / [ ] NEED-HUMAN-TEST；未验项：__________
- 整体 IMPL Release Gate：[ ] 满足 / [ ] 未满足；依据：__________
- 待产品方事项（签字、原生实测、提交授权）：__________

当前不得预先选择裁决。本草稿未填写的结果槽需在实施收尾后按命令独立复跑并据实填写。
