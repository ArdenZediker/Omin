# Omni 桌宠 V3 大图集计划

## 规格

- 图集：`8 x 26`
- 单元：`192 x 208`
- 总尺寸：`1536 x 5408`
- 动作：25 行
- 预留：1 行

## 动作覆盖

| 行 | 状态 | 分组 | 场景 |
| --- | --- | --- | --- |
| 0 | `idle-front` | 基础 | 待机 |
| 1 | `blink` | 基础 | 眨眼 |
| 2 | `turn-head` | 基础 | 转头 |
| 3 | `sit` | 基础 | 坐下 |
| 4 | `lay-down` | 基础 | 趴下 |
| 5 | `sleep` | 基础 | 睡觉 |
| 6 | `greet` | 交互 | 打招呼 |
| 7 | `happy` | 交互 | 开心 |
| 8 | `clingy` | 交互 | 撒娇 |
| 9 | `curious` | 交互 | 疑惑 |
| 10 | `wait` | 交互 | 等待 |
| 11 | `clicked-reaction` | 交互 | 被点击反应 |
| 12 | `thinking` | 工作 | 思考 |
| 13 | `query` | 工作 | 查询 |
| 14 | `reading` | 工作 | 读书 |
| 15 | `computer` | 工作 | 电脑前 |
| 16 | `task-done` | 工作 | 完成任务 |
| 17 | `sad` | 工作 | 失败/委屈 |
| 18 | `walk` | 移动 | 走路 |
| 19 | `run` | 移动 | 奔跑 |
| 20 | `jump` | 移动 | 跳跃 |
| 21 | `dragging` | 移动 | 拖动中 |
| 22 | `magic-form` | 彩蛋 | 魔法变身 |
| 23 | `cool-entry` | 彩蛋 | 墨镜登场 |
| 24 | `heart-moment` | 彩蛋 | 爱心时刻 |
| 25 | `reserved` | 预留 | 后续扩展 |

## 生成策略

1. 复用 V2 已经 QA 通过的动作行，先填充 V3 对应动作。
2. 只重新生成 V3 缺失动作，降低角色不一致风险。
3. 每行生成后立刻执行 `pnpm pet:v3:normalize <state>`。
4. 全部动作就位后执行 `pnpm pet:v3:compose`。
5. 合成通过后再复制到 `public/pets/omni-pet-v3.webp` 并切换运行时。
