import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const host = loadEnv(mode, process.cwd(), "").TAURI_DEV_HOST;

  return {
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) {
              return undefined;
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
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
