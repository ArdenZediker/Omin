# 项目依赖与风险清单

## 1. 技术栈与依赖结构

前端：
- React 19
- Vite 7
- TypeScript 5
- lucide-react
- @lobehub/icons-static-svg
- Tauri API 与插件

桌面端：
- Tauri 2
- tauri-plugin-opener
- tauri-plugin-shell
- tauri-plugin-global-shortcut
- tauri-plugin-clipboard-manager

Rust 侧：
- serde / serde_json
- reqwest
- tokio
- rusqlite(bundled)

存储：
- SQLite 为主
- localStorage 作为部分历史兼容兜底

## 2. 审计结果说明

本次没有拿到完整在线漏洞库审计结果，原因如下：
- `pnpm audit` 受当前镜像源限制，审计接口不可用
- `cargo audit` 当前环境未安装

因此本结论不等于“零漏洞”，而是“未完成官方漏洞数据库核验”。

## 3. 已确认风险

### 高优先级

1. Provider API Key 明文落地
- 之前 `omni_provider_configs` 会通过前端存储镜像到 localStorage
- 风险在于本机可直接读取明文密钥
- 当前已开始改造为仅通过 Tauri + SQLite 持久化，不再依赖 localStorage 副本

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
- 包括聊天、记忆、自动化、窗口状态等
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

