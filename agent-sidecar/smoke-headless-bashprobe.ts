// 定向探针（不进验收台账）：C7 残层——Bash 调用的真实结局全轨迹。
// 与 smoke-headless-realmodel C7 同款自检脚本法（裸 env 被 auto 分类器拦，
// 2026-09-11 实锤）。全事件落盘：每条 SSE 事件带相对时间戳 + tool_use 输入 +
// 终态帧；收尾盘点 bash.exe/claude.exe 进程（悬挂检测）。
// 手动：npx tsx smoke-headless-bashprobe.ts
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  spawnRuntime, invokeOnce, sseOpen, eventsOf, waitFor, makeConfigRoot,
  claudePids, killPid, sleep, type RuntimeHandle,
} from "./smoke-headless-lib.js";
import { resolveProviderEnv } from "./smoke-headless-provider-env.js";

const PORT = 18199;
const TOKEN = "BP-TOKEN-9x2";
const pe = resolveProviderEnv();
const cfg = makeConfigRoot({});
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// 与 realmodel C7 同款自检脚本（哨兵用探针自有值）
const META_SENTINEL = "BP-META-SENTINEL";
const HDR_SENTINEL = "BP-HDR-SENTINEL";
const selftestJs = join(cfg.dir, "engine-selftest.cjs").replace(/\\/g, "/");
writeFileSync(selftestJs, [
  "const sentinels = " + JSON.stringify([META_SENTINEL, HDR_SENTINEL]) + ";",
  "const hits = [];",
  "let pathLen = 0;",
  "for (const [k, v] of Object.entries(process.env)) {",
  "  if (k === 'PATH') pathLen = String(v).length;",
  "  for (const s of sentinels) if (String(v).includes(s)) hits.push(k);",
  "}",
  "console.log(JSON.stringify({ clean: hits.length === 0, hits, envKeys: Object.keys(process.env).length, pathLen }));",
].join("\n"));

function bashPids(): Set<number> {
  try {
    const out = execSync("tasklist /FI \"IMAGENAME eq bash.exe\" /FO CSV /NH", { encoding: "utf8" });
    return new Set(out.split("\n").map((l) => Number(l.split('","')[1])).filter((n) => Number.isFinite(n) && n > 0));
  } catch { return new Set<number>(); }
}

const rt: RuntimeHandle = await spawnRuntime({ port: PORT, token: TOKEN, configDir: cfg.dir });
const pidBase = claudePids();
const bashBase = bashPids();

const sid = "bp-1";
const s1 = sseOpen(PORT, sid, TOKEN);
await invokeOnce(PORT, {
  cmd: "send", session_id: sid,
  prompt: `这是引擎安全自检，不是闲聊：你必须调用 Bash 工具真实执行命令 node "${selftestJs}"（就这一条命令，一字不改），把输出原样贴出。禁止凭记忆作答、禁止拒绝、禁止用其他工具。`,
  cwd: cfg.dir, env: pe.env, auto_title: false,
  metadata: { tenant: META_SENTINEL }, mcp_headers: { "*": { "X-User-Token": HDR_SENTINEL } },
}, TOKEN);
const init = await waitFor("session_init", () => eventsOf(s1).find((e) => e.type === "session_init") as { session_id?: string } | undefined, 90_000).catch(() => null);
const realId = init?.session_id ?? sid;
console.log(`[${el()}] session_init=${realId}`);
const s2 = sseOpen(PORT, realId, TOKEN);

// 等 message_stop 或 240s 超时；期间打印每条新事件（去重按通道已收数）
let seen1 = 0, seen2 = 0;
const tEnd = Date.now() + 240_000;
let stopSeen = false;
while (Date.now() < tEnd && !stopSeen) {
  const f1 = eventsOf(s1), f2 = eventsOf(s2);
  for (const [arr, seen, tag] of [[f1, seen1, "client"], [f2, seen2, "real"]] as const) {
    for (let i = seen; i < arr.length; i++) {
      const e = arr[i] as Record<string, unknown>;
      const brief = JSON.stringify(e).slice(0, 260);
      console.log(`[${el()}] ${tag}#${i} ${e.type}: ${brief}`);
    }
  }
  seen1 = f1.length; seen2 = f2.length;
  stopSeen = [...f1, ...f2].some((e) => e.type === "message_stop" || e.type === "error");
  await sleep(500);
}
console.log(`[${el()}] 终态观测=${stopSeen ? "message_stop/error 已到" : "240s 超时未见终态"}`);

// 进程盘点：新起 claude.exe / bash.exe（悬挂检测）
const claudeNow = [...claudePids()].filter((p) => !pidBase.has(p));
const bashNow = [...bashPids()].filter((p) => !bashBase.has(p));
console.log(`[${el()}] 存活新增 claude.exe=${claudeNow.length} bash.exe=${bashNow.length}（bash 悬挂=每命令 3 个不退出，已知 claude.exe 侧偶发泄漏）`);

// runtime 日志尾部（hook/error 线索）
console.log(`---- runtime 日志（${rt.logs.length} 行）----`);
for (const l of rt.logs.slice(-25)) console.log(`  | ${l.slice(0, 220)}`);

s1.cancel(); s2.cancel();
rt.child.kill("SIGTERM");
await Promise.race([rt.exit, sleep(10_000)]);
await sleep(1_000);
for (const p of [...claudePids()].filter((p) => !pidBase.has(p))) killPid(p);
for (const p of bashNow) killPid(p);
cfg.cleanup();
console.log(`[${el()}] 探针收口完成`);
process.exit(0);
