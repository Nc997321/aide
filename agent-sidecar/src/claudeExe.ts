// claude.exe 解析：AIDE_CLAUDE_EXE 优先，兜底从 SDK 主包 realpath 找平台包。
//
// 背景（2026-08-21 实锤）：pnpm 不 hoist optional 依赖——平台包
// （@anthropic-ai/claude-agent-sdk-win32-x64 等）是 SDK 主包的 optionalDependencies，
// 只装在 .pnpm 里，顶层 node_modules/@anthropic-ai/ 下没有它的链接。而 esbuild
// bundle 后 import.meta.url 指向 dist/runtime.js，SDK 默认查找
// （createRequire(import.meta.url) 向上找 node_modules）从 dist/ 解析必然失败，
// 抛 "Native CLI binary for win32-x64 not found"。
//
// 这里从 SDK 主包（顶层链接存在，能解析）realpath 到真实目录，再从真实目录
// 相对找平台包——npm/yarn 平铺（node_modules/@anthropic-ai/ 下同级）和 pnpm
// （.pnpm/<sdk-hash>/node_modules/@anthropic-ai/ 下同级）两种布局都覆盖，
// 不依赖顶层平台包链接。
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const req = createRequire(import.meta.url);

// 进程内缓存（node_modules 布局进程内不变）；不缓存 undefined——依赖半装
// 修复后重试仍有机会解析成功。
let cached: string | undefined;

export function resolveClaudeExe(): string | undefined {
  if (process.env.AIDE_CLAUDE_EXE) return process.env.AIDE_CLAUDE_EXE;
  if (cached) return cached;
  try {
    // 解析主包入口（sdk.mjs）而非 package.json——SDK 的 exports 字段不放行 ./package.json。
    const sdkEntry = req.resolve("@anthropic-ai/claude-agent-sdk");
    const sdkDir = dirname(realpathSync(sdkEntry));
    const platformPkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const exeName = process.platform === "win32" ? "claude.exe" : "claude";
    // sdkDir/../.. = node_modules（平铺）或 .pnpm/<sdk-hash>/node_modules（pnpm），
    // 平台包与 SDK 主包同级：<dir>/@anthropic-ai/<platformPkg>/<exe>
    const exe = join(sdkDir, "..", "..", platformPkg, exeName);
    if (existsSync(exe)) {
      cached = exe;
      return exe;
    }
  } catch {
    // 解析失败 → undefined，SDK 走默认查找（可能报错，由调用方处理）
  }
  return undefined;
}
