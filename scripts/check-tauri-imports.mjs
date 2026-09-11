// 守门检查：禁止 src/ 与 remote-pwa/ 直接依赖 @tauri-apps/*。
// 原则（见 docs/optimization-roadmap.md 优化项一）：所有 Tauri 命令/事件/外链
// 调用必须经 @aide/sdk 门面（唯一入口），绕行会让 RemoteTransport 侧静默缺失能力。
// 项目无 ESLint 基础设施，以 CI grep 脚本代偿。例外在此集中登记：
//   - main.ts：全局错误捕获在 SDK 初始化前运行（初始化路径，roadmap 明示豁免）
//   - useWindowControls/useWindowFocus/useNotification：窗口 chrome/焦点/任务栏进度，
//     桌面壳专属语义，无远程对应能力
//   - useEmbeddedBrowser：内嵌浏览器（原生子 webview），桌面壳专属——remote-pwa 本身跑在
//     真浏览器里、ohos 走 relay，无远程对应能力；加进共享门面只会给 RemoteTransport 塞空能力
//   - *.test.ts：vi.mock("@tauri-apps/*") 是合法 mock 边界（拦截 SDK transport 的静态导入）
// 新增例外必须在此登记并写明理由，否则 CI 失败。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["src", "remote-pwa"];
const EXTS = new Set([".ts", ".mts", ".vue"]);
// 相对仓库根的例外路径（正斜杠）
const EXCEPTIONS = new Set([
  "src/main.ts",
  "src/composables/useWindowControls.ts",
  "src/composables/useWindowFocus.ts",
  "src/composables/useNotification.ts",
  "src/composables/useEmbeddedBrowser.ts",
]);
const isTest = (p) => p.endsWith(".test.ts") || p.includes("/tests/");

// 只认真实导入语句：import ... from "@tauri-apps/x" / import("@tauri-apps/x") / require
const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']@tauri-apps\//;

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // 目录不存在则跳过
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXTS.has(extname(name))) yield full;
  }
}

const violations = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    if (EXCEPTIONS.has(rel) || isTest(rel)) continue;
    const content = readFileSync(file, "utf8");
    if (IMPORT_RE.test(content)) violations.push(rel);
  }
}

if (violations.length) {
  console.error("✗ 发现绕过 @aide/sdk 门面的直接 @tauri-apps/* 导入：");
  for (const v of violations) console.error("  - " + v);
  console.error("\n处理方式：改走 @aide/sdk（api.* / listen / openExternal）；");
  console.error("确属桌面壳专属能力则在 scripts/check-tauri-imports.mjs 登记例外并注明理由。");
  process.exit(1);
}
console.log(`✓ 门面检查通过：${SCAN_DIRS.join(", ")} 无未登记的 @tauri-apps/* 直接导入`);
