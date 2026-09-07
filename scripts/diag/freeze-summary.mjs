// v2：按 pid 聚合（修掉多 webview2 实例混名的伪影），并抽取面包屑看触发动作
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = "C:/Users/yangx/.aide/diagnostics";
const files = readdirSync(dir)
  .filter((f) => /^freeze-\d+\.json$/.test(f))
  .sort();
const iso = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const mb = (b) => (b / 1048576).toFixed(0);

console.log("=== 按 pid 聚合（只列峰值>300MB 的 webview2） ===");
console.log("started(本地)      durMs | 大渲染进程 first→peak→last(MB) pid | 样本数");
for (const f of files) {
  let r;
  try { r = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
  const { started, durationMs } = r.freeze ?? {};
  const byPid = new Map(); // pid -> {name, first, peak, last, n}
  for (const s of r.samples ?? []) {
    for (const p of s.processes ?? []) {
      const e = byPid.get(p.pid) ?? { name: p.name, first: null, peak: 0, last: 0, n: 0 };
      if (e.first === null) e.first = p.mem;
      e.last = p.mem;
      e.peak = Math.max(e.peak, p.mem);
      e.n++;
      byPid.set(p.pid, e);
    }
  }
  const big = [...byPid.entries()]
    .filter(([, e]) => e.name === "msedgewebview2.exe" && e.peak > 300 * 1048576)
    .sort((a, b) => b[1].peak - a[1].peak);
  const lines = big.map(
    ([pid, e]) => `${mb(e.first)}→${mb(e.peak)}→${mb(e.last)}(pid${pid})`
  );
  console.log(
    `${iso(started)}  ${String(durationMs).padStart(6)} | ${lines.join("  ") || "-"} | n=${(r.samples ?? []).length}`
  );
}

// 面包屑：挑最大的两份报告，看冻结前后用户在做什么
const richest = files
  .map((f) => {
    try { return { f, r: JSON.parse(readFileSync(join(dir, f), "utf8")) }; } catch { return null; }
  })
  .filter(Boolean)
  .map((x) => ({ ...x, crumbs: x.r?.ring?.heartbeats?.length ? x.r : null }))
  .filter((x) => x.r?.frontend?.crumbs || x.r?.ring);
console.log("\n=== 某份报告的顶层键（确认面包屑在哪） ===");
const probe = JSON.parse(readFileSync(join(dir, files[files.length - 1]), "utf8"));
console.log("top:", Object.keys(probe));
console.log("ring:", Object.keys(probe.ring ?? {}));
console.log("ring.heartbeats[0]:", JSON.stringify((probe.ring?.heartbeats ?? [])[0]));
console.log("ring.heartbeats 最后1条 crumbs 示例:", JSON.stringify((probe.ring?.heartbeats ?? []).slice(-1)));