#!/usr/bin/env node
/**
 * 把 file-viewer 渲染器运行时资源（worker / wasm / cmaps / 字体，约 29MB / 315 个文件）
 * 物化到 `public/`，供 `vite build` 原生拷贝进 `dist/`。
 *
 * 为什么需要它
 * ------------
 * `vite.config.ts` 用的是 `fileViewerRenderers({ copyAssets: { mode: 'dev' } })`：
 *   - dev：插件在 configureServer 里把资源拷到 `public/`（与本脚本同一件事）。
 *   - build：插件完全不插手，由 vite 原生 `publicDir → outDir` 拷贝负责分发。
 *
 * 为什么 build 阶段要关掉插件的拷贝
 * --------------------------------
 * 插件在 build 时的实现是 `copyDirectoryIfPresent()`：先 `rm(to, {recursive})`
 * 再 `cp(from, to, {recursive})`。而它的目标正是**刚被 vite 写好的 `dist/vendor/**`**，
 * 于是每次 build 都会把 vite 刚拷好的 315 个文件删掉、再原样重拷一遍。
 *
 * 一旦文件系统上有过滤层拖慢非临时路径的写入（本机实测：非 Temp 路径约 21ms/文件，
 * Temp 路径约 0.3ms/文件，相差约 78 倍），这个「删掉重拷」的窗口会长时间没有进展、
 * 表现为 `✓ built in 30s` 之后构建再也不结束（dist/vendor 停在 212/315 个文件）。
 *
 * 改成只让 vite 拷一次之后：构建 30s 内结束，且 `dist/vendor` 是完整的 315 个文件。
 *
 * 本脚本只调用插件导出的公开 API，做的事等价于「启动一次 dev server」。
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileViewerRenderers } from "@file-viewer/vite-plugin";

const projectRoot = process.cwd();
const publicDir = "public";
const outDir = "dist";

const callHook = (hook, ...args) => {
  if (typeof hook === "function") return hook(...args);
  if (hook && typeof hook.handler === "function") return hook.handler(...args);
  return undefined;
};

const plugin = fileViewerRenderers({ copyAssets: { mode: "dev" } });

// 插件的 configureServer 依赖 config()/configResolved() 里算出来的
// selection / installedFullPackages / resolvedConfig，按 vite 的顺序喂给它。
await callHook(plugin.config, { root: projectRoot, base: "/" });
await callHook(plugin.configResolved, {
  root: projectRoot,
  base: "/",
  publicDir,
  command: "serve",
  build: { outDir },
});

// 传 `{}` 即可：插件末尾的 `server?.middlewares?.use` 是可选链，不会真的注册中间件。
await callHook(plugin.configureServer, {});

const vendorDir = resolve(projectRoot, publicDir, "vendor");
const manifest = resolve(projectRoot, publicDir, "flyfish-viewer-assets.json");
if (!existsSync(vendorDir) || !existsSync(manifest)) {
  console.error(
    `[sync-file-viewer-assets] 失败：期望生成 ${vendorDir} 与 ${manifest}，但未找到。\n` +
      `  请确认 @file-viewer/vite-plugin 与各 renderer 包已安装（pnpm install）。`,
  );
  process.exit(1);
}

console.log(`[sync-file-viewer-assets] 渲染器资源已就绪：${vendorDir}`);
