# Tauri 透明窗口浮层菜单闪烁 · 业界调研报告
> 主题：Windows WebView2 透明桌面悬浮窗动态 geometry 与菜单呈现
> 目标：判断 Omni 当前架构是否有结构性风险，比较低风险修复与替代窗口架构
> 分支：PENGY/macos-build-verification
> 日期：2026-11-08
> 状态：调研报告；仅基于静态代码与公开资料，不包含代码变更或运行时验证

## 0. 证据标注约定

- **有据**：仓库代码、官方文档、项目源码/README、许可证文件或 GitHub API 页面可直接支持。外部结论在参考链接中给出 URL。
- **【分析】**：由多个已标证据推导的架构判断，不等同于已在 Omni 运行时复现的根因。
- **未知**：公开文档或当前静态材料不足以证明，必须由指定 runtime instrumentation 或实验回答。
- 开源项目的 star、pushed_at、open issue 数为 2026-11-08 查询 GitHub API 的快照，反映项目可见度/近期提交，不等于质量、维护响应或商业适用性。
- “有源码项目”表示仓库内可查看源码及许可证；本报告只分析可公开检视部分，不将第三方项目的实现当作 Tauri/WebView2 的规范性证据。
- 遵守本次只新建一份研究报告的范围，因此未按 research skill 常规流程修改 `docs/README.md` 登记 doc map；本文件本身是唯一工作区变更。

## 1. 执行摘要

**判断：现有“同一透明 WebView 动态 resize + 内嵌菜单”不是必然闪烁，但确实把点击路径绑定到多阶段原生 geometry 和 WebView 重绘；在边缘侧切换时具有结构性时序风险。** Tauri JS API 将 `setPosition`、`setSize` 暴露为独立 Promise，没有公开的窗口 bounds 原子事务；Tauri Windows 配置提供 `noRedirectionBitmap`，官方说明其可帮助避免“创建透明窗口”白闪，但没有承诺解决运行时 resize/reposition 的帧同步。[10][11] WebView2 官方 `SetBoundsAndZoomFactor` 原子性只针对 WebView controller 的 Bounds 与 ZoomFactor，不包含 Tauri 顶层 HWND 的位置、尺寸、z-order；不能把它理解为本问题的 atomic geometry 能力。[14]

**更好的路线排序：** 先做低风险的 geometry effect 去重/依赖收敛和测量；然后用固定大透明宿主原型验证“只切 DOM visibility”是否消除闪帧；若透明宿主命中测试、窗口输入区域或多屏边界使固定宿主不可接受，再迁移为独立 menu WebViewWindow。原子化/隐藏后改几何再显示可作为短期对照，但仍会 resize，同窗内的重绘等待不构成可靠的 paint-complete 屏障。继续堆延时、fade 或 setAlwaysOnTop 重试排最后。

当前代码还有一个比“边缘瞬移”更值得优先排查的非必要触发面：geometry effect 依赖 `isCompactModelOpen`、`isCompactAppearanceOpen`、`isCompactReplyLoading`、回复/宠物状态等。[useCompactWindowController.ts:985-1009] 点击时将 model/appearance panel 关闭是同一批状态提交，这本身会重跑 effect；后续 hover 打开子面板也可能再次进入 geometry effect。只要 effect 将视觉状态变化与原生几何副作用绑在一起，即使比较后最终尺寸未变，也要额外 IPC 读取并维护取消/队列语义。**【分析】第一期应先确定 hover 与主菜单首次打开是否触发重复读取/写入，再收窄为“目标原生 geometry 变化”触发写操作；这比迁移窗口的风险低得多。**

根因等级：**【分析】高概率为 geometry 更新与首帧呈现的阶段性交错，React 左右菜单 CSS 本身不是当前首要嫌疑；已确认具体 native 空帧、React unmount/remount 或 blur-close 仍未知。** 是否迁移独立窗口：**当前不建议立即迁移；应将固定宿主列为优先替代原型，独立 menu window 列为第二架构方案/回退。若 instrumentation 显示闪帧严格随主窗口 resize 出现，固定宿主原型又无法满足输入与跨平台要求，则迁移独立菜单窗口值得投入。**

## 2. 现状与痛点

### 2.1 打开菜单与几何变更顺序

1. `openCompactMenu()` 在 [useCompactMenus.ts:510](../../src/hooks/useCompactMenus.ts) 同步拿 opening lock、标记交互并抑制 blur；随后依序 `raiseCompactWindow()`、读取 scale factor、窗口位置/尺寸和 cursor，再计算 side/anchor/position。[useCompactMenus.ts:516-558]
2. 等异步计算完成后，React 在同一回调内批量提交 side、submenu side、menu position、open 状态，并关闭 model/appearance/query 子状态。[useCompactMenus.ts:562-571] 这避免了 side 单独先提交造成的一轮额外 reposition，但不能让随后触发的 effect 和原生窗口操作成为同一个事务。
3. geometry effect 进入串行队列，依次 await `scaleFactor`、`outerPosition`、`outerSize`。[useCompactWindowController.ts:834-854] 普通外观根据菜单侧和锚点算新的窗口 x，比较目标尺寸。[useCompactWindowController.ts:904-955]
4. 如果位置/尺寸需要变化，`setPosition` 与 `setSize` 分开调用并以 `Promise.all` 等待；之后另行 `setAlwaysOnTop(true)`，再写入 React 的 `visibleCompactMenuSide` 与 `settledNormalGeometry`。[useCompactWindowController.ts:943-969] `Promise.all` 只表示两个调用各自完成，不承诺操作系统合并成一个原子窗口帧。
5. 另一个 effect 依赖列表显式包含菜单开关、model/appearance panel、reply loading、reply、pet thoughts/queue/placement 等状态。[useCompactWindowController.ts:985-1009] 点击 handler 会关闭 model/appearance 状态；菜单项 hover 打开子面板亦会改变这些依赖。即使普通外观本轮 geometry 数值未变化，effect 也会重新读取 native scale/position/size。应进一步审计是否形成了多轮 effect/写入，而不假定每次依赖变化都实际调用 setPosition/setSize。

### 2.2 DOM 和 CSS 的可见条件

- 普通菜单只有 `isCompactMenuOpen && isNormalCompactGeometryReady` 才挂载。[CompactWindow.tsx:602-606]
- `isNormalCompactGeometryReady` 由 settled width/height/side 与当前目标完全一致判定。[useCompactWindowController.ts:1251-1256] 这证明原生命令完成后才允许普通菜单 DOM 出现，但它不是 WebView compositor 已提交首个可见帧的信号。
- `CompactMenu` 的 ready 样式只切 opacity/visibility，没有菜单入场动画。[CompactMenu.tsx:119-122] 常规菜单是 DOM 元素，CSS left/right 定位；左侧菜单以 `right: calc(100% - 20px)` 排列。[compact.css:735-766] CSS 不会自行移动 HWND。
- `.compact-shell` 是覆盖 WebView viewport 的透明布局容器；菜单侧变化会通过 shell 的 flex 对齐改变球在 viewport 内的位置。[compact.css:1116-1154；CompactWindow.tsx:281-291] 若 React side class 先于 native window x/width 更新完成，理论上有中间视觉态，但当前逻辑以 visible side 延后 class 切换来缓和。

### 2.3 Native window 配置与接口边界

- Tauri 窗口配置是 `decorations:false`、`transparent:true`、`shadow:false`。[tauri.conf.json:15-28] 当前没有声明 `noRedirectionBitmap`。
- compact 窗口创建为透明、无装饰、always-on-top、`visible:false`、`focus:false`，建好后单独设置 Chrome、size/position；这是启动创建流程的隐藏初始化，并非每次展开的 geometry transaction。[window.ts:770-823]
- capabilities 已授权 show/hide、set-size、set-position、set-always-on-top、create-webview-window；当前没有给新建窗口独立 capability scope 的证据。[default.json:5-37]
- 官方配置页列出 Windows 专用 `noRedirectionBitmap`，映射 `WS_EX_NOREDIRECTIONBITMAP`，并说对透明窗口创建白闪可能有帮助；文义不覆盖窗口 runtime resize 的中间帧。[10] Tauri Window JS API 暴露分立 position/size/hide/show 等接口，未见 `setBounds`/`setGeometry` 原子接口；因此“单次 API 调用解决 move+resize 两次帧”不是当前公共 API 的能力。[11]

### 2.4 问题判断与待证假设

- **【分析】高概率**：点击侧向菜单时，React 先提交新的菜单逻辑态，geometry effect 再完成多次 IPC/native 操作；WebView2 对改变尺寸的 controller/window 需要更新可呈现内容。命令 Promise 完成只说明调用返回，不证明 DWM 已展示期望 DOM 帧。透明窗口扩大暴露了新区域，透明宿主/合成与网页绘制不同步可能显示短暂空态或旧态。
- **【分析】同样需要排除**：blur/visibilitychange 监听会在菜单打开时关闭菜单；代码有 `suppressCompactBlur`，但其截止时间、native move/resize 引起的焦点/visibility 事件及 `closeCompactMenuNow()` 是否被触发必须打时间戳，不能凭 GIF 定性。[useCompactWindowController.ts:1102-1119]
- GIF 是低帧率采样，观察到菜单先出现、随后消失、再出现且位置大致一致。该表现比“菜单先绘在错误最终位置再移动”更符合 visibility/lifecycle 闪断，但 GIF 帧无法区分 DOM unmount、CSS visibility、WebView 空帧和 native hide。
- **未知**：本次没有在目标机器以 ETW/PresentMon/Win32 消息跟踪捕获 DWM/WebView2 帧事件；也未执行禁 DOM resize、固定宿主、独立窗口对照实验。因此不把 DirectComposition/重定向位图断言为已证实的 Omni 唯一根因。

### 2.5 运行时实验与 instrumentation（研究设计，不是实现变更）

同一条 trace 使用单调时钟 `performance.now()`、点击 correlation id，前端日志与 Rust/Tauri 日志尽量统一事件 id；native 事件墙钟可另记，但不能直接和 performance 时间戳相减。

| 层 | 时间点/数据 | 用途 |
|---|---|---|
| 点击与打开回调 | click、open start、opening lock、raise start/complete、scale/position/size/cursor 各自 start/complete、side resolved、React open commit | 确认菜单打开前置 IPC 的耗时及是否多次进入 |
| geometry effect | render/effect start、所有依赖快照、run id/cancelled、native before x/y/w/h logical + physical、DPI、monitor id、target、位置/尺寸命令发出与完成、always-on-top 完成、settled commit | 证明每次 effect 是否真有 geometry 差异，识别旧 run 覆写/重复写 |
| React/DOM | `useLayoutEffect` mount/unmount、open/side/class/ready、连续 `requestAnimationFrame`、菜单矩形/opacity/visibility；`PerformanceObserver` paint 仅作辅助 | 判定菜单是否卸载、CSS 是否重算、几何是否先后变化；paint entry 不保证屏幕合成已展示 |
| Browser/native | `visibilitychange`、window blur/focus、WebView resize；Tauri `onResized`/`onMoved` 事件含尺寸/位置；close handler 触发原因 | 识别 blur-close、多个 resized/moved 事件以及事件先后 |
| 屏幕捕获 | 高帧率录屏/逐帧采集；必要时 Windows ETW/DWM/PresentMon 与 WebView2 runtime 版本 | 把 DOM 记录与真正可见帧对应起来 |

对照组：A. 固定窗口大小，只打开/关闭菜单 DOM；B. 关闭菜单 DOM，只 resize/reposition；C. 同窗 resize，先 hide、写完几何后等至少一帧再 show；D. 固定大透明宿主，菜单只切 visibility；E. 独立 popup window 预先创建并在定位/内容 ready 后 show；F. 暂时禁用 geometry effect 中与常规菜单无关的 hover state 依赖；G. 单独禁用 `setAlwaysOnTop` 重写。覆盖菜单左右方向、距离屏幕边缘 365px 附近、100%/150% DPI、多屏跨 DPI、不同 WebView2 runtime 与 GPU。成功判据应为 100 次重复中无错误位置帧、无单帧消失、球屏幕锚点不漂移；记录 P50/P95 click-to-visible latency。

## 3. 业界方案分类对比表

公开项目样本不是同类交互的统计普查，而是用于识别成熟桌面程序怎样管理窗口边界。桌面 launcher 通常本身就是一个独立搜索窗口；widget/预览工具则倾向每个功能由独立顶层窗口或宿主承载。没有足够证据声称主流悬浮球普遍采用某一种方案。

| 项目 | 框架/架构（源码证据） | 许可证 | 活跃度快照/边界 | 对 Omni 的参考价值 |
|---|---|---|---|---|
| [Flow Launcher](https://github.com/Flow-Launcher/Flow.Launcher) | Windows WPF launcher；MainWindow 作为独立搜索/结果面板，由热键唤起，不是从托盘球动态扩大同一个窗口。源码含 `MainWindow.xaml`、C# code-behind 与窗口管理代码。[19][20] | MIT | 约 15.9k stars；2026-11-07 pushed；约 310 open issues。只支持 Windows；launcher 不是透明球菜单。 | 借鉴独立宿主、显式 show/hide 与快捷键窗口生命周期，不直接移植 WPF UI。 |
| [PowerToys Run](https://github.com/microsoft/PowerToys/tree/main/src/modules/launcher) | PowerToys 模块内的 WPF `PowerLauncher`，具独立 `MainWindow.xaml`、`MainWindow.xaml.cs` 与 LauncherControl。[21][22] | MIT（模块 LICENSE） | 仓库约 140k stars、约 8k open issues，2026-11-07 pushed；全仓统计不代表 Run 子模块缺陷率。Windows only。 | 证明成熟 Windows launcher 将搜索 UI 设为独立窗口和独立模块；Omni 若做独立 menu window，可从窗口 owner/通信解耦学习。 |
| [QuickLook](https://github.com/QL-Win/QuickLook) | Windows WPF；托盘/快捷键管理器与 `ViewerWindow` 分离，预览本身为专门窗口，而非向 tray window 扩大 DOM。[23][24] | GPL-3.0 | 约 25.7k stars；2026-11-03 pushed；约 239 issues。Windows only；GPL-3.0 不适合直接复制代码到不同许可项目，须法务审视。 | 多窗口管理器、预览窗口按需显示的参考；与菜单相比内容更重，性能和焦点细节不能等同。 |
| [Rainmeter](https://github.com/rainmeter/rainmeter) | 原生 C++/Win32 桌面 customization/skin host；皮肤由宿主窗口持有，桌面部件不通过每次打开时把小 HWND 扩成宽窗实现。[25] | GPL-2.0 | 约 6.1k stars；2026-10-27 pushed；约 32 issues。Windows only；皮肤引擎与 WebView 的布局/命中模型差异很大。 | 固定或长期存在的桌面宿主、逐窗输入/鼠标穿透设计可借鉴；不建议照搬其皮肤运行时。 |
| [Wox](https://github.com/Wox-launcher/Wox) | 仓库自述跨平台 launcher；GitHub 语言统计以 Go 为主，同时含 C++/Objective-C/JS/TS 等，主体验是独立 launcher，而不是托盘球菜单扩窗。[26] 具体各平台窗口实现必须按平台源码继续拆读。 | GPL-3.0 | 约 27.6k stars；2026-11-07 pushed；API 返回 3 open issues。许可证要求及平台实现差异需要单独评估。 | 说明跨平台 launcher 通常抽象“显示 launcher 窗口”，不代表其底层共用同一 HWND 或可以直接解决透明浮层。 |

**分类归纳：**

- 同窗动态 resize + 内嵌菜单：实现状态共享简单、内存较省；但透明窗口下把输入、布局、DPI 锚点、原生尺寸和重绘绑在一次点击上。此类方案在普通主窗/网页菜单常见，不足以证明适合桌面浮层。
- 固定大透明宿主 + 内嵌菜单：省掉打开菜单时 HWND 尺寸/位置变更，是同一 WebView 内最直接隔离 redraw 风险的方法；代价是透明区域鼠标命中、桌面其他应用点击、拖拽、多个 monitor 工作区和透明大矩形性能。
- 独立 popup/WebViewWindow：launcher/预览类软件的常见边界。宿主位置与大小稳定，菜单 WebView 可独立创建/预热/显示；代价是多窗口状态同步和焦点/outside click 生命周期。
- 原生 menu：Win32 `TrackPopupMenu` 或平台菜单能避开 WebView 首帧，但样式、复杂子面板、输入体验、跨平台视觉一致性明显受限；适合简单命令，不适合 Omni 当前丰富的 React 菜单。

## 4. 深入标杆（5 个）

### 4.1 Flow Launcher：独立 WPF launcher

**有据：**仓库 README 定位为 Windows app/file launcher；solution 中有独立 `Flow.Launcher` WPF 工程，包含 `MainWindow.xaml`、`MainWindow.xaml.cs`、窗口相关 helper，MIT license。[19][20] 该窗口呈现搜索结果，不是一个大透明桌面命中层；本次观察不将它归类为固定透明宿主。

**限制/可借鉴：**与 Omni 的球锚点和菜单交互差异很大，能借鉴的是把“唤起/隐藏窗口”定义成清晰生命周期；不能由其存在推导 WPF 不闪或 Win32 resize 原子。

### 4.2 PowerToys Run：模块化 WPF launcher

**有据：**源码模块 `src/modules/launcher/PowerLauncher` 独立包含 App、MainWindow、LauncherControl、services、view model；模块自身有 LICENSE，顶层 PowerToys 仓库也为 MIT。[21][22] 结构上是热键唤起的独立 launcher window，不是多个控件通过一个 tray HWND 实时 resize。

**限制/可借鉴：**仅 Windows；PowerToys 仓库 issues 总数极高但覆盖几十个模块，不能作为 Run 窗口质量指标。可参考模块隔离/显示隐藏/全局快捷键编排，不能复用其 Windows 专属 UI。

### 4.3 QuickLook：托盘控制器 + 独立预览窗口

**有据：**项目 README 定位为 Windows Quick Look；源码有 `TrayIconManager`、`ViewWindowManager`、`ViewerWindow.xaml`/code-behind 和 `FocusMonitor`，说明托盘管理与实际预览窗口职责分开。[23][24] GPL-3.0。

**限制/可借鉴：**预览窗口内容较重、按需出现，和紧贴小球的菜单尺寸/焦点语义不同；仅作为窗口所有权、焦点监控、按需显示的参考。GPL-3.0 意味着应复用设计思想而非直接引入代码。

### 4.4 Rainmeter：原生桌面宿主/皮肤模型

**有据：**README 和 C++ 源码将 Rainmeter 定义为 Windows 桌面定制工具，拥有 application/skin 运行时；许可 GPL-2.0。[25] 其公开模型是长期运行的桌面宿主承载皮肤部件，和“点球后 resize 透明 HWND”不是同一类架构。

**限制/可借鉴：**只有 Windows；皮肤更新、鼠标穿透/输入命中由原生代码控制，DOM/backdrop-filter/WebView2 的渲染行为不可类推。可借鉴固定宿主与输入区域分离的概念，不建议切换到 Rainmeter 式整个原生绘制系统。

### 4.5 Wox：跨平台 launcher 边界

**有据：**仓库 README 定义为 cross-platform launcher，GitHub 语言统计显示仓库含 Go、C++、Objective-C、JavaScript/TypeScript 等源码；顶层为 GPL-3.0。[26] 它将 launcher 作为独立可显示的交互面，而不是证明跨平台应用必须统一一个透明 HWND。

**限制/可借鉴：**其跨平台窗口代码需要按 macOS/Windows 分别检查，不能从 README 推导同一窗口机制；统计值受仓库合并/重构影响。对 Omni 的价值是提醒 menu popup 必须有平台适配层，不能把 Windows WebView2 规避方案直接设为 macOS 唯一实现。

**行业样本的结论：**【分析】launcher/预览软件更常把可聚焦的内容面当作独立顶层窗口管理；桌面 widget 软件更偏向长期宿主和细化输入区；没有证据说明复杂菜单普遍使用原生菜单。对 Omni 最适合的不是照抄某个标杆，而是先固定“球宿主”和“菜单可视区域”的几何关系，再选择宿主是否同窗。

## 5. 针对当前架构的推荐

### 5.1 业界与 Omni 逐项对比

| 维度 | 样本项目/常见做法 | Omni 现状 | 建议 |
|---|---|---|---|
| 窗口职责 | launcher/search/preview 多为独立窗口；桌面 widget 可长期宿主 | 小球和菜单同一透明 WebView，打开即扩大约 462px 并改位置 | 第一轮先保留架构但去掉无关 geometry effect 重跑；对照验证固定宿主 |
| 原生 geometry | 独立 launcher 多为初始化定位后 show/hide，交互时不调整宿主到新宽度 | `setPosition`、`setSize`、`setAlwaysOnTop` 多阶段调用 | 把 geometry 写入集中为“目标矩形确实变化才写”；side/ready 与窗口命令写日志 correlation id |
| 菜单渲染 | WPF/Win32 组件或独立 launcher view | React DOM、CSS 定位、backdrop-filter | 保留 DOM 与现有视觉；先不换原生菜单，也不继续追加 CSS 延迟 |
| 透明合成 | Win32 app 自行控制 HWND 与绘制策略；WebView2 有独立 background/composition 合同 | Tauri transparent + WebView2，未声明 noRedirectionBitmap | 在目标 Windows runtime 单独 A/B `noRedirectionBitmap`；仅用作透明创建相关变量，不承诺治 resize |
| 输入/外部关闭 | launcher 借助 focus/快捷键；widget 可配置鼠标穿透 | blur/visibilitychange 会关闭菜单，主窗还有 suppress blur | 先记录关闭原因与时间，防止把 blur-close 错诊成 renderer 闪帧 |
| DPI/多屏 | 各项目通常平台专用，窗口管理负责 monitor 与焦点 | 已有 physical/logical 转换和 monitor clamp | 复用现有坐标工具；任何固定宿主或 popup 原型必须以物理坐标目标屏验证 |

### 5.2 核心思想与方案排序

1. **低风险先修（建议立即验证）**：将普通 compact 的几何副作用从菜单子面板、hover、reply 等纯视觉状态触发链分离。理想的依赖只反映原生目标 `x/y/width/height`、DPI/monitor、drag guard 和确实影响宿主矩形的状态；对相同 target geometry 做幂等去重。重点查看 `isCompactModelOpen`、`isCompactAppearanceOpen` 在 effect deps 的影响，不因 hover 直接执行一轮 native read；将菜单 DOM 是否显示与 geometry writer 解耦。此为小范围实现调整建议，需由上述 trace 先证明确有重跑。
2. **首选替代原型：固定大透明宿主 + DOM 菜单**。悬浮球的 screen position/viewport anchor固定，预先分配足够菜单宽高；展开只提交 side/visibility，不调用 setSize/setPosition。Windows 需验证窗口透明区域是否仍拦截桌面点击；可通过 host hit region / native passthrough 或分区窗口策略缩小交互区域。若 Tauri 当前接口无法表达精细 hit-test region，不能假设 `setIgnoreCursorEvents` 可以与局部交互同时满足。
3. **第二替代原型：独立 menu WebViewWindow**。球窗保持原尺寸；菜单窗按已知尺寸和 side 计算出一次目标矩形，先创建或复用隐藏窗、设置透明/位置/尺寸、等前端 ready 后 show。用轻量事件/命令同步 `open/side/selection/close`；主窗仅做球锚点与业务状态。对频繁打开应复用预热窗口，避免每次启动新 WebView 冷首帧。此方案降低 resize 触发面，但没有证明 WebView2 首次 show/透明绘制没有自身闪帧，仍需 A/B。
4. **短期事务式规避**：坚持现有同窗时，可以试验 hide → 设置 position/size → 等 geometry 和 DOM ready → show。Tauri 有 hide/show，不代表 GPU paint/DWM present 完成；额外隐藏可能制造可见空档，且 hide/show 可能影响 focus 与 topmost，因此只做对照，不把定时延迟当正确性保证。
5. **不优先：原生菜单/重写 Win32 host**。复杂 React 菜单含多级面板、搜索/业务入口及跨平台目标，使用原生 popup 会造成视觉和交互分叉；完全自建 HWND/DirectComposition 则把 Tauri/WebView 的责任下沉到平台插件，维护与打包成本明显增加。

### 5.3 组件图

```text
方案 A（先验证，固定宿主）
Tauri compact HWND/WebView（稳定最大 viewport）
  ├─ React 球：固定 screen anchor
  └─ React 菜单：side/visibility/DOM paint，无 native resize

方案 B（若 A 输入区域不满足）
Tauri compact HWND/WebView（只负责球与锚点）
  └─ menu controller（open/close/side/selection）
       └─ 复用的 menu WebViewWindow（目标 bounds 后 show）

同窗 resize 现状（保留作基线）
React open+side → async geometry effect → setPosition + setSize
                → setAlwaysOnTop → settled React state → DOM mount/visible
```

### 5.4 固定宿主与独立菜单窗的关键权衡

| 因素 | 固定大透明宿主 | 独立 menu window |
|---|---|---|
| resize闪烁 | 点击路径不 resize，最能隔离本问题 | 球窗不 resize；菜单窗 show/首绘仍需验证 |
| 状态与通信 | 同一 React tree，最简单 | 多窗口 event/command、初始化 ready、异常关闭协调 |
| 焦点/外部点击 | 大透明 HWND 容易拦截它覆盖区域内的桌面输入；需精确 hit-test/passthrough | 自然得到窗口失焦/外部点击信号，但焦点策略可能导致菜单自动关闭或激活其他窗 |
| DPI/多屏 | viewport 最大尺寸须针对 monitor/work area；移动球可能要重算布局而非 resize | 可按 monitor scale 将独立矩形定位；要避免逻辑/物理坐标混用、目标屏 DPI 错基准 |
| 打包/权限 | 单窗 capability 简单，Windows 透明窗口/命中区域可能需 Rust 扩展 | 新 window label 与 capability allowlist、关闭/创建命令、平台配置均要维护 |
| 内存与启动 | 一份 WebView、DOM 常驻较省；大 viewport 影响合成面积 | 多一份 WebView 通常有更高内存和初始化成本；复用隐藏窗可摊销 |
| macOS 可移植性 | 同窗 DOM 行为易共享，但大窗口尺寸/透明输入依然有平台差异 | Tauri 多窗可用，但 NSPanel/非激活 popup 语义可能需平台 native 插件 |

### 5.5 与现有系统衔接

- **复用**：`compactMenuGeometry.ts` 中的 side、菜单锚点、monitor 工作区裁剪；`resolveCompactBallEdge` 与现有 physical/logical 转换；`CompactMenu` React 视图与业务 action；window label/capability 命名约定。
- **先替换/拆分**：geometry effect 的依赖输入与 native writer 的边界。把纯菜单面板展开状态从“计算/写宿主窗口 geometry”的触发依赖移走，除非运行时几何确实发生变化；`settledNormalGeometry` 不再被当成 paint ready 的证据。
- **固定宿主原型才改变**：定义宿主最大边界、球在 viewport 中的固定锚点、边缘方向下菜单内容裁剪；实测透明空白区域能否点击穿透，以及 Win/macOS 上系统桌面是否可访问。
- **独立窗口原型才改变**：新建 `compact-menu` label/window，受控创建/复用；传递 `openId`、screen anchor、side、monitor scale；只让一个 controller 接受 close/selection 回执；新窗口 capability 按 label 最小授权，不能简单把所有高权限加入全局 default。
- **暂不动**：compact 菜单业务 React 子组件、菜单项数据、原有位置计算；不为该问题重写整个 Tauri 应用，不将 WebView2 专属配置直接施加于 macOS。

## 6. 分阶段升级路径与风险

### Phase 0：建立可判定证据（只观测）

- 目标：按 2.5 增加临时诊断构建或调试器 instrumentation；记录 geometry effect 依赖变化与真正的 setPosition/setSize 次数，打出 close reason、window blur/visibilitychange、React mount/unmount、resized/moved。
- 收益：区分 native 空帧、React 生命周期闪动、blur-close、effect 重跑；避免误把单帧闪烁归因为 CSS。
- 风险：日志改变时序/日志量干扰体验；用限量、同一 trace id、仅 debug 构建，确认指标后撤除。
- 回归判据：至少覆盖左右 side、屏幕边缘、DPI、多屏各 100 次；能将每次可见闪帧关联到一个明确阶段，且球锚点坐标可验证。

### Phase 1：低风险收敛 geometry writer（首期最小改动）

- 目标：去掉纯 hover/submenu open/close 对 native geometry pipeline 的无谓触发；只在目标 bounds/anchor/monitor 真变时写；避免菜单状态写入被错误当成 paint complete；保留现有菜单 React 树及球锚点逻辑。
- 收益：减少 IPC 往返与队列取消/重读次数，降低 stale geometry 和 blur suppression 时间窗错配的概率；不增加 WebView、不扩散 capability。
- 风险：宠物外观确实会由 thought、placement、collapse 改变 viewport geometry，不能一刀切删所有 deps；需拆分 normal compact 与 pet geometry 或生成稳定的 target geometry key。
- 回归判据：常规菜单 hover 时 setPosition/setSize 调用计数为 0；展开/关闭菜单时每个必要目标 bounds 最多一次 position/size 更新；DPI/monitor clamp 与已有宠物气泡功能不回归；100 次测试无闪帧/跳球。

### Phase 2：架构对照原型与条件迁移

- 2A 固定宿主原型：保持最大 viewport、只改变 DOM 可见性与 side；量测透明覆盖区域、桌面外部点击、拖拽命中、能耗和 DPI/工作区裁剪。
- 2B 独立 menu window 原型：复用隐藏 WebView，菜单内容 ready + bounds 已写后 show；测冷/热打开延迟、焦点/outside click、前后端通信、窗口关闭异常、内存。
- 决策门：若 Phase 1 后闪帧消失，则不迁移；若闪帧只发生在 resize 组，固定宿主消失且输入可接受，选择固定宿主；若宿主 hit-test/透明输入不能接受而 popup 组稳定，则独立窗口。若两组都闪，应查 WebView2 默认背景色/启动展示时序与 blur-close，不能继续加 delay。
- 收益：以受控实验选择架构，而不是依赖主观感觉。
- 风险：固定宿主扩大透明命中框会挡住底下应用；独立窗有焦点、DPI、窗口复用、capability、macOS NSPanel 与打包测试成本。
- 迁移判据：Win 10/11、目标 WebView2 Runtime、macOS 当前支持版本，至少双屏混合 DPI；打开/关闭 100 次无错位/空帧，外部点击行为正确，性能/内存符合产品预算。

### 风险清单

- `noRedirectionBitmap` 官方说明集中于创建透明窗口白闪；启用可能改变合成/内容呈现路径，需对当前 Tauri/Wry/WebView2 版本验证，不能作为默认修复结论。
- hide→resize→show 可能掩盖一帧但制造可见空白，且窗口焦点/z-order 会变化。
- 把 position 与 size 并行 Promise 调用不等于 Win32 同一 `SetWindowPos` transaction；Tauri 未公开把两者打包的 API。直接注入 Win32 `SetWindowPos` 会与 Wry 的 resize/事件同步冲突，需原生插件评估。
- 固定宿主透明区域的 hit-test 是最大产品风险；扩大窗口通常也扩大 WebView 接收鼠标的范围，pointer passthrough 若整窗启用会让菜单自身也失去点击能力。
- 多窗口会导致事件归属、焦点 blur、窗口创建的默认位置、目标屏 scaleFactor、能力配置更加复杂；必须复用窗口并有唯一 owner。
- 第三方参考项目许可证：Flow Launcher/PowerToys MIT；QuickLook/Wox GPL-3.0；Rainmeter GPL-2.0。建议只借鉴公开架构与交互原则，避免拷贝 GPL 源码；需按项目许可证实际文本及组织政策评估。

## 7. 参考链接

### Omni 代码（本地证据）

1. [useCompactMenus.ts](../../src/hooks/useCompactMenus.ts)：打开菜单异步顺序与 side/open 批提交，510-574。
2. [useCompactWindowController.ts](../../src/hooks/useCompactWindowController.ts)：geometry queue/write、effect deps、settled ready、blur close，834-1009、1102-1119、1251-1256。
3. [compactMenuGeometry.ts](../../src/hooks/compactMenuGeometry.ts)：菜单侧与 viewport/位置计算。
4. [CompactWindow.tsx](../../src/components/CompactWindow.tsx)：菜单 DOM mount 条件，602-606。
5. [CompactMenu.tsx](../../src/components/compact/CompactMenu.tsx)：geometry ready CSS 可见性，119-145。
6. [compact.css](../../src/styles/compact.css)：菜单定位/透明宿主样式，735-775、1116-1154。
7. [tauri.conf.json](../../src-tauri/tauri.conf.json)：transparent/decorations/shadow，15-28。
8. [window.ts](../../src/app/window.ts)：compact WebviewWindow 创建与显示配置，653-664、770-823。
9. [default.json](../../src-tauri/capabilities/default.json)：当前 window capabilities，5-37。

### Tauri / WebView2 / Windows

10. Tauri v2 config reference（Windows `noRedirectionBitmap`、transparent、show/hide）：https://v2.tauri.app/reference/config/
11. Tauri JS Window API（`setPosition`、`setSize`、`show`、`hide`）：https://v2.tauri.app/reference/javascript/api/namespacewindow/
12. Tauri issue #3674 “page flickers”：https://github.com/tauri-apps/tauri/issues/3674
13. Tauri issue #5170（透明/窗口行为相关讨论）：https://github.com/tauri-apps/tauri/issues/5170
14. WebView2 `ICoreWebView2Controller` Bounds 与 `SetBoundsAndZoomFactor` 文档：https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller
15. WebView2 `ICoreWebView2Controller2.DefaultBackgroundColor`（透明支持、白色默认值与 API 设置前 white flicker 已知问题）：https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller2
16. Win32 `SetWindowPos` flags（`SWP_NOREDRAW` 明确要求应用自行 invalidation/redraw；不是自动消除闪烁）：https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos
17. DirectComposition `IDCompositionDevice::Commit`（同设备 pending 命令批处理并原子生效；不是跨 Tauri HWND/WebView 的 API）：https://learn.microsoft.com/en-us/windows/win32/api/dcomp/nf-dcomp-idcompositiondevice-commit
18. WebView2 transparent background / composition GitHub issue 搜索入口（issue 是个案，不作规范依据）：https://github.com/MicrosoftEdge/WebView2Feedback/issues?q=transparent+flicker

### GitHub 标杆、源码与许可证

19. Flow Launcher 仓库/README/源码/许可证：https://github.com/Flow-Launcher/Flow.Launcher
20. Flow Launcher MainWindow 源码：https://github.com/Flow-Launcher/Flow.Launcher/blob/dev/Flow.Launcher/MainWindow.xaml
21. PowerToys Run launcher 模块及源码：https://github.com/microsoft/PowerToys/tree/main/src/modules/launcher
22. PowerToys Run MainWindow 源码：https://github.com/microsoft/PowerToys/blob/main/src/modules/launcher/PowerLauncher/MainWindow.xaml
23. QuickLook 仓库/README/GPL-3.0/窗口管理源码：https://github.com/QL-Win/QuickLook
24. QuickLook ViewerWindow 源码：https://github.com/QL-Win/QuickLook/blob/master/QuickLook/ViewerWindow.xaml
25. Rainmeter 仓库/README/源码/GPL-2.0：https://github.com/rainmeter/rainmeter
26. Wox 仓库/README/源码/GPL-3.0：https://github.com/Wox-launcher/Wox

### 中文摘要（约 410 字）

**根因判断：高概率是菜单状态提交、原生窗口几何调整与 WebView2 新尺寸首帧呈现分阶段交错；具体是 compositor 空帧、React 生命周期，还是 blur/visibilitychange 关闭后重开，仍未知。** Tauri 有透明窗和 `noRedirectionBitmap`，但没有公开将顶层位置、尺寸与 WebView 绘制合并为原子呈现的 API；WebView2 原子 Bounds/ZoomFactor 不涵盖顶层窗口。五个 GitHub 样本显示 launcher/preview 多为独立窗口，桌面 widget 有长期宿主模式。推荐顺序：先观测并收窄 geometry effect 依赖，隔离 hover 子面板状态；再验证固定大透明宿主；若其透明命中不可接受且 popup 稳定，再迁移独立菜单窗。首期记录 DOM/native/blur 时间线，消除非几何状态触发的原生重跑，不动菜单业务。hide-resize-show 仅作实验，CSS 延时排最后。**目前不建议立即迁移独立窗口**，以 resize 必要性和宿主输入体验作为决策门。
