import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts", "agent-sidecar/src/**/*.test.ts"] },
});