import fs from "node:fs";
import path from "node:path";

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const ATLAS_COLUMNS = 8;
const ATLAS_ROWS = 16;

const ROWS = [
  { state: "idle-front", row: 0, frames: 6, purpose: "正面待机" },
  { state: "idle-side", row: 1, frames: 6, purpose: "侧面待机" },
  { state: "idle-back", row: 2, frames: 4, purpose: "背面待机" },
  { state: "walk", row: 3, frames: 6, purpose: "行走循环" },
  { state: "run", row: 4, frames: 6, purpose: "奔跑循环" },
  { state: "happy", row: 5, frames: 4, purpose: "开心表情" },
  { state: "blink", row: 6, frames: 4, purpose: "自然眨眼" },
  { state: "surprised", row: 7, frames: 5, purpose: "惊讶反应" },
  { state: "sad", row: 8, frames: 5, purpose: "委屈难过" },
  { state: "curious", row: 9, frames: 5, purpose: "歪头好奇" },
  { state: "greet", row: 10, frames: 4, purpose: "打招呼" },
  { state: "clingy", row: 11, frames: 5, purpose: "撒娇互动" },
  { state: "stretch", row: 12, frames: 5, purpose: "伸懒腰" },
  { state: "sleep", row: 13, frames: 5, purpose: "睡觉" },
  { state: "reading", row: 14, frames: 4, purpose: "看书思考" },
  { state: "computer", row: 15, frames: 4, purpose: "电脑前工作" },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function makeGuideSvg(frames) {
  const width = frames * CELL_WIDTH;
  const height = CELL_HEIGHT;
  const cols = Array.from({ length: frames + 1 }, (_, i) => i * CELL_WIDTH);
  const rows = [0, height];
  const safeX = 18;
  const safeY = 16;
  const rects = Array.from({ length: frames }, (_, i) => {
    const x = i * CELL_WIDTH + safeX;
    const y = safeY;
    const w = CELL_WIDTH - safeX * 2;
    const h = CELL_HEIGHT - safeY * 2;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#00ffff" stroke-width="2" stroke-dasharray="6 4" />`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#00ff00" />
  ${cols.map((x) => `<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="#0044ff" stroke-width="2" />`).join("\n  ")}
  ${rows.map((y) => `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#0044ff" stroke-width="2" />`).join("\n  ")}
  ${rects}
</svg>
`;
}

function makeRowPrompt(unifiedDescription, state, purpose, frames) {
  return `# ${state}

统一角色：${unifiedDescription}

动作目标：${purpose}

输出要求：
- 输出一整行横向动作条，共 ${frames} 帧。
- 每帧角色完整显示，不能跨格、不能裁切。
- 使用纯色 #00ff00 抠图背景，不能有渐变、地面阴影或投影。
- 不允许速度线、落地尘土、漂浮特效、文字、网格线或帧编号。
- 角色脸型、眼睛、毛色、项圈、吊牌必须与基础参考一致。
- 动作主要通过姿态、头部角度、眼神、耳朵、尾巴和前爪表达。
`;
}

function main() {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("Usage: node scripts/pet_v2/plan_pet_v2_run.mjs <run-dir>");
    process.exit(1);
  }

  const unifiedDescription =
    "一只迷你雪纳瑞桌宠，Q 版比例，大头小身体，黑灰色毛发，米白色眉毛和嘴边胡须，圆润大眼睛，蓝色项圈，金色圆环吊牌。整体轮廓简洁，边缘干净，平涂赛璐璐质感，深色描边。";

  ensureDir(runDir);
  ensureDir(path.join(runDir, "prompts", "rows"));
  ensureDir(path.join(runDir, "references", "layout-guides"));
  ensureDir(path.join(runDir, "sources"));
  ensureDir(path.join(runDir, "decoded"));
  ensureDir(path.join(runDir, "final"));
  ensureDir(path.join(runDir, "qa"));

  const manifest = {
    pet_id: "omni-pet-v2",
    display_name: "Omni Pet Atlas V2",
    description: "参考雪纳瑞桌宠动作板整理的 8x16 桌宠图集。",
    atlas: {
      columns: ATLAS_COLUMNS,
      rows: ATLAS_ROWS,
      cell_width: CELL_WIDTH,
      cell_height: CELL_HEIGHT,
      width: ATLAS_COLUMNS * CELL_WIDTH,
      height: ATLAS_ROWS * CELL_HEIGHT,
    },
    rows: ROWS,
  };

  writeText(path.join(runDir, "pet_request.json"), JSON.stringify(manifest, null, 2));

  const jobManifest = {
    schema_version: 1,
    run_dir: path.resolve(runDir),
    notes: "项目内 8x16 桌宠图集工作流，不依赖系统 hatch-pet 的 8x9 限制。",
    jobs: ROWS.map((row) => ({
      id: row.state,
      kind: "row-strip",
      state: row.state,
      row: row.row,
      frames: row.frames,
      purpose: row.purpose,
      prompt_file: `prompts/rows/${row.state}.md`,
      guide_file: `references/layout-guides/${row.state}.svg`,
      source_path: `sources/${row.state}.png`,
      output_path: `decoded/${row.state}.png`,
      status: "pending",
    })),
  };

  writeText(path.join(runDir, "jobs.json"), JSON.stringify(jobManifest, null, 2));

  for (const row of ROWS) {
    writeText(path.join(runDir, "prompts", "rows", `${row.state}.md`), makeRowPrompt(unifiedDescription, row.state, row.purpose, row.frames));
    writeText(path.join(runDir, "references", "layout-guides", `${row.state}.svg`), makeGuideSvg(row.frames));
  }

  console.log(path.resolve(runDir));
}

main();
