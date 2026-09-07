// 切换序列分析：主渲染进程的 WS 台阶曲线 + 每进程汇总
// 用法：node sampler-analyze.mjs [主渲染pid=71168]
import { readFileSync } from "node:fs";

const csv = "C:/document/owner/cypress-agent/scripts/diag/mem-samples.csv";
const mainPid = process.argv[2] ?? "71168";

const rows = readFileSync(csv, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .slice(1)
  .map((l) => l.split(","))
  .map(([t, name, pid, ws, priv]) => ({ t, name, pid, ws: +ws, priv: +priv }));

// ── 主渲染进程台阶曲线：WS 变化 >15MB 或每 5s 打点 ───────────────────────
const main = rows.filter((r) => r.pid === mainPid);
console.log(`=== 渲染进程 pid=${mainPid}（n=${main.length} 个采样） 台阶曲线 ===`);
console.log("时间        WS(MB)   Δ(MB)  priv(MB)");
let prev = null;
let lastPrintT = "";
for (const r of main) {
  const changed = prev === null || Math.abs(r.ws - prev) > 15;
  const tick = r.t.slice(0, 8) !== lastPrintT.slice(0, 8); // 每 5s 一条对齐线
  if (changed || tick) {
    const d = prev === null ? 0 : r.ws - prev;
    console.log(
      `${r.t}  ${r.ws.toFixed(1).padStart(8)}  ${(prev === null ? 0 : d).toFixed(1).padStart(7)}  ${r.priv.toFixed(1).padStart(8)}${changed ? (d >= 0 ? "  ↑" : "  ↓") : ""}`
    );
    prev = r.ws;
    lastPrintT = r.t;
  }
}

// ── 汇总：所有进程 首值/峰值/末值 ──────────────────────────────────────
const byPid = new Map();
for (const r of rows) {
  const k = `${r.name}-${r.pid}`;
  const e = byPid.get(k) ?? { name: r.name, first: r.ws, peak: r.ws, last: r.ws, n: 0 };
  e.peak = Math.max(e.peak, r.ws);
  e.last = r.ws;
  e.n++;
  byPid.set(k, e);
}
console.log("\n=== 全进程 首值→峰值→末值 (WS MB) ===");
for (const [, e] of [...byPid].sort((a, b) => b[1].peak - a[1].peak).slice(0, 12)) {
  console.log(
    `${(e.name + "-" + "pid" ).padEnd(24)} ${e.first.toFixed(0).padStart(5)}→${e.peak.toFixed(0).padStart(5)}→${e.last.toFixed(0).padStart(5)}  (n=${e.n})`
  );
}