// 守门检查：做磁盘 IO / 起子进程的**同步** Tauri 命令必须埋 trace_command。
//
// 原则（CLAUDE.md「同步 command 禁止重 IO / 重 CPU」的中间桶）：Tauri 的非 async
// command 跑在**主线程**上，一句 fs::read/write 就能把整个 UI 冻住——杀软 on-access
// 扫描曾把一次 fs::write 拖到 7.87 秒（2026-09-05 freeze-1788610528313：
// remove_recent_session 的 cmd_enter→cmd_exit 跨 7.87s，主线程全程被占、无人烧 CPU）。
//
// 规则分两档，本脚本守的是第二档：
//   1. 重 IO/CPU → **必须** async + spawn_blocking（本脚本不强制，靠评审与审计）；
//   2. 介于之间、决定保留同步 → **必须**埋 trace_command，让冻结报告能点名。
//
// 为什么守第二档而不是把 25 条全判违规：它们是有成本核算的既存决定，硬报错等于把
// 构建打红，守卫会立刻被绕过。真正的病灶是**没埋点的那些**——同步命令卡死时不进
// trace 环，冻结报告的 stuckCommand 恒为 None，肇事者定不到（2026-07 一整轮误判
// 就死在这个盲区上）。这一档是可判定、可维护、且当前全绿的。
//
// 项目无 ESLint 基础设施，以 node 脚本代偿——形态对齐 scripts/check-tauri-imports.mjs。
//
// 例外在此集中登记并写明理由，否则检查失败：
//   - onboarding.rs::claude_credentials_exist：单次 metadata() stat（探凭据文件在不在），
//     微秒级且无写入路径，达不到能冻住主线程的量级；埋点噪音大于收益。
// 新增例外必须在此登记，否则构建失败。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIR = "src-tauri/src";

/** 例外登记：键为 `相对路径::函数名`。 */
const EXCEPTIONS = new Map([
  [
    "src-tauri/src/commands/onboarding.rs::claude_credentials_exist",
    "单次 metadata() stat，微秒级无写入",
  ],
]);

// 只认真正会阻塞主线程的调用：文件/目录读写、子进程。
// 刻意不收 `Path::new`/`PathBuf::from`（纯构造，无 IO）。
const IO_RE = new RegExp(
  [
    String.raw`\bfs::`,
    String.raw`std::fs`,
    String.raw`\bCommand::new\b`,
    String.raw`\bread_to_string\b`,
    String.raw`\bread_dir\b`,
    String.raw`\bremove_file\b`,
    String.raw`\bremove_dir\b`,
    String.raw`\bcreate_dir|create_dir_all\b`,
    String.raw`\bOpenOptions\b`,
    String.raw`\bFile::`,
    String.raw`\.metadata\(\)`,
    // 工作区操作的实现住在 aide-workspace（与远程 aide-host 共用）：Tauri 命令只剩
    // 一行转调，IO 藏在 crate 里——按调用入口认，否则薄包装会漏出守卫。
    String.raw`\bfs_ops::`,
    String.raw`\baide_workspace::`,
    String.raw`\bgit::[a-z_]+::git_`,
  ].join("|"),
);

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // 目录不存在则跳过
  }
  for (const name of entries) {
    if (name === "target" || name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith(".rs")) yield full;
  }
}

/**
 * 从 `{` 起做括号配对，返回函数体文本。
 *
 * Rust 里 `{`/`}` 会出现在字符串、字符字面量、注释中，裸计数会跑偏，故逐字符扫描并
 * 跳过：行注释、块注释（可嵌套）、普通字符串、raw 字符串、字符字面量（区分生命周期
 * 标记 `'a`——它不闭合）。
 */
function extractBody(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let nest = 1;
      i += 2;
      while (i < n && nest > 0) {
        if (src[i] === "/" && src[i + 1] === "*") (nest += 1), (i += 2);
        else if (src[i] === "*" && src[i + 1] === "/") (nest -= 1), (i += 2);
        else i += 1;
      }
      continue;
    }
    // raw 字符串：r"..." / r#"..."# / br#"..."#
    const raw = /^(?:b?r)(#*)"/.exec(src.slice(i, i + 8));
    if (raw) {
      const closer = '"' + raw[1];
      const start = i + raw[0].length;
      const end = src.indexOf(closer, start);
      i = end < 0 ? n : end + closer.length;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < n && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === "'") {
      // 字符字面量 `'x'` / `'\n'` 闭合；生命周期 `'a` 不闭合——靠「下一字符是否为 '」区分。
      const lit = /^'(?:\\.|[^\\'])'/.exec(src.slice(i, i + 6));
      i += lit ? lit[0].length : 1;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
    i += 1;
  }
  return src.slice(openIdx);
}

/** 抽出文件里所有 tauri 命令：名字、行号、是否 async、函数体。 */
function extractCommands(src) {
  const out = [];
  const attrRe = /^[ \t]*#\[tauri::command[^\]]*\][ \t]*$/gm;
  let m;
  while ((m = attrRe.exec(src)) !== null) {
    // 往下找签名行：中间允许夹着其它属性行与文档注释
    const rest = src.slice(m.index + m[0].length);
    const sig = /^[ \t]*(?:#\[[^\n]*\][ \t]*\n[ \t]*)*(?:\/\/\/[^\n]*\n[ \t]*)*pub(?:\([^)]*\))?\s+(async\s+)?fn\s+(\w+)/m.exec(
      rest,
    );
    if (!sig) continue; // 属性没跟函数（宏展开等）——不猜
    const name = sig[2];
    const isAsync = Boolean(sig[1]);
    const sigEnd = m.index + m[0].length + sig.index + sig[0].length;
    // 签名后到函数体 `{`：先跳过泛型/参数/返回值里的括号
    const braceIdx = src.indexOf("{", sigEnd);
    if (braceIdx < 0) continue;
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ name, line, isAsync, body: extractBody(src, braceIdx) });
  }
  return out;
}

const violations = [];
let traced = 0;
for (const file of walk(join(ROOT, SCAN_DIR))) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  const src = readFileSync(file, "utf8");
  for (const cmd of extractCommands(src)) {
    if (cmd.isAsync) continue;
    if (!IO_RE.test(cmd.body)) continue;
    if (EXCEPTIONS.has(`${rel}::${cmd.name}`)) continue;
    if (cmd.body.includes("trace_command")) {
      traced += 1; // 中间桶：保留同步但已登记，冻结时能点名
      continue;
    }
    violations.push({ rel, ...cmd });
  }
}

if (violations.length) {
  console.error("✗ 做 IO/子进程的**同步** Tauri 命令没有埋 trace_command：\n");
  for (const v of violations) {
    console.error(`  ${v.rel}:${v.line}  fn ${v.name}()`);
  }
  console.error("\n这类命令卡死时冻结报告的 stuckCommand 恒为 None（定不到肇事者）。");
  console.error("处理方式（二选一）：");
  console.error("  a) 改 async fn + tokio::task::spawn_blocking，实现下沉到");
  console.error("     fn <name>_blocking（见 commands/recent.rs 的写法）——首选；");
  console.error("  b) 保留同步，在函数第一行埋 let _trace =");
  console.error("     crate::diagnostics::trace_command(\"<name>\");");
  console.error("  确属微秒级无写入的轻量调用，则在 scripts/check-sync-io-commands.mjs");
  console.error("  的 EXCEPTIONS 登记并写明理由。");
  process.exit(1);
}
console.log(
  `✓ 同步命令 IO 检查通过：${SCAN_DIR} 无未登记的同步 IO 命令（已登记 ${traced} 条）`,
);
