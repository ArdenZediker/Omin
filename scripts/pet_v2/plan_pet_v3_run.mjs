import fs from "node:fs";
import path from "node:path";

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const ATLAS_COLUMNS = 8;
const ATLAS_ROWS = 26;

const ROWS = [
  { state: "idle-front", row: 0, frames: 6, group: "基础", purpose: "待机" },
  { state: "blink", row: 1, frames: 4, group: "基础", purpose: "眨眼" },
  { state: "turn-head", row: 2, frames: 6, group: "基础", purpose: "转头" },
  { state: "sit", row: 3, frames: 4, group: "基础", purpose: "坐下" },
  { state: "lay-down", row: 4, frames: 5, group: "基础", purpose: "趴下" },
  { state: "sleep", row: 5, frames: 5, group: "基础", purpose: "睡觉" },
  { state: "greet", row: 6, frames: 4, group: "交互", purpose: "打招呼" },
  { state: "happy", row: 7, frames: 4, group: "交互", purpose: "开心" },
  { state: "clingy", row: 8, frames: 5, group: "交互", purpose: "撒娇" },
  { state: "curious", row: 9, frames: 5, group: "交互", purpose: "疑惑" },
  { state: "wait", row: 10, frames: 5, group: "交互", purpose: "等待" },
  { state: "clicked-reaction", row: 11, frames: 5, group: "交互", purpose: "被点击反应" },
  { state: "thinking", row: 12, frames: 5, group: "工作", purpose: "思考" },
  { state: "query", row: 13, frames: 5, group: "工作", purpose: "查询" },
  { state: "reading", row: 14, frames: 4, group: "工作", purpose: "读书" },
  { state: "computer", row: 15, frames: 4, group: "工作", purpose: "电脑前" },
  { state: "task-done", row: 16, frames: 5, group: "工作", purpose: "完成任务" },
  { state: "sad", row: 17, frames: 5, group: "工作", purpose: "失败/委屈" },
  { state: "walk", row: 18, frames: 6, group: "移动", purpose: "走路" },
  { state: "run", row: 19, frames: 6, group: "移动", purpose: "奔跑" },
  { state: "jump", row: 20, frames: 5, group: "移动", purpose: "跳跃" },
  { state: "dragging", row: 21, frames: 5, group: "移动", purpose: "拖动中" },
  { state: "magic-form", row: 22, frames: 5, group: "彩蛋", purpose: "魔法变身" },
  { state: "cool-entry", row: 23, frames: 4, group: "彩蛋", purpose: "墨镜登场" },
  { state: "heart-moment", row: 24, frames: 5, group: "彩蛋", purpose: "爱心时刻" },
  { state: "reserved", row: 25, frames: 0, group: "预留", purpose: "后续扩展" },
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function makeGuideSvg(frames) {
  const width = Math.max(frames, 1) * CELL_WIDTH;
  const height = CELL_HEIGHT;
  const cols = Array.from({ length: frames + 1 }, (_, i) => i * CELL_WIDTH);
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
  ${rects}
</svg>
`;
}

function makeRowPrompt(unifiedDescription, row) {
  return `# ${row.state}

动作分组：${row.group}
动作目标：${row.purpose}

统一角色：${unifiedDescription}

输出要求：
- 输出一整行横向动作条，共 ${row.frames} 帧。
- 每帧只放 1 个完整角色，角色必须居中在自己的等宽区域内。
- 左右保留纯绿色空白，耳朵、尾巴、爪子、道具和特效都不能跨格或裁切。
- 背景必须是纯色 #00ff00，不能有渐变、地面阴影、投影、发光或复杂背景。
- 不要文字、边框、网格、帧编号、UI 元素、独立漂浮符号。
- 允许轻量特效时，必须贴近角色主体，并且不能影响透明背景抠图。
- 角色脸型、眼睛、毛色、项圈、吊牌必须与现有 Omni 雪纳瑞桌宠一致。
`;
}

function main() {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("Usage: node scripts/pet_v2/plan_pet_v3_run.mjs <run-dir>");
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

  const activeRows = ROWS.filter((row) => row.frames > 0);
  const manifest = {
    pet_id: "omni-pet-v3",
    display_name: "Omni Pet Atlas V3",
    description: "覆盖基础、交互、工作、移动、彩蛋场景的 8x26 桌宠专用大图集。",
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
    notes: "项目内 8x26 桌宠正式图集工作流，覆盖完整场景动作。",
    jobs: activeRows.map((row) => ({
      id: row.state,
      kind: "row-strip",
      state: row.state,
      row: row.row,
      frames: row.frames,
      group: row.group,
      purpose: row.purpose,
      prompt_file: `prompts/rows/${row.state}.md`,
      guide_file: `references/layout-guides/${row.state}.svg`,
      source_path: `sources/${row.state}.png`,
      output_path: `decoded/${row.state}.png`,
      status: "pending",
    })),
  };

  writeText(path.join(runDir, "jobs.json"), JSON.stringify(jobManifest, null, 2));

  for (const row of activeRows) {
    writeText(path.join(runDir, "prompts", "rows", `${row.state}.md`), makeRowPrompt(unifiedDescription, row));
    writeText(path.join(runDir, "references", "layout-guides", `${row.state}.svg`), makeGuideSvg(row.frames));
  }

  console.log(path.resolve(runDir));
}

main();
