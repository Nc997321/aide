// 挖全部 freeze 报告的心跳面包屑：冻结前后用户动作时间线
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = "C:/Users/yangx/.aide/diagnostics";
const files = readdirSync(dir)
  .filter((f) => /^freeze-\d+\.json$/.test(f))
  .sort();
const iso = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

const events = []; // {t, kind, detail, src}
for (const f of files) {
  let r;
  try { r = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
  const started = r.freeze?.started;
  for (const hb of r.ring?.heartbeats ?? []) {
    for (const c of hb.crumbs ?? []) {
      // 同一动作可能被相邻报告重复携带（快照窗口重叠），按 t+detail 去重
      events.push({ t: c.t, kind: c.kind, detail: c.detail, src: started });
    }
  }
}
events.sort((a, b) => a.t - b.t);
const seen = new Set();
console.log("时间(本地)          动作   目标");
for (const e of events) {
  const key = `${e.t}|${e.detail}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`${iso(e.t)}  ${e.kind.padEnd(6)} ${String(e.detail).slice(0, 80)}`);
}