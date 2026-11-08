# Omni 桌面版收尾计划

更新：2026-11-08；分支：PENGY/macos-build-verification；状态：[SPEC-OK] / [GO] 自动化与双架构打包已收口，原生 Live 验收待人工。
需求依据：用户确认的八项桌面收尾清单，并授权持续实施到完整验收。主集成负责人：当前 Codex 会话。

## 0. 范围与已有资产

定位：个人使用、本地优先的桌面 AI 工作台。保留现有 Tauri、React、SQLite、会话 JSONL、模型工具循环与确认门。正式商业签名、公证按公开分发阶段安排；本次交付本地桌面功能与可验证的构建。

| 项 | 当前锚点 | 复用与改动 | 并行归属 |
|---|---|---|---|
| 1 窗口 | src/hooks/useCompactWindowController.ts:169；src/app/window.ts | 已有几何串行队列、跨 DPI 换算；检查旁路写入和显隐竞争 | 主会话 |
| 2 数据 | src/app/sqliteStorage.ts:85；src-tauri/src/backup.rs:104 | 保留存储接口，补失败状态/重试、完整快照、临时恢复校验 | 备份独立，前端存储主会话 |
| 3 调度 | src/hooks/useScheduledTasks.ts:15；src/chat/types.ts:152 | 使用现有任务数据，修真实 cron、幂等投递、提醒语义 | 调度独立 |
| 4 中断 | src/chat/taskRunner.ts:28；src/chat/taskStorage.ts:19 | 保留执行器，补中断状态恢复与用户主动继续 | 主会话 |
| 5 校验 | src/chat/taskExecutor.ts:139 | 移除虚假校验成功，实际验证结果和工具失败 | 主会话 |
| 6 知识 | src/components/ChatMessage.tsx:679 | 接通已有知识文档预览，定位片段、失效提示 | 知识独立 |
| 7 导出 | src-tauri/src/office_export.rs:870；src/components/ArtifactsPanel.tsx | 保留三个导出器和现有预览，验证生成/打开/定位/覆盖失败 | 主会话 |
| 8 一致性 | src/app/settings.ts:40；src/app/settingsStore.ts:67；.github/workflows/macos-build.yml | 收敛配置，增加测试 CI、整理实际验收记录 | 主会话 |

不引入新的服务器、账号或运行时框架。各主题可独立回退代码；数据恢复采取新目录校验后切换，不改坏原数据。保持已有未提交修改，不整树覆盖或重置。

## 1. 固定契约

- C1：位置以物理像素保存，尺寸以逻辑像素设置；拖动期间不接受旧布局覆盖。快速重复请求最终遵循最新意图；失败不能遗留隐藏窗口。
- C2：SQLite 保存失败进入可见待重试状态，不显示已持久化；同 key 写入有序且重试采用最新值。
- C3：备份成功必须生成可验证快照；恢复到临时目录，完整校验后才启用；损坏包/错误密码/路径越界/中断不覆盖现有目标。
- C4：本批只实现提醒，不自动执行模型或工具。五字段 cron 与本机时区匹配；非法表达式不投递并显示错误。首次启用以 createdAt 为起点，重启/休眠只补最近 24 小时内、且不早于创建时间的最近一个时段。时区回拨以本地年月日时分为幂等键，同一墙上时刻不重投。desktop 只填草稿；notification 发系统通知；session 先选定 sessionId 再打开聊天并填草稿，已删除会话报错，不投到别的会话。仅主窗口运行调度。
  投递前持久化 taskId+本地时段 claim，成功后才投递；claim 保存失败不投递、下轮可重试。claim 后投递失败/进程中断不自动重投该时段，显示失败/结果未知，可由用户手动再提醒。lastRunAt 是最后认领的计划时段时间，不代表 AI 执行成功。该策略提供最多一次尝试，不声称恰好一次交付；投递成功但完成状态保存失败也不会重复投递。
- C5：失败/取消不能变成 completed；启动时没有活跃执行器的 running 任务标中断。继续由用户主动触发，不自动重放外部副作用。
- C6：review 只在真实检查后成功；空结果、失败工具、缺失产物必须产生明确状态/说明。
- C7：知识引用以 documentId/chunkId 查找内部存档，存在则预览并定位，失效则明确提示；保留消息中的历史摘录。
- C8：Office 支持已声明的基础格式；生成的产物真实存在、可解析，路径与会话关联正确；重名默认不覆盖，覆盖按既有确认语义。

### 1.1 备份与恢复边界

备份在后端取得全局维护独占权，等待已有数据操作排空，新的数据写操作等待或返回可重试维护错误；保护范围包括 SQLite 写入、会话 JSONL/附件、知识原件写入/删除与数据根切换。普通数据命令、知识后台 worker、应用发起的工作区文件编辑/撤销、附件快照、Office/Markdown 导出及一次性/持久 Shell 调用持有读侧操作守卫；备份持有独占守卫。锁定后用 SQLite 快照 API 生成独立数据库（不复制活跃 WAL/SHM），与该时点的会话、知识文件一起写临时备份；检查 integrity_check 和元数据所引用内部文件，再完成输出文件。通过 Shell 脱离的后台进程不属于已等待的命令生命周期，不承诺其外部副作用与备份原子一致；备份只覆盖清单声明的应用数据目录。

恢复只允许空的新目录，拒绝当前数据目录及其父子路径；在同卷相邻 staging 目录完成解密、路径/符号链接/重复条目/SQLite/引用检查，再 rename 到目标。普通“更改存储位置”和“恢复默认位置”也使用同一快照、路径重写及空目标规则；默认位置若已有文件则拒绝覆盖。切换配置必须原子写入；目录切换只设置下次启动的数据根，当前进程及其已排队保存仍使用旧根，避免旧界面覆盖新目录数据。中断或配置提交失败保留旧根可启动，已发布的新目录保留供人工检查；不清除用户原目录。测试覆盖并发写入排空、备份错误、空/非空迁移目标、配置提交失败注入及原数据字节不变；真实重启仍待验收。

### 1.2 中断、继续与文件负责人

状态仍使用 running/completed/failed/aborted。启动加载到的 running 归为 aborted，error 明确说明上次中断、外部操作结果可能未知；已确认工具输出和模型部分文字保留。运行时在开始和终态持久化，读取完成前禁止空历史覆盖；各窗口只合并自己产生的任务 ID。继续是用户在原会话发起新的聊天轮次，携带现有内容与中断提示，从模型重新规划开始，不恢复/重播旧工具数组；未知写入先查结果，新的危险操作继续经过已有确认门。禁止自动点击继续或后台重试写工具。

### 1.3 运行中追加输入

Agent Host 为默认运行时，回答运行期间输入框保持可编辑并可提交追加内容；停止按钮与追加按钮并存。追加只走 Host `session.steer`，在下一步模型边界进入当前 turn，不并发启动第二个 prompt。若 UI 已进入 loading 但 Host 尚未完成会话创建，最多等待 30 秒直到 `session.status.running=true`；回答已结束或会话未建立时追加失败并保留草稿。提交成功后输入框显示待处理标记，当前轮结束再按原顺序把追加用户消息写入会话历史并接在最终回答之前。Host 在本轮已消费 steer 且 inbox 为空时必须清除 `wakeRequested`，保证 `session.when-idle`、关闭和重启回放不会卡在空唤醒。

| 负责人 | 独占写集 | 共享接线 |
|---|---|---|
| 主会话 | App.tsx、chat/types.ts、task*.ts、useChatRuntime.ts、sqliteStorage.ts、settings*.ts、窗口相关文件、Office 导出、CI、文档 | 所有共享类型、应用接线、最终集成 |
| 备份 worker | backup.rs、database.rs、storage_paths.rs、storage_cmds.rs、新 storage maintenance 模块及 Rust 测试 | 需触及知识/会话写入口、lib.rs/Cargo.toml 时先报告精确改动，由主会话分配后写；Rust 测试由该 worker 与主会话串行运行 |
| 调度 worker | useScheduledTasks.ts、新 cron/调度状态模块及其测试 | types.ts/App.tsx/API 签名先提出由主会话接线；不修改通用 sqliteStorage |
| 知识 worker | ChatMessage.tsx、知识引用独立组件及测试、新独立样式 | 不改 App.tsx、chat/types.ts 或已有共享 styles/chat.css |

集成顺序：冻结接口 → 各自局部测试 → 主会话接共享类型与 App → 全量验证。发现超出写集的修改先交接，不并发改同一文件。

## 2. 分阶段实施与验收

### P0 基线和可靠性
- [x] T01：记录当前测试基线并保留原有修改。
- [ ] T02：窗口布局队列/显隐竞争测试已具备；Windows 原生交互和多屏 DPI 实测仍待人工。
- [x] T03：存储拒绝后状态可见，恢复后重试成功；旧值重试不能覆盖新值（sqliteStorage 故障注入测试及保存状态提示组件接入）。
- [ ] T04：真实临时 SQLite + JSONL 备份恢复、加密/校验/越界/非空目标及 SQLite+JSONL 并发操作排空测试通过；应用写入口持有维护门。普通目录迁移及非空目标保护、路径重写、配置文件原子替换失败注入测试通过；进程中断与应用重启仍待补验。

### P1 任务与交付
- [ ] T05：cron 不同周期、禁用、首次启动、补触发、异常投递、重复 effect 与手动重试自动化测试已具备；native notify Promise 的权限拒绝/发送失败测试通过；操作系统实际通知仍待人工确认。
- [ ] T06：取消/失败/启动恢复终态及部分输出快照已有测试；继续入口由用户主动发新消息，不重放旧工具。完整 UI 端到端仍待人工。
- [x] T07：正常回复通过、空结果和失败工具不会假完成；导出失败由后端错误明确返回。
- [ ] T08：知识引用预览/定位、失效及空命中提示有组件测试；真实资料生命周期仍待人工验收。
- [ ] T09：DOCX/XLSX/PPTX 生成与独立解析、覆盖/失败原子性测试已通过；系统 Office 打开/渲染/定位仍待人工。

### P2 发布与资料
- [x] T10：配置读取入口统一，读取时清理旧字段；前端类型检查通过。
- [x] T11：CI 含 TypeScript、Vitest、Agent Host sidecar、Rust tests、前端及桌面构建；提交 `14f23a5` 的 Apple Silicon / Intel 双 job 已在 run `42467041924` 全绿，并完成 DMG 挂载、架构与 codesign 检查。
- [x] T12：README、HANDOVER、IMPL 按代码与本轮测试证据校准；原生手测项明确保留未验收。

## 3. Release Gate

阶段通过只代表该项完成。整体完成需 T01–T12 全部有对应证据：类型检查、前端测试、Rust 测试、构建，以及原生窗口/Office 产物等实际验证。Mock 测试证明契约，不代替原生交互实测。无法在本机验证的 macOS/多屏事项保持待验证，不声明整体完成。

## 4. 执行证据

- 初始基线：pnpm test 通过，66 文件 / 729 用例，33.98s；Rust 尚未运行。
- 2026-10-26：接入任务历史队列化持久化，三条任务执行入口保存 running/terminal 快照；启动 hydration 完成前不写空历史；前端 owner 窗口使用独立 history key。
- 2026-10-26：调度接入主窗口限定、系统通知权限投递和指定会话选择/草稿投递；不支持/拒绝时返回可见失败。
- 2026-10-26：存储/知识库 Tauri 命令、知识后台 worker、附件快照、文件编辑/撤销、Office/Markdown 导出和一次性/持久 Shell 调用持有 maintenance operation guard；备份导出/恢复持有 maintenance exclusive guard；恢复验证空目标及与当前数据根的父子关系。测试确认 SQLite 与 JSONL 同一在途操作完成后备份才开始。
- 2026-10-26：`pnpm exec tsc --noEmit` 通过；`pnpm test` 通过，73 文件 / 809 用例；`pnpm build` 通过（含既有 chunk/import 警告）；`cargo test --lib -- --test-threads=1` 通过，154 passed / 1 ignored。
- 2026-10-26：补任务历史 hydration/中断恢复、调度 readiness 门与失败提示、模型断网/取消后 partial-output 保留测试。
- 2026-10-26：加入 Tauri 官方通知插件；备份范围包括 SQLite、knowledge_files、chat-sessions、pasted-attachments、persona、fallback-workspace、tool-output、clipboard_cache；SkillHub 用户级安装目录和仓库内宠物资源不纳入用户数据备份。原子写数据根配置，恢复成功提交后旧进程数据根固定；知识后台 worker 与写入入口纳入维护门。
- 2026-10-26：生成 DOCX/XLSX/PPTX fixture 后用 `python-docx`、`openpyxl`、`python-pptx` 独立解析通过；原生 Office 打开/渲染仍待实测。
- 2026-10-26 本轮回归：前端 `pnpm exec tsc --noEmit` 通过、`pnpm test` 76 文件 / 818 用例通过、`pnpm build` 通过（Vite chunk/import 警告）；Rust `cargo test --lib -- --test-threads=1` 157 passed / 1 ignored。`cargo fmt --check` 未运行成功：本机 stable toolchain 未安装 rustfmt 组件。
- 2026-10-26：普通更改存储位置与恢复默认位置共用维护门下的 SQLite 快照和全目录复制、内部路径重写、空目标校验、同卷 staging 发布；待重启期间禁止再次切换。`cargo test --lib -- --test-threads=1` 163 passed / 1 ignored，`pnpm exec tsc --noEmit`、`pnpm test`（76 文件 / 818 用例）及 `pnpm build` 均通过。配置失败注入仅覆盖路径层回调，尚非真实配置文件写入失败的应用级测试。
- 2026-10-26：真实临时配置文件的原子替换失败注入通过：旧配置字节不变、临时文件清理；Rust 全量测试 164 passed / 1 ignored。通知插件前端/Rust minor 版本原为 2.7/2.4，Tauri 打包预检拒绝；前端精确锁定到 2.4.0 并以 `pnpm install --frozen-lockfile` 验证。当前代码 `pnpm tauri build --ci` 在 Windows 成功生成 MSI 和 NSIS（均未签名）；`pnpm test` 仍为 76 文件 / 818 用例。macOS workflow 对当前未提交代码仍待 runner 实测。
- 2026-10-26：Windows 产物核验：MSI 55,283,712 字节，SHA-256 `5178D6066D5CF81CD42BB1F3D2103B4680F402BE2F790596411BAD8C73C4D7EB`；NSIS 52,419,068 字节，SHA-256 `1ADCE08554A3ADE0777490FF6D4A90969FA349F1D51AC9EEFF6AD13064B93FEB`。本次生成的 `omni.exe` 启动后进程存活且 Windows 报 Responding，随后终止测试进程；安装器实际安装、数据目录迁移重启及 UI 交互仍需单独验收。
- 2026-10-26：发现 Tauri 通知插件 `sendNotification()` 类型为 `void` 且其 JS shim 对 native invoke 不 await；已改为 await `invoke("plugin:notification|notify")`，这样真实 native error 才会进入调度失败状态。补权限拒绝、native invoke 失败及成功测试。`pnpm test` 77 文件 / 821 用例、`pnpm exec tsc --noEmit`、`cargo test --lib --locked -- --test-threads=1` 164 passed / 1 ignored 均通过。
- 2026-10-26：针对上述通知修复再次执行 `pnpm tauri build --ci` 成功，重新生成当前 MSI（55,283,712 字节，SHA-256 `0DB479FBB2C3135DACEA1C5036033559FD469880768CD897F1F179855833A15B`）和 NSIS（52,423,732 字节，SHA-256 `E7A4DFB76459DB4900D1A884F2955307AC85E94628F51A7E90553A95648D56CE`）；release `omni.exe` 启动 smoke check 进程存活并报告 Responding。安装器安装、提醒 OS 投递与 UI/迁移重启仍未手测。
- 2026-10-26：补任务历史 sessionId 归属，重启恢复的 aborted 任务在对应会话侧栏显示状态并在会话中提示先核实外部操作、再由用户新发消息继续；不自动重放旧工具。新增 4 个 UI/存储断言；`pnpm exec tsc --noEmit` 通过，完整 `pnpm test` 78 文件 / 825 用例通过。`pnpm build` 和 `pnpm tauri build --ci` 对该改动构建成功；新 MSI/NSIS 散列详见 TestReport。完整停止/重启/继续 live 仍待实测。
- 2026-10-26：恢复默认位置由删除配置文件改为原子写入明确标记；旧版配置仍可读取，替换失败时旧配置字节不变。再次独立复跑当前工作树：TypeScript 0 错误、Vitest 78 文件 / 825 用例、Rust 166 passed / 0 failed / 1 ignored、前端构建和 Windows MSI/NSIS 打包通过；Office DOCX/XLSX/PPTX fixture 独立解析通过。随后 `pnpm install --frozen-lockfile` 退出码 0、lockfile SHA 前后相同；同步安装后 TypeScript 与 78 文件 / 825 用例再次通过。最终包散列与未验收的原生项目见 TestReport §3。
- 2026-11-08：Agent Host 已接入真实 Omni 工具链：会话级工具目录、Node SEA sidecar、Tauri 原生工具路由、UI client-tool bridge 与原有权限确认门全部接通；`pnpm agent-host:smoke` 在真实 sidecar 上完成 16 events、2 次模型调用及重启回放。
- 2026-11-08：提交 `14f23a5` 本地全量回归：TypeScript 0 错误、Vitest 102 文件 / 978 用例、Rust 182 passed / 1 ignored；Windows `pnpm tauri build --ci` 重新生成 MSI/NSIS，release `omni.exe` 启动 smoke 显示主窗口响应且 Agent Host sidecar 随主程序关闭退出。
- 2026-11-08：提交 `14f23a5` 的 macOS run `42467041924` 在 Apple Silicon 与 Intel 两个 runner 全绿；CI 前置构建 sidecar，随后运行完整前端/Rust/Seatbelt 测试、DMG 构建、挂载、架构和 codesign 检查。workflow 已新增 DMG 文件名、字节数与 SHA-256 的 Step Summary 证据。
- 2026-11-08：Agent Host 运行中追加输入闭环完成。协议、sidecar 与运行时支持 `session.steer`（含图片）；ChatInput 在生成中同时提供“追加到当前回答”和“停止”入口，成功显示待处理标记，失败保留草稿；每次 Host turn 等到 `when-idle` 后才收口，避免迟到 steer 的第二个 turn 丢失。修复 steer 已消费后 `wakeRequested` 残留导致的 `session.when-idle` 卡死。
- 2026-11-08：追加输入验证：定向 34 用例、完整 `pnpm test` 102 文件 / 989 用例、TypeScript 与 `pnpm build` 通过；真实 sidecar smoke 完成 22 events、3 次模型调用，并验证 steer、重启回放和删除。
- 2026-11-08：当前工作树 `pnpm tauri build --ci` 通过并生成 MSI 88,596,480 bytes（SHA-256 `E18A239EDDD49E338A67165C5ACD1372E7DCF9352719420A06CBA2FC0762F609`）与 NSIS 75,117,336 bytes（SHA-256 `AD5FB6ABFC8639C9891203FF93C5ABB9DECC349F05066A6BFE5DCF7CD7835C81`）；release `omni.exe` 启动后 Responding、窗口标题 `Omni`，关闭主窗口后进程退出且无残留子进程。完整 UI 手测仍未执行。
- 待完成：多屏 DPI/窗口交互实机验收；Office 系统打开/定位、公式实际重算与原生渲染验收；继续/中断完整 UI 集成验收；备份迁移进程中断及真实应用重启切换。备份不涵盖外部工作区/SkillHub/pet 资源；人为脱离 Shell 的后台进程不受命令生命周期锁约束。
- 计划评审：Beauvoir 独立复核 [SPEC-OK]；已补备份维护边界、提醒投递契约、中断继续和独立写集。用户已授权按八项范围实施。
