import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [vue()],
  clearScreen: false,
  // 目的：release 压缩后 LoAF 的 `sourceFunctionName` 不能只剩一个字母（真机报告里
  // 出现过 "n"/"W"/"W"）——它是对着报告「点名到函数」的唯一依据，而用户跑的正是
  // release 包。实测（headless Edge 153，2026-09-17）：
  // - `keepNames: true` **不管用**：它给函数补 `__name(fn,"原名")` 只改函数对象的
  //   `.name`，而 LoAF 取的是 V8 栈帧名（=标识符）——`function m(){}` 配
  //   `__name(m,"onScrollHandler")`，报告里读到的仍是 "m"。
  // - `minifyIdentifiers: false` 才有效：保留标识符即保留栈帧名。
  // 代价实测：index 主 chunk 1.15MB→1.65MB、**gzip +66KB（+17%）**。桌面应用付得起
  // （安装包按 MB 计），换来的是下次冻结能直接点名到函数——这是整套诊断的目的。
  esbuild: {
    minifyIdentifiers: false,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          xterm: ["xterm", "xterm-addon-fit"],
          hljs: ["highlight.js/lib/core"],
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: false,
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
}));
