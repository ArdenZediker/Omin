import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const SPRITE_MAX_WIDTH = 172;
const SPRITE_MAX_HEIGHT = 187;
function usage() {
  console.error("Usage: node scripts/pet_v2/normalize_pet_v2_row.mjs <run-dir> <state>");
  process.exit(1);
}

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
  const state = process.argv[3];
  if (!runDir || !state) {
    usage();
  }

  const manifestPath = path.join(runDir, "pet_request.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const row = manifest.rows.find((item) => item.state === state);
  if (!row) {
    throw new Error(`未在 pet_request.json 中找到动作：${state}`);
  }

  const sourcePath = path.join(runDir, "sources", `${state}.png`);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`缺少源图：${sourcePath}`);
  }

  const sourceSize = ffprobeSize(sourcePath);
  const decodedDir = path.join(runDir, "decoded");
  const qaDir = path.join(runDir, "qa", "normalized-rows");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `omni-pet-${state}-`));
  ensureDir(decodedDir);
  ensureDir(qaDir);

  try {
    const frameSourceWidth = sourceSize.width / row.frames;
    const cropTop = Math.max(0, Math.round(sourceSize.height * 0.18));
    const cropHeight = Math.min(sourceSize.height - cropTop, Math.round(sourceSize.height * 0.68));
    const framePaths = [];

    for (let index = 0; index < row.frames; index += 1) {
      const cropLeft = Math.round(index * frameSourceWidth);
      const cropWidth = Math.round((index + 1) * frameSourceWidth) - cropLeft;
      const framePath = path.join(tmpDir, `frame-${String(index).padStart(2, "0")}.png`);
      const filter = [
        `crop=${cropWidth}:${cropHeight}:${cropLeft}:${cropTop}`,
        "colorkey=0x00ff00:0.28:0.08",
        "crop=iw-4:ih-4:2:2",
        `scale=${SPRITE_MAX_WIDTH}:${SPRITE_MAX_HEIGHT}:force_original_aspect_ratio=decrease`,
        `pad=${CELL_WIDTH}:${CELL_HEIGHT}:(ow-iw)/2:oh-ih:color=black@0`,
        "format=rgba",
      ].join(",");

      run("ffmpeg", ["-y", "-i", sourcePath, "-vf", filter, "-frames:v", "1", framePath]);
      framePaths.push(framePath);
    }

    const decodedPath = path.join(decodedDir, `${state}.png`);
    const hstackInputs = framePaths.flatMap((framePath) => ["-i", framePath]);
    const hstackLabels = framePaths.map((_, index) => `[${index}:v]`).join("");
    run("ffmpeg", [
      "-y",
      ...hstackInputs,
      "-filter_complex",
      `${hstackLabels}hstack=inputs=${framePaths.length},format=rgba[out]`,
      "-map",
      "[out]",
      decodedPath,
    ]);

    const qaPath = path.join(qaDir, `${state}.png`);
    run("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=0xf3f4f6:s=${row.frames * CELL_WIDTH}x${CELL_HEIGHT}`,
      "-i",
      decodedPath,
      "-filter_complex",
      "[0:v][1:v]overlay=0:0:format=auto,format=rgb24[out]",
      "-map",
      "[out]",
      "-frames:v",
      "1",
      qaPath,
    ]);

    console.log(decodedPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
