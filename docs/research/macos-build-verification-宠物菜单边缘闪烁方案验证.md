# 宠物菜单边缘闪烁 · 针对性调研报告
> 主题：定位宠物菜单打开时的闪现、消失与重现，并选择不移动宠物的窗口呈现方式
> 定位：基于最新用户录屏和回退后代码，决定下一轮最小验证与架构方向
> 日期：2026-11-09
> 状态：调研稿；未修改实现代码，未在本机运行时复现

## 0. 证据标注约定

- **有据**：本仓库当前代码、用户提供的 GIF，或引用的官方文档/公开项目材料可直接支持。
- **【分析】**：根据多个证据推演的原因或建议，不作为已验证根因。
- **未知**：GIF/静态代码不足以区分，需下一轮运行时记录回答。
- GIF 总长约 3 秒、30 帧、每帧标注时长 100ms；它是低帧率屏幕录制，不是原生窗口事件或 compositor trace。

## 1. 执行摘要

这次录屏显示宠物大体停留在原位置；菜单约在第 11-14 帧出现，随后第 16-26 帧不可见，末尾第 28-29 帧又出现。录屏支持“菜单可见性中断/重现”的现象，但不能区分 React 关闭再打开、WebView 空帧/重绘、窗口被遮挡或录屏采样缺帧。不能把它直接定性为菜单放大动画或单纯的边缘定位错误。

代码核实到宠物菜单每次打开都会把顶层透明窗口扩为至少 560px 高、至少菜单最小宽度，并以两个独立 Tauri 调用并发写位置和尺寸；宠物视觉中心通过 viewport offset 计算补偿。菜单 React 状态在原生几何完成前提交，未使用几何就绪门控。**【分析】当前最高优先级实验应先判定菜单是否被关闭；随后比较不改变宠物载体 HWND 的菜单 popup 与固定 viewport。** 对宠物模式，独立 popup 值得优先做小型原型，因为它可将宠物本体窗口稳定下来且不需要让一个大透明窗口覆盖大片桌面；但其焦点、置顶、跨屏 DPI 和外部点击生命周期要验证。固定大 viewport 是低实现成本对照，不应未经 hit-test 测试就作为最终方案。

## 2. 现状与痛点

| 位置 | 当前行为 | 与闪烁的关系 |
|---|---|---|
| `src/app/window.ts:570-575` | `getPetCompactMenuViewport` 返回 `width >= menuMinWidth`、`height >= max(petHeight + 360, 560)` | 宠物菜单开启时必然要求更大的窗口 viewport |
| `src/hooks/useCompactMenus.ts:556-674` | 打开锁后异步读取 metrics、算 menu/submenu side 与位置，随后一次 React 批次更新方向、位置和 `isCompactMenuOpen` | 菜单 open state 提交不等待原生尺寸/位置完成 |
| `src/hooks/useCompactWindowController.ts:834-918` | pet geometry effect 串行运行，读 scale/position/size；宠物 offset 或窗口尺寸变化时并发 `setPosition`、`setSize` 与 thought window 更新 | 位置和尺寸是分开的 native 操作；Promise 完成不是屏幕呈现完成信号 |
| `src/components/CompactWindow.tsx:654-666` | `isCompactMenuOpen && isPetAppearance` 即挂载菜单，并传 `isGeometryReady` 常量 `true` | 菜单没有等新窗口 bounds 或首个可见帧后再显示的 gate |
| `src/components/CompactWindow.tsx:343-390` | 窗口内指针位于菜单/宠物外时延迟 140ms 关闭；窗口整体 leave 至少延迟 160ms，且受 700ms 稳定窗口影响 | 可以解释菜单闪现后被关闭，但需要记录实际 close reason；不能凭静态代码断言录屏就是该路径 |
| `src/hooks/useCompactWindowController.ts:1117-1134` | 宠物菜单打开时注册 `blur` 与 `visibilitychange` 关闭处理；受 `suppressCompactBlur` 时间窗抑制 | 原生 resize/焦点/可见性事件是否触发关闭，当前没有 trace 证据 |

### 本次 GIF 可见证据

- 宠物连续出现在约相同的画面位置；未观察到与菜单出现同步的大幅跳位。
- 菜单可见/不可见不是单帧闪白：采样中先出现数帧，消失约 1.1 秒，再于末尾出现。
- 个别帧还捕获到工作窗口/侧栏区域，说明录屏可能覆盖多个窗口或屏幕区域；其窗口层级和采样关系无法由 GIF 文件确认。
- **未知**：每次不可见时，菜单 DOM 是否卸载、CSS 是否隐藏、整个窗口是否被隐藏/遮挡、是否有旧帧/空帧，或 GIF 编码是否丢了中间区域。

## 3. 业界方案分类对比

| 方案 | 机制 | 对宠物稳定性的影响 | 主要代价与边界 |
|---|---|---|---|
| 同一 WebView 动态扩窗（现状） | 打开菜单时增加顶层窗口 bounds，DOM 在同一 renderer 显示 | 需要移动/resize 宠物窗口，再靠 offset 维持视觉锚点 | 最少窗口；多个异步几何阶段和首帧交错；Tauri 的 position/size 是分立 API [1][2] |
| 固定大透明载体 | 预留最大菜单区域，打开时只更新 DOM 可见性/方向 | HWND 不变，理论上宠物不需因开菜单移动 | 透明窗口空区域可能拦截桌面点击；屏幕边界与命中区域需实测 |
| 独立菜单 WebView popup | 宠物载体保持小且稳定，菜单由另一个可复用窗口定位显示 | 不需要 resize 宠物窗口，菜单位置独立计算 | 多窗口状态、focus/blur/outside-click、置顶顺序、冷启动和 DPI 坐标增加复杂度；Windows 可将菜单窗设为宠物窗的 owned window，以取得原生层级/生命周期关系，但不承诺显示首帧完成事件 [1][2][5] |
| 原生菜单 | Windows 原生 popup/menu 由 HWND/UI 框架管理 | 不扩大 WebView 宿主，OS 管理 popup 边界 | 当前复杂 React 菜单需重写，主题和跨平台行为分叉；并不能直接复用现有内容 |

这些是架构取舍，不代表任一方案已在 Omni 运行时验证。Tauri 的 `noRedirectionBitmap` 文档针对透明窗口创建时可能的白闪，没有承诺修复运行时 resize 的菜单消失；WebView2 controller bounds API 也不覆盖顶层 Tauri HWND 的位置/尺寸与 DOM 呈现 [1][3]。

## 4. 相关工程实践

1. Tauri v2 把窗口 `setPosition`、`setSize`、`show`、`hide` 等作为独立操作提供。应由一个 menu/window coordinator 串行管理 popup 的目标 rect 与生命周期，不要把多个调用的 Promise 完成误认为合成器已经展示正确帧 [1][2]。
2. Windows `SetWindowPos` 可以在一次调用里传入 HWND 的位置和尺寸，但它只修改原生窗口 bounds，不构成 WebView2 DOM paint 或 DWM present 的完成屏障；因此把 Rust `SetWindowPos` 当成闪烁根治方案没有依据 [4]。
3. Tauri 源码提供 Windows `owner()` 配置；Win32 owned window 会保持在 owner 上方，owner 最小化时隐藏、销毁时随之销毁 [5][6]。这能帮助 popup 生命周期和层级管理，但不是 compositor 首帧同步机制。
4. 桌面 launcher/preview 与宠物载体职责分离，是值得评估的窗口边界；但参考项目的架构只能证明这种拓扑存在，不能证明它解决 Omni 的特定闪帧。现有窗口框架调研列有 Flow Launcher、PowerToys Run、CaYa Desktop Pet 等样本及适用边界 [7]。

## 5. 针对 Omni 的推荐架构

### 对比与判断

| 维度 | 当前 | 建议目标 | 差距/取舍 |
|---|---|---|---|
| 宠物锚点 | menu open 改 viewport/offset，原生位置与尺寸并发更新 | 宠物载体 bounds 在菜单开关期间恒定 | popup 方案把菜单外置；固定 viewport 保持单窗但扩大 HWND |
| 可见性一致性 | DOM 可先出现，geometry effect 后完成 | 菜单窗口先定位，再以一次 open token show；close 只由 owner 执行 | popup 的 `show()` 也不代表首帧已 present，仍需观测 |
| 鼠标命中 | 整个 pet WebView 窗口接受 pointer 事件 | 宠物窗只覆盖宠物；popup 只覆盖菜单内容 | popup 更容易限制透明命中区域；跨窗鼠标穿越/outside click 要做协调 |
| 性能 | 一个 WebView，但打开/关闭有 resize | 可复用隐藏 popup，避免每次创建 renderer | 多一个 WebView 带来内存占用；需要测冷/热打开延迟 |
| 跨平台 | 共用同窗 DOM，但 native geometry 细节仍平台化 | 保持 Tauri popup API 抽象，逐平台验焦点与置顶 | Windows 非激活 popup 与 macOS panel 语义不完全相同，不能只验证 Windows |

### 推荐

**【分析】不要现在直接选定最终架构：P0 先判明是否真的发生关闭；随后用固定 viewport 和复用 owned popup 做短周期 A/B。** 固定 viewport 改动较小，但 462×560 左右的透明载体可能扩大命中/屏幕覆盖；owned popup 能保持 pet HWND 稳定并把透明输入区限制到菜单附近，但新增 renderer/window 生命周期与焦点路径。若固定宿主桌面穿透不合格、而 popup 在焦点和跨屏验收中稳定，再采用 popup；任一方案都不能只靠 API 文档宣称能根治闪烁。

```text
CompactWindowCoordinator
├─ pet-carrier: 固定宠物尺寸；拖动、动画、命中
└─ pet-menu: 复用 popup WebviewWindow；只渲染菜单与子面板

open(token): 计算物理屏幕 Rect -> 设置 menu bounds -> 显示 -> 记录首帧/关闭原因
close(token, reason): 仅当前 token 可关闭；恢复 carrier 输入与菜单状态
```

### 下一轮实验顺序

1. **先加临时可关诊断，不改变行为**：给每次打开分配 token；记录 `open start`、React mount/unmount、geometry effect 进入/退出、每个 `setPosition`/`setSize` 起止、`blur`/`visibilitychange`、mouse leave/outside close 的 reason 与时间、窗口 moved/resized 事件。将首个 DOM 可见帧的 `requestAnimationFrame` 序号与 token 一并记下。需要实际桌面录屏/原生窗口事件对齐；DOM paint 事件不能代替 DWM present。
2. **A/B 固定 viewport**：仅禁用宠物菜单引发的 carrier resize，保持现有 DOM 和菜单定位。测底层窗口点击是否被透明区域拦截、宠物是否漂移、是否仍有菜单消失；若命中区域不合格立即停止此路线。
3. **A/B 复用 owned popup**：菜单打开时 pet HWND 的 position/size 调用计数必须为零；popup 不每次销毁重建，Windows 设置 owner 关系。验证 focus/blur、outside click、菜单子面板切换、宠物拖动、跨屏 100%/150% DPI、屏幕边缘与 100 次热开关。owner 关系只解决 z-order/生命周期，不视为首帧 ready。
4. **按证据决策**：若日志显示明确 close reason，先修菜单状态/鼠标判定，不迁窗；若没有 close 且 DOM 持续 visible 但录屏缺帧，优先验证 WebView/窗口呈现路径；若闪帧与 carrier resize 同步，且固定 viewport hit-test 失败，则采用 popup 方向。

### 验收门

- 右/左边缘、距边缘约 365px、屏幕角落；单屏与混合 DPI 双屏；菜单主项和子面板。
- 每种布局重复 100 次；无菜单消失/重现、无 pet screen-anchor 位移、无错误屏幕定位帧。
- 固定 viewport 方案需通过空白透明区域桌面点击与拖拽命中；popup 方案需通过 focus、outside-click、置顶、冷/热打开及退出清理。
- 记录 click-to-visible P50/P95。任何延时只能用于呈现动画，不得作为几何或状态正确性的依据。

## 6. 分阶段路径与风险

| 阶段 | 目标 | 收益 | 风险/退出条件 |
|---|---|---|---|
| P0 观测 | 用 open token 和 close reason 判定是状态关闭还是画面呈现 | 不先猜根因，不影响交互 | 日志过量；只记录状态与几何，不记录用户内容 |
| P1 固定 viewport 对照 | 证明移除 carrier resize 能否消除问题 | 最低代码量验证 resize 相关性 | 空白透明 HWND 可能吞掉桌面输入；不达标就回滚原型 |
| P2 复用 popup | 将宠物本体与菜单窗口生命周期分离 | 宠物位置稳定、命中边界更清楚 | 多 WebView 内存、焦点/置顶与多屏生命周期更复杂 |
| P3 平台微调 | 仅按 trace 评估 Win32 geometry、透明背景、Tauri 配置 | 精确针对已确认的 native 问题 | Windows 特例增加维护；`noRedirectionBitmap` 不是运行时 resize 的已证实修复 |

**结论边界：** 当前没有以用户这台 Windows 环境运行上述 A/B，也没有 ETW/PresentMon 或 Win32 事件 trace，因此方案推荐属于基于代码和录屏的工程判断，不是已修复或已证明根因。

## 7. 参考链接

1. Tauri v2 Window API：独立窗口位置、尺寸、show/hide 与 focus 操作。<https://v2.tauri.app/reference/javascript/api/namespacewindow/>
2. Tauri v2 Configuration：transparent、Windows `noRedirectionBitmap` 配置及其限制语境。<https://v2.tauri.app/reference/config/>
3. WebView2 `ICoreWebView2Controller`：controller bounds/zoom API 边界。<https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller>
4. Win32 `SetWindowPos`：HWND 位置/尺寸接口，不是 DOM 呈现屏障。<https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowpos>
5. Tauri v2 `WebviewWindowBuilder` 源码：Windows `owner()`、`auto_resize()` 和透明窗创建说明。<https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/webview/webview_window.rs>
6. Microsoft Win32 Window Features - Owned Windows：owner/owned 窗口层级与生命周期约定。<https://learn.microsoft.com/en-us/windows/win32/winmsg/window-features#owned-windows>
7. Omni 悬浮窗框架调研：`docs/research/macos-build-verification-悬浮球窗口框架调研.md`，含项目样本、源码链接和许可证边界。
8. Microsoft WebView2 Feedback issues 搜索入口：透明背景/闪帧相关个案，仅用于发现问题，不视作规范保证。<https://github.com/MicrosoftEdge/WebView2Feedback/issues?q=transparent+flicker>

## 附：本次问题的直接回答

最新 GIF 不是单纯“菜单从边缘弹出时缩放一下”：它显示菜单打开后不可见了一段时间再出现，宠物位置大体稳定。当前代码的确每次开宠物菜单都 resize carrier，且菜单可先于几何完成显示；同时 mouseleave/blur 具备关闭能力。下一步不是再加动画或更长延迟，而是先记录 close reason 与 renderer/native 几何时间线，再对照固定 viewport 和复用 owned popup。Windows owner 关系能管理层级与生命周期，但不能替代首帧呈现验证。尚未做运行时验证。
