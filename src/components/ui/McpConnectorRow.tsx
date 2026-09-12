import { useMemo, useSyncExternalStore } from "react";
import { Cable } from "lucide-react";
import { pluginRegistry } from "../../plugins/registry";
import PluginToggleRow from "./PluginToggleRow";

export type McpConnectorRowProps = {
  /** 已勾选（= 本项目放行）的连接器 id。空数组 = 不限制。 */
  selectedIds: string[];
  onToggle: (id: string) => void;
};

/**
 * 项目对话框里的「连接器」行：**项目可用的 MCP 连接器**多选。
 *
 * 只负责算候选集，渲染交给 `PluginToggleRow`（与专家行 / 技能行同一个实现）。
 *
 * 语义（与 `Project.allowedConnectorIds` 一致）：**不勾 = 不限制** —— 放行全部已信任
 * 连接器；勾了才是收窄成白名单。这与「勾选 = 启用」的直觉正好相反，所以文案必须写明。
 *
 * 两个刻意的取舍：
 * 1. **必须排除 `provider` 连接器**：那些是**模型**连接器（在「模型设置」里配），
 *    不暴露任何 `mcp__*` 工具，勾进来只会写下一个永远不生效的 id —— 这正是这个字段
 *    过去那版 UI 的错（当时钩 `allowedToolIds`、连候选集都没筛）。
 * 2. **订阅注册表**：连接器可能在别处（扩展中心）装/卸/改，靠本组件自身 handler 刷新必漏。
 *    snapshot 用递增版本号这种原始值，不能拿 `list()` 的新数组当快照（会无限重渲染）。
 */
export default function McpConnectorRow({ selectedIds, onToggle }: McpConnectorRowProps) {
  const registryVersion = useSyncExternalStore(
    (listener) => pluginRegistry.subscribe(listener),
    () => pluginRegistry.getVersion(),
  );

  const options = useMemo(() => {
    void registryVersion;
    return pluginRegistry
      .list({ kind: "connector" })
      .filter((connector) => !connector.provider)
      .map((connector) => ({ id: connector.id, name: connector.name }));
  }, [registryVersion]);

  return (
    <PluginToggleRow
      icon={<Cable size={16} strokeWidth={1.8} />}
      label="连接器"
      hint="不勾 = 不限制，全部已信任连接器都可被本项目调用；勾选后只放行选中的"
      options={options}
      selectedIds={selectedIds}
      onToggle={onToggle}
      emptyText="暂无已安装的 MCP 连接器（可在扩展中心「连接器」中添加并确认信任）"
      idleIcon={<Cable size={12} strokeWidth={1.8} />}
    />
  );
}
