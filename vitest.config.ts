import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [vue()],
  // 对齐 vite.config.ts 的 `@ → src` 别名——否则 import "@/composables/..."
  // 在 vitest 下解析不了（vite 有 resolve.alias，tsconfig 有 paths，但 vitest
  // 默认两个都不读）。少了这层，useChatSession / usePaneLayout 等用 `@/` 的
  // 测试文件加载即报 "Cannot find package '@/...'"，整文件 0 用例。
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "agent-sidecar/src/**/*.test.ts", "packages/**/*.test.ts"],
  },
});