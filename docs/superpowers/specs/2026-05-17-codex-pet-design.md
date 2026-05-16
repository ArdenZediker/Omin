# Codex Pet Design

**Goal:** 在设置页的“基本设置”中新增一个独立的 Codex 宠物管理区，支持查看当前宠物、创建自己的宠物、刷新、唤醒宠物，并且不影响现有聊天页和旧的小窗宠物链路。

## 设计目标

- 宠物功能作为独立模块存在，不复用现有 `DesktopPet` 小窗运行时逻辑。
- 设置页只承担入口和管理职责，不把复杂状态机塞进 `BasicSettings`。
- 首版优先保证视觉和交互边界清晰，避免之前出现的重叠、挤压、跑位问题。
- `唤醒宠物` 先定义为明确的状态切换，不直接接入聊天回答链路。

## 非目标

- 不改造现有 `compactAppearance === "pet"` 的旧宠物实现。
- 不在首版里把宠物嵌进聊天消息气泡、回答链路或知识库联动逻辑。
- 不在首版里实现完整的宠物编辑器、商店或多角色同步系统。

## 架构概览

建议把新功能拆成三层：

1. **宠物定义层**：描述“有哪些宠物”。
2. **宠物状态层**：描述“当前选中了谁、是否唤醒、当前动作是什么”。
3. **设置页展示层**：只负责渲染列表、按钮和当前状态，不直接承担业务规则。

这样做的好处是：

- 新宠物模块和旧宠物模块边界清晰。
- 持久化结构不会污染 `BasicSettings`。
- 后续如果要接入回答链路，可以在独立状态层之上追加，而不需要重写设置页。

## 数据模型

### 宠物定义

```ts
export type CodexPetDefinition = {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "custom";
  preview?: string;
  tags?: string[];
};
```

说明：

- `id` 用于唯一标识。
- `source` 区分内置宠物和用户自定义宠物。
- `preview` 先用于设置页预览，未来可扩展为头像、sprite 或动效资源地址。

### 宠物运行时状态

```ts
export type CodexPetAction = "idle" | "awake" | "thinking" | "greeting" | "sleeping";

export type CodexPetRuntimeState = {
  activePetId: string | null;
  isAwake: boolean;
  currentAction: CodexPetAction;
  updatedAt: number;
};
```

说明：

- `activePetId` 是当前选择的宠物。
- `isAwake` 是唤醒开关。
- `currentAction` 是状态机输出，不直接等同于用户可见的聊天内容。
- `updatedAt` 便于后续做恢复、调试或同步。

## 持久化策略

建议使用独立存储 key，不放进 `BASIC_SETTINGS_STORAGE_KEY`：

- `omni_codex_pet_catalog`
- `omni_codex_pet_state`

理由：

- 宠物是独立功能域，不应该和主题、窗口尺寸、快捷键混成一个对象。
- 独立存储更利于后续导入导出、重置、同步和版本迁移。
- 避免基础设置更新时顺手覆盖宠物数据。

## 设置页交互

宠物区块放在 [`src/components/settings/BasicSettingsSection.tsx`](/D:/AI-Coding/omni/src/components/settings/BasicSettingsSection.tsx) 内，作为单独分区展示。

布局建议：

- 标题：`宠物`
- 当前选中宠物摘要
- 宠物列表
- 操作按钮：`创建自己的宠物`、`刷新`、`唤醒宠物`

交互规则：

- 点击宠物项只切换当前宠物，不影响其它设置。
- `创建自己的宠物` 先进入空白创建态，首版可只生成草稿对象。
- `刷新` 只重新加载本地宠物目录或内置列表，不改变当前选中项。
- `唤醒宠物` 只切换 `isAwake` 和 `currentAction`，不接入聊天输出。

视觉要求：

- 宠物列表使用单列滚动容器。
- 不拆分左右两栏，避免占用聊天框和其他设置区域。
- 每个宠物项只保留必要信息：名称、一行中文描述、状态标记。

## 代码边界

建议新增或调整这些文件：

- `src/app/pets/codexPetTypes.ts`
  - 宠物定义、运行时状态、动作枚举。
- `src/app/pets/codexPetStore.ts`
  - 宠物目录加载、当前选择、唤醒/休眠、持久化。
- `src/components/settings/PetSettingsSection.tsx`
  - 宠物列表、当前选择、操作按钮。
- `src/components/settings/BasicSettingsSection.tsx`
  - 只挂载宠物分区，不内嵌复杂逻辑。
- `src/app/settingsStore.ts`
  - 新增宠物存储读写入口。
- `src/app/constants.ts`
  - 新增宠物相关 storage key。
- `src/hooks/useMainWindowController.ts`
  - 只补 bootstrap，不改旧小窗宠物链路。

保持不变或尽量少动：

- [`src/components/DesktopPet.tsx`](/D:/AI-Coding/omni/src/components/DesktopPet.tsx)
- [`src/components/CompactWindow.tsx`](/D:/AI-Coding/omni/src/components/CompactWindow.tsx)
- [`src/hooks/useCompactWindowState.ts`](/D:/AI-Coding/omni/src/hooks/useCompactWindowState.ts)

## 风险与约束

- 现有仓库里有旧宠物和旧设置逻辑，不能直接复用成同一个状态源。
- 首版如果把“唤醒宠物”做成聊天联动，容易重新引入之前的布局问题，所以要延后。
- 宠物功能的视觉和状态管理要分离，避免在设置页里形成另一个“浮动面板系统”。

## 验证标准

完成后至少满足：

- 设置页能显示独立的宠物分区。
- 当前宠物切换不会影响主题、窗口尺寸、快捷键等其他设置。
- `唤醒宠物` 只改变宠物状态，不影响聊天页、小窗和旧宠物。
- `pnpm exec tsc --noEmit` 通过。
- `pnpm tauri dev` 下设置页布局没有重叠、挤压和跑位。
