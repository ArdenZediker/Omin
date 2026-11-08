import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "src", "agent-host", "main.ts");
const outputDirectory = join(root, "src-tauri", "binaries");

function hostTriple() {
  const platform = process.platform;
  const architecture = process.arch;
  if (platform === "win32" && architecture === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "win32" && architecture === "arm64") return "aarch64-pc-windows-msvc";
  if (platform === "darwin" && architecture === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && architecture === "x64") return "x86_64-apple-darwin";
  if (platform === "linux" && architecture === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "linux" && architecture === "arm64") return "aarch64-unknown-linux-gnu";
  throw new Error(`unsupported Agent Host build host: ${platform}-${architecture}`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: "inherit",
  });
}

function sameTargetPlatform(triple) {
  if (process.platform === "win32") return triple.endsWith("-windows-msvc");
  if (process.platform === "darwin") return triple.endsWith("-apple-darwin");
  return triple.includes("-linux-");
}

async function nodeSeaFuse() {
  const binary = await readFile(process.execPath);
  const match = binary.toString("latin1").match(/NODE_SEA_FUSE_[a-f0-9]+/);
  if (!match) {
    throw new Error("build-agent-host: Node executable has no SEA sentinel fuse");
  }
  return match[0];
}

const target = argument("--target")
  ?? process.env.TAURI_ENV_TARGET_TRIPLE
  ?? process.env.TARGET_TRIPLE
  ?? hostTriple();

if (!sameTargetPlatform(target)) {
  throw new Error(
    `build-agent-host: target ${target} must be built on its own operating system; `
    + `current host is ${process.platform}-${process.arch}`,
  );
}
if (target !== hostTriple()) {
  throw new Error(
    `build-agent-host: target ${target} does not match the Node executable architecture `
    + `${hostTriple()}; run this script on the target runner`,
  );
}

await mkdir(outputDirectory, { recursive: true });
const extension = process.platform === "win32" ? ".exe" : "";
const output = join(outputDirectory, `omni-agent-host-${target}${extension}`);
const temporary = await mkdtemp(join(tmpdir(), "omni-agent-host-build-"));
const bundle = join(temporary, "agent-host.cjs");
const seaConfigPath = join(temporary, "sea-config.json");
const seaBlob = join(temporary, "agent-host.blob");

try {
  run(process.execPath, [
    join(root, "node_modules", "esbuild", "bin", "esbuild"),
    entry,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node22",
    `--outfile=${bundle}`,
  ]);

  await writeFile(seaConfigPath, `${JSON.stringify({
    main: bundle,
    output: seaBlob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgvExtension: "none",
  }, null, 2)}\n`);
  run(process.execPath, ["--experimental-sea-config", seaConfigPath]);

  await rm(output, { force: true });
  await copyFile(process.execPath, output);
  await chmod(output, 0o755);

  if (process.platform === "darwin") {
    run("codesign", ["--remove-signature", output]);
  }
  const postject = join(root, "node_modules", "postject", "dist", "cli.js");
  const sentinelFuse = await nodeSeaFuse();
  run(process.execPath, [
    postject,
    output,
    "NODE_SEA_BLOB",
    seaBlob,
    "--sentinel-fuse",
    sentinelFuse,
    ...(process.platform === "darwin"
      ? ["--macho-segment-name", "NODE_SEA"]
      : []),
  ]);
  if (process.platform === "darwin") {
    run("codesign", ["--sign", "-", output]);
  }

  const size = (await stat(output)).size;
  process.stdout.write(
    `build-agent-host: ${output} (${(size / 1024 / 1024).toFixed(1)} MB)\n`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
