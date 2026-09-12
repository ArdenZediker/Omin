import { Check, Puzzle } from "lucide-react";
import type { ReactNode } from "react";

export type PluginToggleOption = {
  id: string;
  name: string;
};

export type PluginToggleRowProps = {
  icon: ReactNode;
  label: string;
  /** 行标题右侧的说明（组件会补括号）。**必须写明「不勾」的含义** —— 各字段口径不同。 */
  hint: string;
  /** 全部候选项（由调用方算好）。 */
  options: PluginToggleOption[];
  /** 当前选中的 id。渲染的是**白名单全量**的选中态，不是「本次新挑的那几个」。 */
  selectedIds: string[];
  onToggle: (id: string) => void;
  /** 无候选时的提示。 */
  emptyText: string;
  /** 未选中项左侧的图标（默认拼图）。 */
  idleIcon?: ReactNode;
};

/**
 * 对话框里的「插件多选行」：图标 + 标题 + 说明 + **全部候选项平铺成的开关 chips**。
 *
 * 为什么是平铺 chips，而不是「已选项 + 「添加」→ 扩展中心挑选」：
 * 那个弹层用的是 `PluginMarketplace` 的「选择模式」（`onPick`，已于 2026-09-13 删除），
 * 它**只列本地已有的项** ——
 * SkillHub / 专家团 / 远程技能 / 「我的专家」/「我的技能」这些视图在 `onPick` 下
 * 全被 `!onPick` 关掉，source tab 整排不渲染，卡片唯一动作是「选择」。也就是说它
 * 装不了任何东西，等价于「打开扩展中心 → 切 tab → 挑一个」三步缩成一步 —— 纯重复。
 * 而候选集本身很短（内置技能十来个、MCP 连接器几个、专家只有用户自建的几个），
 * 直接铺开比跳一层弹窗快，形态也与「连接器」行统一（同一个实现，不再各写一份）。
 *
 * 两个必须保留的细节：
 * 1. **`selectedIds` 里可能有取不到的 id**（插件已被卸载，或数据来自旧版本）。
 *    它们会被补进候选、名字退回显示 id —— 否则用户既看不见、也就**删不掉**这条白名单。
 * 2. 渲染的是**白名单全量**：否则打开对话框直接点保存，会把之前选好的整批抹掉。
 */
export default function PluginToggleRow({
  icon,
  label,
  hint,
  options,
  selectedIds,
  onToggle,
  emptyText,
  idleIcon,
}: PluginToggleRowProps) {
  // 取不到的 id 补进候选：候选集只覆盖「现在可用的」，而白名单可能含历史遗留项。
  const missing = selectedIds.filter((id) => !options.some((option) => option.id === id));
  const display: PluginToggleOption[] = [
    ...options,
    ...missing.map((id) => ({ id, name: id })),
  ];

  return (
    <div className="omni-dialog__plugin-row">
      <div className="omni-dialog__plugin-row-header">
        <div className="omni-dialog__plugin-row-title">
          {icon}
          <span>{label}</span>
          <span className="omni-dialog__plugin-row-hint">（{hint}）</span>
        </div>
      </div>
      {display.length > 0 ? (
        <div className="omni-dialog__plugin-chips">
          {display.map((option) => {
            const active = selectedIds.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                className={`omni-dialog__plugin-chip${active ? " omni-dialog__plugin-chip--active" : ""}`}
                onClick={() => onToggle(option.id)}
              >
                {active ? (
                  <Check size={12} strokeWidth={2} />
                ) : (
                  (idleIcon ?? <Puzzle size={12} strokeWidth={1.8} />)
                )}
                <span>{option.name}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="omni-dialog__hint">{emptyText}</p>
      )}
    </div>
  );
}
