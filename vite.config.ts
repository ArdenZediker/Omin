import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileViewerRenderers } from "@file-viewer/vite-plugin";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const host = loadEnv(mode, process.cwd(), "").TAURI_DEV_HOST;

  return {
    plugins: [react(), tailwindcss(), fileViewerRenderers({ copyAssets: true })],
    build: {
      rollupOptions: {
        output: {
          // 默认命名 `assets/[name]-[hash].[ext]` 对「无扩展名」的资源（依赖包自带的
          // LICENSE / NOTICE 等）会生成以点结尾的文件名，如 `LICENSE-CRnx3_A4.`。
          // Node 走 `\\?\` 前缀能创建它，但 Windows 的 Win32 API 在读取时会剥离尾部点，
          // 于是 Rust 侧 `tauri::generate_context!()` 找不到该文件、打包在最后一步失败：
          //   error: failed to read asset at ...\dist\assets\LICENSE-CRnx3_A4.
          // 这里按有无扩展名分别命名，保证不产生尾点文件名。
          assetFileNames: (assetInfo) => {
            const original = assetInfo.names?.[0] ?? assetInfo.name ?? "";
            const dot = original.lastIndexOf(".");
            const ext = dot > 0 ? original.slice(dot) : "";
            return `assets/[name]-[hash]${ext}`;
          },
          manualChunks(id) {
            if (!id.includes("node_modules")) {
              return undefined;
            }
            // 注意：必须放在 react 判断之前 —— "@file-viewer/react" 路径包含 "react"
            if (id.includes("@file-viewer")) {
              return "vendor-file-viewer";
            }
            if (id.includes("pdfjs-dist")) {
              return "vendor-pdf";
            }
            if (id.includes("mammoth")) {
              return "vendor-mammoth";
            }
            if (id.includes("docx-preview")) {
              return "vendor-docx";
            }
            if (id.includes("@lobehub/icons-static-svg")) {
              return "vendor-provider-icons";
            }
            if (id.includes("lucide-react")) {
              return "vendor-icons";
            }
            if (id.includes("react") || id.includes("react-dom") || id.includes("scheduler")) {
              return "vendor-react";
            }
            if (
              id.includes("react-markdown") ||
              id.includes("remark-") ||
              id.includes("rehype-") ||
              id.includes("unified") ||
              id.includes("micromark") ||
              id.includes("markdown-table") ||
              id.includes("mdast") ||
              id.includes("hast") ||
              id.includes("unist") ||
              id.includes("vfile") ||
              id.includes("property-information") ||
              id.includes("decode-named-character-reference") ||
              id.includes("comma-separated-tokens") ||
              id.includes("space-separated-tokens") ||
              id.includes("trim-lines") ||
              id.includes("zwitch")
            ) {
              return "vendor-markdown";
            }
            if (id.includes("@tauri-apps")) {
              return "vendor-tauri";
            }
            return "vendor";
          },
        },
      },
      target: "es2022",
      cssCodeSplit: true,
      sourcemap: false,
      chunkSizeWarningLimit: 2000,
      reportCompressedSize: false,
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      // 端口必须避开 Windows 动态端口范围（本机为 1024-15000）：Hyper-V / WSL / Docker
      // 会在其中整段预留端口（本机被预留的是 1332-1431，覆盖了旧值 1420），
      // 落入该段的端口绑定一律失败并报 `EACCES: permission denied`。
      // 15420 位于动态范围之外，不会被动态预留抢走。
      port: 15420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 15421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
