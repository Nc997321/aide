// CodeGraph runner（aide-codegraph.exe）stdio JSON-RPC 端到端冒烟测试。
//
// 不经 Tauri 主进程，直接与 runner 二进制对话，验证优化项二的进程合同：
//   1. build_index（fastembed 本地 ONNX）完成并推送 progress 通知；
//   2. build 进行中并发 goto_definition 能立刻返回（并发模型不回退）；
//   3. goto 结构层精确命中（alpha_login → a.rs）；
//   4. rescan 增量更新正常；
//   5. shutdown 应答回执后进程干净退出（exit 0）；
//   6. EOF 看门狗：关闭 stdin（模拟主进程死亡）runner 自行退出。
//
// 顺带采样 runner 峰值工作集（RSS），作为进程隔离的内存证据。
//
// 前置：先 `pnpm build:codegraph`（或 cargo build -p codegraph-runner）。
// 用法：node scripts/smoke-codegraph.mjs

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// AIDE_CODEGRAPH_EXE：允许覆盖 runner 路径（llvm-cov 覆盖实测时指向插桩二进制）。
const exe = process.env.AIDE_CODEGRAPH_EXE
  ?? path.join(root, "src-tauri", "target", "debug", "aide-codegraph.exe");
if (!existsSync(exe)) {
  console.error(`[smoke] runner 不存在：${exe}\n[smoke] 先跑 pnpm build:codegraph`);
  process.exit(1);
}

// ── 临时小项目 ──────────────────────────────────────────────────────────────
const proj = mkdtempSync(path.join(tmpdir(), "cg-smoke-"));
writeFileSync(path.join(proj, "a.rs"), `
pub fn alpha_login(user: &str) -> String { format!("token-{user}") }
`);
writeFileSync(path.join(proj, "b.rs"), `
pub fn beta_hash(data: &[u8]) -> u32 { data.len() as u32 }
`);
writeFileSync(path.join(proj, "c.ts"), `
export function gamma_parse(s: string): number { return s.length; }
`);

// ── 启动 runner ─────────────────────────────────────────────────────────────
const child = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] });
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
let progressCount = 0;
let lastProgress = null;

child.stdout.on("data", () => {}); // 保持引用；readline 负责解析
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { console.log("[smoke] 非 JSON 行：", line.slice(0, 120)); return; }
  if (msg.id !== undefined && msg.ok !== undefined) {
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  } else if (msg.notification) {
    if (msg.notification === "progress") {
      progressCount += 1;
      lastProgress = msg;
      process.stdout.write(`\r  [progress] ${msg.done}/${msg.total} ${msg.current ?? ""}`.slice(0, 100).padEnd(90));
    } else {
      console.log(`\n  [${msg.notification}] ${msg.level ?? ""} ${(msg.message ?? "").slice(0, 160)}`);
    }
  }
});

function request(method, params, timeoutMs = 180000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, method, params: params ?? {} }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`超时无应答：${method}`)); }
    }, timeoutMs).unref();
  });
}

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function rssOf(pid) {
  try {
    const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
    const cols = (out.stdout ?? "").split('","').map((s) => s.replace(/"/g, "").trim());
    // CSV: 名字,PID,会话,会话号,内存
    const mem = cols[4] ?? "";
    return mem;
  } catch { return "(不可用)"; }
}

try {
  const embedder = {
    backend: "fastembed", base_url: "", api_key: "",
    model: "nomic-embed-text", format: "ollama", dim: 0,
  };

  // 1. build_index + 2. 并发 goto（在 build 应答回来之前发出）
  const t0 = Date.now();
  const buildP = request("build_index", { project_root: proj, force: false, embedder, proxy: null });
  // 稍等一拍让 build 真正开始，再并发查询
  await new Promise((r) => setTimeout(r, 300));
  const gotoDuringBuild = await request(
    "goto_definition",
    { word: "alpha_login", file: "", line: 2, column: 5, project_root: proj, score_threshold: 0.35 },
    30000,
  );
  const gotoLatency = Date.now() - t0;
  check("build 期间 goto 立即应答（并发模型）", gotoDuringBuild.ok, `${gotoLatency}ms`);
  const arr = gotoDuringBuild.ok ? gotoDuringBuild.result : [];
  check("并发 goto 允许为空（embed 未完成跳过语义层）", Array.isArray(arr), `结果数=${Array.isArray(arr) ? arr.length : "-"}`);

  const build = await buildP;
  check("build_index ok", build.ok, `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!build.ok) {
    console.log("  build error:", build.error);
  } else {
    const r = build.result ?? {};
    check("build 结果形状", r.total_symbols !== undefined && r.scanned_files !== undefined,
      `symbols=${r.total_symbols} files=${r.scanned_files}`);
  }
  check("收到 progress 通知", progressCount > 0, `共 ${progressCount} 帧`);
  if (lastProgress) {
    check("progress 负载五键齐全", ["active", "done", "total", "current", "index_ready"].every((k) => k in lastProgress));
  }

  // 3. build 完成后的 goto：结构层精确命中
  const goto2 = await request(
    "goto_definition",
    { word: "alpha_login", file: "", line: 2, column: 5, project_root: proj, score_threshold: 0.35 },
  );
  check("goto 结构层命中", goto2.ok && Array.isArray(goto2.result) && goto2.result.some(
    (q) => ((q.symbol ?? q)?.file ?? "").endsWith("a.rs")), JSON.stringify(goto2.result ?? goto2.error).slice(0, 120));

  // 未知方法 → err 响应（不 panic）
  const bogus = await request("no_such_method", {});
  check("未知方法回 err 不崩", bogus.ok === false && typeof bogus.error === "string", bogus.error ?? "");

  // 4. rescan
  writeFileSync(path.join(proj, "d.rs"), "pub fn delta_extra() {}\n");
  const rescan = await request("rescan", { project_root: proj });
  check("rescan ok", rescan.ok, JSON.stringify(rescan.result ?? rescan.error).slice(0, 100));

  const rss = rssOf(child.pid);
  console.log(`\n[smoke] runner RSS（构建后）：${rss}`);

  // 5. shutdown：应答回执 + 干净退出
  const shutdown = await request("shutdown", null, 15000);
  check("shutdown 应答", shutdown.ok);
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 10000);
    child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
  });
  check("shutdown 后退出且 exit 0", exitCode === 0, `exit=${exitCode}`);

  // 6. EOF 看门狗（第二次拉起，模拟主进程死亡）
  const child2 = spawn(exe, [], { stdio: ["pipe", "pipe", "ignore"] });
  await new Promise((r) => setTimeout(r, 800));
  const watchdog = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 10000);
    child2.on("exit", (c) => { clearTimeout(timer); resolve(c); });
    child2.stdin.end(); // 主进程死亡 → stdin EOF
  });
  check("stdin EOF 看门狗退出", watchdog === 0, `exit=${watchdog}`);

  rmSync(proj, { recursive: true, force: true });

  const failed = results.filter((r) => !r.pass);
  console.log(`\n[smoke] ${results.length - failed.length}/${results.length} 项通过${failed.length ? "，失败项见上" : ""}`);
  process.exit(failed.length ? 1 : 0);
} catch (e) {
  console.error("\n[smoke] 异常：", e.message);
  child.kill();
  rmSync(proj, { recursive: true, force: true });
  process.exit(1);
}
