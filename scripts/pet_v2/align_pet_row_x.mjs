import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const ALPHA_THRESHOLD = 8;

function usage() {
  console.error("Usage: node scripts/pet_v2/align_pet_row_x.mjs <run-dir> <state>");
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
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
  const stream = JSON.parse(output).streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw new Error(`无法读取图片尺寸：${filePath}`);
  }
  return { width: stream.width, height: stream.height };
}

function main() {
  const runDir = process.argv[2];
  const state = process.argv[3];
  if (!runDir || !state) usage();

  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "pet_request.json"), "utf8"));
  const row = manifest.rows.find((item) => item.state === state);
  if (!row || row.frames <= 0) {
    throw new Error(`未找到可对齐动作：${state}`);
  }

  const decodedPath = path.join(runDir, "decoded", `${state}.png`);
  const size = ffprobeSize(decodedPath);
  const expectedWidth = row.frames * CELL_WIDTH;
  if (size.width !== expectedWidth || size.height !== CELL_HEIGHT) {
    throw new Error(`${state} 尺寸不匹配：当前 ${size.width}x${size.height}，期望 ${expectedWidth}x${CELL_HEIGHT}`);
  }

  const raw = run(
    "ffmpeg",
    ["-v", "error", "-i", decodedPath, "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
    {
      encoding: null,
      maxBuffer: size.width * size.height * 4 + 1024,
    }
  );
  const source = Buffer.from(raw);
  const output = Buffer.alloc(source.length);
  const targetCenterX = (CELL_WIDTH - 1) / 2;

  for (let frame = 0; frame < row.frames; frame += 1) {
    let minX = CELL_WIDTH;
    let maxX = -1;

    for (let y = 0; y < CELL_HEIGHT; y += 1) {
      for (let x = 0; x < CELL_WIDTH; x += 1) {
        const globalX = frame * CELL_WIDTH + x;
        const alphaIndex = (y * size.width + globalX) * 4 + 3;
        if (source[alphaIndex] > ALPHA_THRESHOLD) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }
    }

    if (maxX < minX) continue;
    const centerX = (minX + maxX) / 2;
    const shiftX = Math.round(targetCenterX - centerX);

    for (let y = 0; y < CELL_HEIGHT; y += 1) {
      for (let x = 0; x < CELL_WIDTH; x += 1) {
        const targetX = x + shiftX;
        if (targetX < 0 || targetX >= CELL_WIDTH) continue;
        const sourceGlobalX = frame * CELL_WIDTH + x;
        const targetGlobalX = frame * CELL_WIDTH + targetX;
        const sourceIndex = (y * size.width + sourceGlobalX) * 4;
        const targetIndex = (y * size.width + targetGlobalX) * 4;
        output[targetIndex] = source[sourceIndex];
        output[targetIndex + 1] = source[sourceIndex + 1];
        output[targetIndex + 2] = source[sourceIndex + 2];
        output[targetIndex + 3] = source[sourceIndex + 3];
      }
    }
  }

  run(
    "ffmpeg",
    [
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgba",
      "-s",
      `${size.width}x${size.height}`,
      "-i",
      "-",
      decodedPath,
    ],
    {
      input: output,
      maxBuffer: 1024 * 1024,
    }
  );

  const qaPath = path.join(runDir, "qa", "normalized-rows", `${state}.png`);
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
}

main();
