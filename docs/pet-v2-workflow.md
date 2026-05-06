# Omni 桌宠 V2 工作流

## 当前状态

系统 `hatch-pet` 技能脚本固定为 `8x9` 图集，不能直接用于 `8x16`。项目内新增 `scripts/pet_v2`，用于准备、标准化和组装下一版 `8x16` 桌宠图集。

默认运行目录：

```text
output/pet-v2/omni-pet-v2/
```

关键文件：
- `pet_request.json`：图集规格与动作行定义。
- `jobs.json`：每行动作生成任务。
- `prompts/rows/*.md`：每行动作提示词。
- `references/layout-guides/*.svg`：每行动作布局参考。
- `sources/*.png`：图片生成得到的原始行图。
- `decoded/*.png`：标准化后的动作行图。
- `final/spritesheet.webp`：最终大图集。

## 命令

生成任务目录：

```bash
pnpm pet:v2:plan
```

把某个源图标准化为 `decoded` 行图：

```bash
pnpm pet:v2:normalize idle-front
```

组装最终图集：

```bash
pnpm pet:v2:compose
```

`normalize` 和 `compose` 使用本机 `ffmpeg / ffprobe`，不新增 Node 图像处理依赖。

## 行图要求

每个 `decoded/<state>.png` 必须是横向动作条：
- 高度：`208`
- 单帧宽度：`192`
- 总宽度：`frames * 192`
- 背景必须透明
- 不允许跨格、裁切、重复错位

## 接入应用

生成完成后：

1. 把 `output/pet-v2/omni-pet-v2/final/spritesheet.webp` 放到 `public/pets/omni-pet-v2.webp`。
2. 将运行时 manifest 切换到 `src/config/pets/omniPetAtlasV2.ts`。
3. 运行 `pnpm build`。

## 第一轮优先动作

先生成这 5 行，用于确认身份一致性和核心体验：
- `idle-front`
- `walk`
- `run`
- `curious`
- `computer`

确认角色一致后，再生成其余动作。
