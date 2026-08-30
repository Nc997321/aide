// 构建并暂存 aide-codegraph.exe（优化项二：CodeGraph 进程隔离）。
//
// 做三件事：
// 1. cargo build -p codegraph-runner（workspace 成员，产物落 src-tauri/target/<profile>）；
// 2. 把 exe（以及 target 里若有动态库则一并）拷进暂存目录
//    src-tauri/codegraph-dist/（不直接从 target/ 打包——打包输入应是确定性的
//    staging，而非 build 目录的全量内容）。
//    注：当前 ort-sys 2.0.0-rc.9 在 Windows MSVC 下静态链接 onnxruntime，
//    产物无 DLL；此循环是防御性的，将来若切动态链接自动生效。
// 3. tauri.conf.json 的 resources 从 codegraph-dist/ 映射到安装包的 codegraph/
//    子目录（与 agent-sidecar 的 agent-runtime/ 同模式）。
//
// 用法：
//   pnpm build:codegraph            → debug 产物（tauri dev 用）
//   pnpm build:codegraph:release     → release 产物（release 链用）

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcTauri = path.join(root, "src-tauri");
const release = process.argv.includes("--release");
const profile = release ? "release" : "debug";
const staging = path.join(srcTauri, "codegraph-dist");
const exeName = process.platform === "win32" ? "aide-codegraph.exe" : "aide-codegraph";

console.log(`[build-codegraph] cargo build -p codegraph-runner (${profile}) ...`);
const built = spawnSync(
  "cargo",
  ["build", "-p", "codegraph-runner", ...(release ? ["--release"] : [])],
  { cwd: srcTauri, stdio: "inherit", shell: true },
);
if (built.status !== 0) {
  console.error(`[build-codegraph] cargo build failed (exit ${built.status})`);
  process.exit(built.status ?? 1);
}

const binDir = path.join(srcTauri, "target", profile);
const exePath = path.join(binDir, exeName);
if (!existsSync(exePath)) {
  console.error(`[build-codegraph] expected binary missing: ${exePath}`);
  process.exit(1);
}

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
cpSync(exePath, path.join(staging, exeName));
// 防御性 DLL 收集：若构建配置改为动态链接（copy-dylibs 会把 onnxruntime.dll
// 放在 exe 旁），随 exe 一起进暂存目录；当前静态链接下通常为 0 个。
let dllCount = 0;
for (const f of readdirSync(binDir)) {
  if (f !== exeName && /\.dll$/i.test(f)) {
    cpSync(path.join(binDir, f), path.join(staging, f));
    dllCount += 1;
  }
}
console.log(`[build-codegraph] staged ${exeName} + ${dllCount} DLL(s) → ${path.relative(root, staging)}`);
