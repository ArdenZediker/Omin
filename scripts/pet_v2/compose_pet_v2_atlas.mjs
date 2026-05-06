import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function ffprobeSize(filePath) {
  const output = run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(output);
  const stream = parsed.streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw new Error(`无法读取图片尺寸：${filePath}`);
  }
  return { width: stream.width, height: stream.height };
}

function main() {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("Usage: node scripts/pet_v2/compose_pet_v2_atlas.mjs <run-dir>");
    process.exit(1);
  }

  const manifestPath = path.join(runDir, "pet_request.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const cellWidth = manifest.atlas.cell_width;
  const cellHeight = manifest.atlas.cell_height;
  const atlasColumns = manifest.atlas.columns;
  const atlasRows = manifest.atlas.rows;
  const rows = manifest.rows.filter((row) => row.frames > 0);
  const canvasWidth = atlasColumns * cellWidth;
  const canvasHeight = atlasRows * cellHeight;
  const missing = [];
  const inputs = [];
  const overlays = [];

  for (const row of rows) {
    const stripPath = path.join(runDir, "decoded", `${row.state}.png`);
    if (!fs.existsSync(stripPath)) {
      missing.push(row.state);
      continue;
    }

    const size = ffprobeSize(stripPath);
    const expectedWidth = row.frames * cellWidth;
    if (size.width !== expectedWidth || size.height !== cellHeight) {
      throw new Error(`${row.state} 尺寸不匹配：当前 ${size.width}x${size.height}，期望 ${expectedWidth}x${cellHeight}`);
    }

    inputs.push(stripPath);
    overlays.push({ top: row.row * cellHeight, inputIndex: inputs.length });
  }

  if (missing.length > 0) {
    throw new Error(`缺少 decoded 行图：${missing.join(", ")}`);
  }

  ensureDir(path.join(runDir, "final"));
  const pngPath = path.join(runDir, "final", "spritesheet.png");
  const webpPath = path.join(runDir, "final", "spritesheet.webp");
  const ffmpegInputs = inputs.flatMap((input) => ["-i", input]);
  let filter = "[0:v]format=rgba[base];";
  let current = "base";

  overlays.forEach((overlay, index) => {
    const next = `layer${index}`;
    filter += `[${current}][${overlay.inputIndex}:v]overlay=0:${overlay.top}:format=auto[${next}];`;
    current = next;
  });
  filter += `[${current}]format=rgba[out]`;

  run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black@0.0:s=${canvasWidth}x${canvasHeight},format=rgba`,
    ...ffmpegInputs,
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-frames:v",
    "1",
    pngPath,
  ]);

  run("ffmpeg", [
    "-y",
    "-i",
    pngPath,
    "-c:v",
    "libwebp",
    "-lossless",
    "1",
    "-compression_level",
    "6",
    "-q:v",
    "100",
    "-pix_fmt",
    "yuva420p",
    webpPath,
  ]);
  console.log(webpPath);
}

main();
