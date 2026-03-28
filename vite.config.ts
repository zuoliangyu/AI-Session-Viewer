import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => {
  const pkg = await import("./package.json", { with: { type: "json" } });
  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    define: {
      __IS_TAURI__: JSON.stringify(!!process.env.TAURI_ENV_PLATFORM),
      __APP_VERSION__: JSON.stringify(pkg.default.version),
    },
    build: {
      target: "es2022",
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) {
              return;
            }
            if (
              id.includes("react-markdown") ||
              id.includes("react-syntax-highlighter") ||
              id.includes("remark-gfm") ||
              id.includes("rehype")
            ) {
              return "markdown-vendor";
            }
            if (id.includes("recharts") || id.includes("d3-")) {
              return "charts-vendor";
            }
            if (id.includes("lucide-react")) {
              return "icons-vendor";
            }
            if (id.includes("react-router") || id.includes("@tanstack/")) {
              return "routing-vendor";
            }
            if (
              id.includes("react") ||
              id.includes("scheduler") ||
              id.includes("zustand")
            ) {
              return "react-vendor";
            }
          },
        },
      },
    },
    clearScreen: false,
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
        ignored: ["**/src-tauri/**"],
      },
    },
  };
});
