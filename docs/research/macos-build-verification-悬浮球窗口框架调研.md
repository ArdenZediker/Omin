# 悬浮球与悬浮窗窗口框架 · 业界调研报告
> 主题：GitHub 上桌面宠物、浮动 AI 助手与 launcher 的实现框架和窗口组织方式
> 定位：判断 Omni 是否需要更换桌面框架，并为悬浮球菜单闪烁问题选择可验证的替代实现
> 日期：2026-11-08
> 状态：调研稿（研究 + 建议，不含代码改动）

## 0. 证据标注约定

- 带 `[编号]` 的事实来自公开仓库、仓库 manifest、源码或官方文档，链接统一列在第 7 节。
- 标注 `【分析】` 的内容是基于这些事实对 Omni 的判断，不是第三方项目的原话。
- GitHub 的 star、更新时间和 issue 数量是 2026-11-08 调研时读取的仓库元数据，只用于判断样本活跃度，不代表实现质量。
- 本次调研关注窗口生命周期、透明/置顶、拖拽、菜单和多显示器几何；不把动画渲染库本身误认为窗口框架。

## 1. 执行摘要

GitHub 上没有唯一的“悬浮球框架”。当前可见的成熟路线主要有四类：Tauri v2 + React/TypeScript + Rust 原生窗口；Electron + HTML/JS 主进程管理窗口；Qt/PyQt/PySide 的原生 frameless window；以及 Rust + GPUI/平台原生 API 的重型桌面实现。抽样项目中，Tauri 和 Electron 都能稳定完成透明、无边框、置顶和托盘，但稳定性更多取决于“宠物窗口、菜单窗口、设置窗口是否分责”，而不是取决于框架名称。

对 Omni 的核心建议：**保留 Tauri v2，不迁移到 Electron 或 Qt；先通过运行时观测收敛几何副作用，再以固定大透明宿主做第一结构对照，独立 Tauri popup 作为输入命中不合格时的第二方案。** 当前尚未证明具体闪帧来自原生 resize、DOM 生命周期、WebView2 合成还是 blur-close，不能把某一种新拓扑当成已证实的修复。Windows 原生 `SetWindowPos` 可以作为后续实验，不等于 WebView 已完成绘制。

为什么现在应做：Omni 当前菜单打开链路同时包含异步测量、方向选择、React 状态提交、`setPosition`、`setSize`、hover 子菜单状态和 blur 关闭逻辑。用户反馈的“球在边缘附近移动、菜单左侧闪一下、点击后消失”与这类多源窗口几何竞争相符，但 GIF 和静态代码不能确认可见闪帧属于 native resize、DOM unmount、WebView2 空帧还是 blur-close。继续增加延时不能区分这些机制。

## 2. 现状与痛点（读代码核实）

### 2.1 当前框架和窗口拓扑

- `src-tauri/tauri.conf.json:14-32`：产品根窗口配置为 Tauri v2；主窗口 `main` 是 920×820、透明、无装饰，compact/pet 窗口由前端运行时创建。
- `src-tauri/capabilities/default.json:5,29-34`：`compact` 和 `pet-thought` 已被纳入 capability，允许 `set-size`、`set-position` 和 `start-dragging`。
- `src/app/window.ts:758-827`：`ensureCompactWindow` 创建一个隐藏的 Tauri `WebviewWindow`，设置 `minWidth/minHeight` 为收缩尺寸、`maxWidth/maxHeight` 为展开视口，随后显式写入位置和尺寸。
- `src/app/window.ts:829-928`：`showCompactWindow` 在显示前读取存储位置、监视器和主窗口几何，并可能多次 `setPosition`，最后 `show` 和 `setAlwaysOnTop`。
- `src/components/CompactWindow.tsx:290-317,602-681`：球、普通菜单、pet 菜单、查询面板和回复状态都在同一个 compact WebView 内渲染；普通外观和 pet 外观还采用了两套菜单渲染位置。

这不是“两个窗口独立移动”的实现。当前本体和菜单共享一个原生窗口，菜单展开通过改变这个窗口的外框来腾出 CSS 视口。

### 2.2 菜单打开链路

- `src/hooks/useCompactMenus.ts:175-243`：打开前通过 `scaleFactor`、`outerPosition`、`outerSize`、光标和 monitor work area 计算方向与菜单坐标。
- `src/hooks/useCompactMenus.ts:510-580`：`openCompactMenu` 等待多次 IPC 后才一次性提交 `menuSide`、`submenuSide`、菜单坐标和 `isCompactMenuOpen`。
- `src/hooks/useCompactMenus.ts:602-651`：右键路径重复执行方向/位置计算，并再次设置菜单打开状态。
- `src/hooks/compactMenuGeometry.ts:138-165`：菜单坐标是基于“展开后 viewport”计算的 CSS 坐标，而不是独立原生窗口的屏幕坐标。
- `src/components/compact/CompactMenu.tsx:79-115`：菜单用 `position: fixed` 放在 compact WebView 内；`isGeometryReady` 只控制透明度和可见性，不能阻止宿主窗口几何已经发生变化。

### 2.3 几何竞争面

- `src/hooks/useCompactWindowController.ts:168-172`：为几何 revision 和串行任务维护多个 ref。
- `src/hooks/useCompactWindowController.ts:838-1009`：geometry effect 依次读取 scale、position、size，再根据菜单方向、pet offset、气泡、查询框和 reply 状态决定 `setPosition`/`setSize`。
- `src/hooks/useCompactWindowController.ts:889-890,952-955`：同一次布局中位置和尺寸是两个 Tauri API 调用；前一处用 `Promise.all`，后一处通过数组收集后并行提交。
- 同一个 effect 的依赖包括 `isCompactAppearanceOpen`、`isCompactMenuOpen`、`isCompactModelOpen`、`isCompactQueryOpen`、reply、pet thought 等。菜单 hover 子项会改变 `isCompactModelOpen` 或 `isCompactAppearanceOpen`，从而再次触发几何 effect。
- `src/components/CompactWindow.tsx:341-382,394-418`：根窗口同时用 `onMouseMove`、`onMouseLeave`、blur 和计时器判断关闭；窗口 resize 造成的鼠标离开又需要靠 `PET_MENU_STABLE_MS` 和延时抵消。

【分析】现有代码已经投入了大量防拖拽、DPI、过期 IPC 和 hover 保护；其结构性风险是“菜单/本体状态变化可能触发同一个透明窗口的外框变化”。这说明应优先量测和削减 geometry writer 的触发面，但尚不足以断言菜单和球必须拆成两个窗口。首要工作是分清可见闪帧属于哪一阶段。

## 3. 业界方案分类对比

下表是本次选取的 GitHub 样本，不是 GitHub 全站的框架占比统计。

| 范式 | 代表实现 | 技术原理 | 窗口组织 | 活跃度/许可 | 对 Omni 的适配判断 |
|---|---|---|---|---|---|
| Tauri v2 + React/TS + Rust | `T-0-Ken`、`CaYa-Desktop-Pet`、`dsh-desk-pet`、`Chirp` | WebView 渲染 UI，Rust/Tauri 管理透明窗口、托盘和持久化 | 简单项目常用固定尺寸单窗口；复杂项目增设 friend/overlay/prop 窗口 | T-0-Ken 0 star、MIT；CaYa 2 star、MIT；dsh 0 star、MIT；Chirp 0 star、仓库页面未展示许可证信息 | **最适合复用现有 Omni**；可保留前端和 Rust，只调整窗口职责 |
| Electron + HTML/JS 主进程 | `OpenPets`、`dsh-desktop-petbox`、`deepseek-whale-pet` | Chromium renderer + Node 主进程，主进程集中创建/销毁/定位 BrowserWindow | 宠物、托盘、设置面板通常是独立 BrowserWindow；复杂产品还有 Control Center、delivery surface | OpenPets 1,388 star/131 fork，MIT，2026-11-06 更新；petbox 11 star，MIT，2026-11-07 更新；whale 9 star，未在本次源码片段中核实许可证 | 能提供成熟的多窗口模型，但迁移成本高，不能自动修复状态竞态 |
| Qt/PyQt/PySide 原生窗口 | `nemo-assistant` | QWidget/QWindow 原生事件循环、frameless popup、系统级快捷键和 geometry | 浮动动作条、结果卡、sticky、设置窗口分离 | 107 star、MIT，2026-11-07 更新；Python 3.12 + PyQt6/Fluent | Windows 专用助手适合，但 Omni 迁移会重写 React/Tauri、跨平台和 Rust 能力 |
| Rust + GPUI/原生平台层 | `BongoCat` | Rust workspace，GPUI UI，独立 platform/overlay/render 模块 | overlay、platform window、UI 和渲染模块分离，重视平台原生行为 | 24,532 star/1,232 fork，Apache-2.0，2026-11-07 更新 | 适合新产品或极致性能，但对 Omni 是重写级别方案，不是当前 bug 的合理第一步 |

### 窗口组织模式的结论

1. **固定本体窗口**：T-0-Ken 的配置把窗口设为透明、无装饰、置顶、skip taskbar，并通过固定的最小尺寸保留宠物本体；它没有把菜单打开描述成连续的窗口形变。
2. **独立辅助窗口**：CaYa 明确使用 `friend-{petId}` 独立窗口，并另外创建 fullscreen overlay 和 prop 窗口；dsh-desk-pet 也将宠物 binary 作为独立 Tauri 窗口运行。
3. **主进程集中管理**：OpenPets 的文档明确将 Electron main process 作为状态、tray、windows 和 IPC 的权威持有者，renderer 只通过受限 preload bridge 操作。
4. **固定外框、内部 UI 状态切换**：OpenPets 的 in-pet chat 文档描述 compact carrier 在默认收缩态保持 200×200，输入框直接附着在宠物内部；只有明确打开历史时才扩展到 420×640，并用坐标变换保持宠物锚点。
5. **原生几何而非纯 CSS 补丁**：BongoCat 将 overlay、placement、resize/drag、platform 分为 Rust crate/模块；Nemo 的开发说明明确使用 `startSystemMove()`，并用事件过滤器和 `setGeometry` 处理 resize，以避免 ghost border。

## 4. 深入标杆

### 4.1 Tauri：T-0-Ken

仓库为 `ToyotaMasayoshi/T-0-Ken`，README 和 `src-tauri/tauri.conf.json` 均明确使用 Tauri 2。其主窗口配置为透明、无装饰、always-on-top、skip-taskbar，功能通过拖拽、托盘和菜单完成；README 还明确将 Windows x64 标为已原生安装验证，macOS/Linux 为候选状态。[1]

可借鉴点【分析】：

- 悬浮球本体的窗口尺寸和动画状态可以保持稳定，菜单是操作入口而不是本体尺寸的持续变化源。
- 将 tray、autostart、持久化位置和窗口生命周期交给 Rust/Tauri，前端只持有展示状态，边界清楚。

局限：项目规模和 star 较小，不能证明其菜单几何已覆盖 Omni 的多 DPI、多屏和复杂子菜单场景。

### 4.2 Tauri：CaYa-Desktop-Pet

仓库为 `CaYatur/CaYa-Desktop-Pet`，README 直接给出 Tauri + React + TypeScript + Rust。它的窗口配置固定为 176×176、不可 resize，并明确记录“右键菜单打开时临时扩展窗口”；Rust 源码把 `spawn_friend`、fullscreen overlay、prop window 做成独立 WebviewWindow，并用 `set_ignore_cursor_events` 控制穿透。[2]

可借鉴点【分析】：

- 独立窗口不是 Electron 专属，Tauri v2 已经能承载同一应用内的 friend/overlay/prop 拓扑。
- 对于必须扩展的菜单，可把扩展封装成专门的窗口命令，由一个 owner 统一完成位置/尺寸/显示，而不是让多个 React effect 同时写。
- 固定本体窗口 `resizable: false` 是降低桌宠拖动和菜单竞争面的直接手段。

局限：它自己仍保留了 `expand_window`/`set_window_size` 的临时扩展路径，因此只能证明“可用的 Tauri 设计空间”包含独立窗口，并不能证明临时扩展永远不会闪。

### 4.3 Tauri：dsh-desk-pet

仓库为 `jadyssey/dsh-desk-pet`，桌面端是 Tauri v2，插件 host 和桌面 binary 分包；README 标明 Windows/macOS/Linux 均有支持状态，MIT 许可。[3] Rust 端只保留保存/加载位置、置顶、退出和拖动等简单窗口命令，`on_window_event` 的 `Moved` 负责保存位置。

可借鉴点【分析】：

- 让 native window owner 只处理“位置、置顶、生命周期”这种少量明确命令，能降低前端和 native 几何互相抢写的概率。
- 跨平台桌宠不必把每一帧的 UI 状态都映射成窗口几何；窗口状态越少，跨 DPI 差异越容易测试。

局限：它的 `nudge_window` 是前端驱动的手动移动，Linux compositor 的兼容性说明也很谨慎，不能直接当作 Omni 的多屏实现模板。

### 4.4 Electron：OpenPets

仓库为 `OpenPetsHQ/openpets`，1,388 star、131 fork，MIT，最近一次仓库更新时间为 2026-11-06。[4] `apps/desktop/package.json` 使用 Electron 42、React 19、Vite 和 electron-builder；`docs/desktop.md` 明确规定 main process 负责 state、tray、windows、IPC，renderer 通过 preload bridge 获取最小能力。其 pet window、Control Center、plugin panel 和 delivery surface 分离，且文档描述 compact carrier 默认不 resize，只有显式打开完整历史才扩展。

可借鉴点【分析】：

- “一个 owner 管窗口 + 多种 presentation window”是最值得 Omni 借鉴的结构，而非 Electron 本身。
- popup 的打开/关闭应是一个有生命周期的状态机：`closed -> opening -> shown -> closing -> closed`，而不是把窗口尺寸作为 React 状态的副作用。
- 宠物本体和聊天面板可以共享业务状态，但不必共享一个 native window。

局限：Electron 自带 Chromium，体积和内存成本明显高于 Tauri；迁移会丢失 Omni 现有 Rust/Tauri capability、构建和 macOS 适配投入。

### 4.5 PyQt6：Nemo Assistant

仓库为 `SevenBT/nemo-assistant`，107 star、MIT，最近更新时间为 2026-11-07。[5] README 明确使用 PyQt6 + PyQt-Fluent-Widgets；源码结构把 `anchor_rail.py`、`edge_snap.py`、`non_activating_popup.py`、`popup_geometry.py`、`result_bubble.py`、`sticky_note_window.py` 和 `tray_manager.py` 分开。其开发说明还明确记录：拖动用系统移动，resize 用事件过滤器 + `setGeometry`，以避免 ghost border。

可借鉴点【分析】：

- `anchor_rail`/`popup_geometry` 这种独立 geometry 模块值得在 Omni 中复用思想：几何计算是纯函数，窗口提交是单一 owner，UI 组件不直接改变宿主外框。
- non-activating popup 是“显示辅助内容但不抢主焦点”的成熟需求；Omni 的菜单/查询框可以按需分别选择聚焦策略。

局限：项目目前 Windows only，依赖 `pywin32`、UIA 和全局快捷键；不能作为 Omni 的跨平台迁移目标。

### 4.6 Native Rust：BongoCat

仓库为 `ayangweb/BongoCat`，24,532 star、1,232 fork，Apache-2.0，2026-11-07 更新。[6] 它不是简单的 Tauri React 项目：Cargo workspace 将 `bongocat-overlay`、`bongocat-platform`、`bongocat-render`、`bongocat-ui`、`bongocat-runtime` 等拆开，overlay 下还有 `placement.rs`、`resize_drag.rs`、Windows/macOS 平台目录；应用使用 `gpui-kit` 和平台原生依赖。

可借鉴点【分析】：

- 对窗口 placement、resize/drag、平台层和渲染层设立明确模块边界，比继续把所有窗口逻辑堆进一个 React hook 更容易诊断。
- Windows/macOS 的 native 差异应集中在 platform 层，而不是散落在菜单组件和每个 effect 中。

局限：GPUI/原生平台路线适合从零打造桌面产品；对 Omni 意味着重写窗口、UI、事件和构建链，不能因为 BongoCat star 高就直接迁移。

## 5. 针对 Omni 的推荐架构

### 5.1 业界 vs 当前架构

| 维度 | 业界可观察的稳定做法 | Omni 当前做法 | 差距与判断 |
|---|---|---|---|
| 本体几何 | 宠物本体固定或低频变化；菜单/历史由独立窗口或内部固定 viewport 承载 | 菜单打开会改变同一 compact WebView 的外框位置和尺寸 | 高风险；本体和菜单需要解耦 |
| 窗口所有权 | Electron main、Tauri native command 或 Qt controller 作为单一 owner | React hook、组件 hover/blur 和多个异步 effect 共同影响 native 几何 | 高风险；需要一个 `CompactWindowCoordinator` 级别的提交边界 |
| 坐标空间 | 计算模块统一屏幕物理坐标，提交时再转换 | 同时使用 logical viewport、physical `outerPosition`、CSS fixed 坐标和 monitor scale | 已有很多保护，但仍有竞态；需要让菜单 popup 使用屏幕物理坐标 |
| 菜单显示 | popup/独立 WebView、native menu 或固定 viewport | 菜单在同一 WebView 内 `position: fixed`，依赖窗口扩展 | 用户看到的闪烁与宿主 resize 强相关 |
| 焦点/关闭 | popup 生命周期和 owner 统一管理；非激活 popup 可单独选择 | blur、visibility、mouse leave 和计时器交叉关闭 | 中高风险；拆窗口后可以只由 popup owner 处理 outside click |
| 多屏/DPI | native platform/display 层负责，UI 只消费已解析的 rect | Omni 已做大量 DPI 和 monitor 保护，但路径分布在 window.ts、hooks、组件 | 能力不弱，维护成本偏高；不值得为此换框架 |
| 性能/包体 | Tauri/原生路线更轻，Electron 以更高资源换 Chromium 一致性 | 已有 Tauri + React + Rust 资产 | 迁移收益不足，框架不是当前瓶颈 |

### 5.2 候选目标拓扑

```text
Tauri App
├─ compact-carrier      固定大小、透明、置顶、拖拽、宠物本体
├─ compact-menu         可复用 popup WebviewWindow，负责菜单/子菜单
├─ compact-query        可选 popup 或固定在 carrier 内的查询框
├─ pet-thought          已存在的独立气泡窗口
└─ main/settings        工作台与设置窗口

共享状态：menu side / submenu side / active panel / query / theme
窗口 owner：CompactWindowCoordinator
提交顺序：计算屏幕 rect -> 单 owner 写 native geometry -> show/focus -> emit state
```

### 5.3 具体建议

**直接借鉴**

- 保留 Tauri v2、React/TypeScript、Rust backend 和现有 `compactMenuGeometry` 纯函数。
- 保留现有物理坐标和 DPI 规范；把菜单计算结果从“WebView 内 CSS 坐标”扩展为“屏幕物理 `Rect`”。
- 采用 OpenPets 的单一 window owner 和“carrier 几何不被 hover 子面板状态驱动”的边界思想；CaYa 的多窗口实现说明 Tauri 支持这一拓扑，但不把它视为立即迁移的充分证据。
- 采用 Nemo 的分层思想：纯几何、窗口提交、UI 渲染分模块。

**需要适配**

- 首先收敛 geometry effect：将纯菜单子面板/hover/reply 变化与 native geometry writer 分开；生成目标 rect key，仅在 rect、DPI 或 monitor 真变化时提交。
- 固定宿主原型中，carrier 预留最大 viewport，菜单仅切换 DOM/side/visibility；必须实测透明空白区域是否拦截底层应用输入，以及拖拽/hit-test 是否可接受。
- 若固定宿主的 hit-test 或屏幕覆盖不可接受，再新增稳定 label，例如 `compact-menu`，用可复用 popup WebviewWindow。popup 的 owner 独占 `setPosition`、`setSize`、`show`、`setAlwaysOnTop` 和关闭；React 组件只发菜单意图。
- 独立 popup 使用 `openingToken`/generation，使迟到的 placement 不能覆盖新一轮；首次创建隐藏，后续复用，避免每次冷启动 WebView。
- popup outside click 与焦点策略由 popup owner 处理；carrier 保留拖拽和本体点击。

**不建议当前做**

- 不建议现在迁移 Electron：它能改善窗口组织，但不会自动修复异步状态竞争，且会重写 Rust command、capability、打包和 macOS 资产。
- 不建议迁移 Qt/PyQt：Nemo 的 geometry 分层值得借鉴，语言和 UI 框架本身不值得引入。
- 不建议把 Windows `SetWindowPos` 称为整个呈现链原子化：它可以在单次 Win32 调用中设置 HWND 的位置/尺寸，但不等同于 WebView2/DOM 已完成绘制，也不覆盖跨平台。
- 不建议继续扩大稳定延时。延时可以作为 popup 显示后的微小动画，但不应承担状态一致性职责。

### 5.4 推荐接口草案

```ts
type CompactMenuOpenRequest = {
  anchor: { x: number; y: number; width: number; height: number };
  monitor: { workArea: Rect; scaleFactor: number };
  side: "left" | "right";
  submenuSide: "left" | "right";
};

type CompactMenuCoordinator = {
  open(request: CompactMenuOpenRequest): Promise<void>;
  close(reason: "outside" | "action" | "blur" | "shutdown"): Promise<void>;
  placeSubmenu(panel: "model" | "appearance" | "theme"): Promise<void>;
};
```

上面的接口重点不是命名，而是把“测量、选边、原生窗口提交”放在同一 owner 中。`CompactMenu` 不应该知道 `outerPosition`、`scaleFactor` 或 `setSize`。

## 6. 分阶段升级路径

### Phase 0：证据化当前竞态

目标：不改变 UI，记录一次打开/关闭的时间线：`open request`、`outerPosition`、`outerSize`、`setPosition start/end`、`setSize start/end`、React menu state、blur/leave。

回归判据：在右边缘、左边缘、距离边缘约 365px、双屏异 DPI 和拖拽后五个位置各执行 30 次；每次都能把一个打开 token 对应到一组完整的几何提交，不出现旧 token 在新 token 后落笔。

风险：只增加日志，不改变窗口行为；日志必须可关闭，不能写入用户内容或凭据。

### Phase 1：低风险收敛 geometry writer

目标：普通菜单 hover/子面板变化不触发无关 native geometry 读取/写入；目标 bounds 变化才提交。宠物 thought/placement 等确实影响 viewport 的依赖仍需保留或单独处理。

回归判据：常规菜单 hover 子面板时 `setPosition`/`setSize` 次数为 0；只因菜单 open/close 不重复写相同 bounds；DPI、monitor clamp、宠物气泡和 drag guard 无回归。

风险：普通 compact 和 pet viewport 的目标几何依赖不同，不能一刀切删除所有 effect dependencies；应先根据 trace 拆开路径。

### Phase 2：固定宿主 A/B 原型

目标：最大 viewport 在创建或拖拽后确定；菜单打开只切 DOM visibility/side，不改变 carrier HWND。

回归判据：球锚点保持不动，菜单 100 次打开无闪帧；透明覆盖区下底层应用点击、拖拽命中、桌面穿透和不同显示器裁剪行为都符合预期。

风险：大尺寸透明 HWND 可能拦截菜单以外的鼠标事件；若不能以可接受成本实现局部 hit-test/passthrough，则停止此路线。

### Phase 3：独立 popup 条件方案

目标：仅当 Phase 1 后仍在 resize 组复现、且 Phase 2 的输入区域不可接受时，复用隐藏的 `compact-menu` WebviewWindow，独立管理菜单 bounds 和生命周期。

回归判据：Win 10/11、macOS 支持版本、双屏混合 DPI；冷/热打开、焦点、outside click、重复开关和异常关闭稳定；carrier 锚点不漂移。

风险：多窗口事件、capability 和 focus/outside-click 复杂度增加；WebView 额外内存和首次 show 的可见性也需测量。

### Phase 4：平台原生优化

目标：只有观测表明剩余闪帧来自顶层 HWND bounds 提交，才考虑 Windows `SetWindowPos` Rust command 或特定 Tauri 配置 A/B；独立评估 `noRedirectionBitmap`。

回归判据：Win32 几何、WebView2 layout、实际 DWM 可见帧分别量测；macOS/Linux 保留 Tauri 公共路径。

风险：HWND 调用不保证 DOM/GPU paint 完成；`noRedirectionBitmap` 文档聚焦透明窗口创建白闪，并不承诺运行时 resize 修复。

## 7. 参考链接

1. `ToyotaMasayoshi/T-0-Ken`：Tauri 2、透明置顶桌宠、托盘和平台状态。<https://github.com/ToyotaMasayoshi/T-0-Ken>
2. `CaYatur/CaYa-Desktop-Pet`：Tauri + React + TypeScript + Rust；固定宠物窗口和独立 friend/overlay/prop 窗口。<https://github.com/CaYatur/CaYa-Desktop-Pet>
3. `jadyssey/dsh-desk-pet`：Tauri v2 跨平台桌宠，位置持久化和独立 desktop binary。<https://github.com/jadyssey/dsh-desk-pet>
4. `OpenPetsHQ/openpets`：Electron tray-first 桌面 companion、多 renderer 和 popup/Control Center 拓扑。<https://github.com/OpenPetsHQ/openpets>
5. `SevenBT/nemo-assistant`：PyQt6 + Fluent；anchor rail、popup geometry、non-activating popup 和 resize 说明。<https://github.com/SevenBT/nemo-assistant>
6. `ayangweb/BongoCat`：Rust workspace、GPUI、overlay/platform/render 分层，Apache-2.0。<https://github.com/ayangweb/BongoCat>
7. `HoppoChan0721/dsh-desktop-petbox`：Electron 透明置顶桌宠 shell、托盘、设置 panel 和 Live2D bridge。<https://github.com/HoppoChan0721/dsh-desktop-petbox>
8. Electron `BrowserWindow` API：透明、无边框、always-on-top、窗口位置和尺寸能力。<https://www.electronjs.org/docs/latest/api/browser-window>
9. Tauri v2 Window API：`WebviewWindow`、`setPosition`、`setSize`、visibility 和 focus。<https://v2.tauri.app/reference/javascript/api/namespacewindow/>
10. Tauri v2 Configuration Reference：窗口的透明、装饰、置顶、任务栏和尺寸配置。<https://v2.tauri.app/reference/config/>
11. Microsoft `SetWindowPos`：Windows 原生位置、尺寸和 z-order 提交接口。<https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos>
12. Qt Window Flags：无边框、置顶和窗口类型的原生窗口能力。<https://doc.qt.io/qt-6/qt.html#WindowType-enum>
13. Tauri v2 Config Reference 的 Windows `noRedirectionBitmap` 配置说明：<https://v2.tauri.app/reference/config/#windowsconfig>
14. Tauri v2 Window JS API：分别提供 `setPosition`、`setSize`、`show`、`hide` 等操作。<https://v2.tauri.app/reference/javascript/api/namespacewindow/>
15. WebView2 `ICoreWebView2Controller`：`SetBoundsAndZoomFactor` 的 controller bounds/zoom API。<https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller>
16. WebView2 `ICoreWebView2Controller2.DefaultBackgroundColor`：透明背景与默认背景行为。<https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller2>
17. Microsoft `SetWindowPos` flags：包括位置尺寸参数及 `SWP_NOREDRAW` 语义。<https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos>
18. DirectComposition `IDCompositionDevice::Commit`：composition device 命令批次提交语义。<https://learn.microsoft.com/en-us/windows/win32/api/dcomp/nf-dcomp-idcompositiondevice-commit>
19. Flow Launcher：WPF launcher 源码、README 与 MIT 许可。<https://github.com/Flow-Launcher/Flow.Launcher>
20. Microsoft PowerToys Run：launcher 模块与 WPF MainWindow 源码。<https://github.com/microsoft/PowerToys/tree/main/src/modules/launcher>
21. QuickLook：托盘/预览窗口职责与 GPL-3.0 仓库。<https://github.com/QL-Win/QuickLook>
22. Rainmeter：C++/Win32 桌面宿主与 GPL-2.0 仓库。<https://github.com/rainmeter/rainmeter>

## 附：对 Omni 当前决策的直接回答

1. **GitHub 上悬浮球/悬浮窗常用什么框架？** 本次样本中能看到 Tauri、Electron、PyQt6/PySide6、WPF、C++/Win32 和 Rust/GPUI；样本不是统计普查，不能据此给全行业排序。
2. **Omni 需要换框架吗？** 不需要。现有 Tauri/React/Rust 已支持透明窗、popup WebviewWindow 和 native commands；当前证据只支持“动态同窗几何有结构性风险”，不支持“框架本身不合适”。
3. **更好的实现方式是什么？** 先用 trace 查明几何重跑和 close reason；再验证固定最大 viewport 的透明宿主。若 hit-test/桌面穿透不合格，且闪帧跟 resize 同步，再换成复用的独立 Tauri menu popup。
4. **是否应该直接用 Windows 原生 API？** 不应当作为第一步。`SetWindowPos` 原子操作只覆盖 HWND bounds，不是 WebView2/DWM 的可见帧屏障；先确认真正的闪帧阶段。
5. **下一步最小验证范围是什么？** 临时记录 open token、geometry effect/run、native moved/resized、DOM mount/visible、blur/close reason；比较只改 DOM、只 resize、固定宿主、独立 popup 四组。先只测主菜单、一个子面板及关闭路径，再根据判据扩大范围。

## 8. 官方资料补充：WebView2 与 Windows geometry 边界

- Tauri Windows 配置中的 `noRedirectionBitmap` 映射到 Win32 `WS_EX_NOREDIRECTIONBITMAP`，官方描述针对创建透明窗口时的白闪；文档没有承诺覆盖运行时 resize/reposition。[13]
- Tauri JS Window API 将 `setPosition`、`setSize`、`show`、`hide` 分别暴露；没有公开的顶层 HWND `setBounds` 原子事务。[14]
- WebView2 `SetBoundsAndZoomFactor` 同一调用只涉及 WebView controller 的 bounds 与 zoom factor，并不包含 Tauri 顶层窗口 HWND 的位置、尺寸、z-order。[15]
- WebView2 `DefaultBackgroundColor` 文档说明透明背景能力与默认背景行为；它不构成 compositor 已呈现首帧的通知。[16]
- Win32 `SetWindowPos` 可在一次 API 调用传入位置和尺寸；`SWP_NOREDRAW` 文档要求调用方自己负责 invalidation/redraw，因此不能把该 flag 当作自动消除 flicker 的捷径。[17]
- DirectComposition `Commit` 只保证同一 composition device 的待处理命令批次原子生效，不是把 React DOM、WebView2、Tauri HWND 和 DWM present 合成一个事务。[18]
