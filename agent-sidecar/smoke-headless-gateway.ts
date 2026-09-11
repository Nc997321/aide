// D 组网关形态彩排 + C 组机制①端到端 + B 组死端点项（清单 §3/§4/§5）：
// 模拟 agri 网关——Bearer 鉴权、临时配置根挂两个 mock MCP http server、多租户 sid、
// mcp_headers 注入、SSE 转发。跑 dist 产物，全程死端点（不需要真 provider）。
// 手动运行：npm run build && npx tsx smoke-headless-gateway.ts
// 真模型项（B2/B4/D1/D2 问答与写确认）不在本脚本面——见清单真模型批次。
import {
  spawnRuntime, invokeOnce, sseOpen, eventsOf, waitFor, check, report,
  claudePids, diffPids, rssKBOf, killPid, makeConfigRoot, makeMockMcp, deadEndpointEnv, sleep, scanLeaks,
  type SseStream,
} from "./smoke-headless-lib.js";

const PORT = 18192;
const PORT2 = 18193; // D5 重启后的新宿主
const TOKEN = "GW-TOKEN-9k2"; // 网关共享密钥（假值，兼 C8 扫描靶）
const DEAD_KEY = "gw-fake-dead-key";
const deadEnv = deadEndpointEnv(DEAD_KEY);
const t0 = Date.now();

const biz1 = await makeMockMcp("X-User-Token");
const biz2 = await makeMockMcp("X-User-Token");
const cfg = makeConfigRoot({
  biz1: { type: "http", url: `http://127.0.0.1:${biz1.port}/mcp` },
  biz2: { type: "http", url: `http://127.0.0.1:${biz2.port}/mcp` },
});
const rt = await spawnRuntime({ port: PORT, token: TOKEN, configDir: cfg.dir });
const baseSend = (sid: string, prompt: string, extra: Record<string, unknown> = {}) => ({
  cmd: "send", session_id: sid, prompt, cwd: cfg.dir, env: deadEnv, ...extra,
});

// ---- A5 Bearer 鉴权三态（invoke 与 events 两路都验） ----
const a5none = await invokeOnce(PORT, { cmd: "interrupt", session_id: "x" });
const a5bad = await invokeOnce(PORT, { cmd: "interrupt", session_id: "x" }, "wrong-token");
const a5good = await invokeOnce(PORT, { cmd: "interrupt", session_id: "x" }, TOKEN);
const ev401 = await fetch(`http://127.0.0.1:${PORT}/events?sessionId=x`);
const evOk = await fetch(`http://127.0.0.1:${PORT}/events?sessionId=x`, { headers: { authorization: `Bearer ${TOKEN}` } });
if (evOk.body) evOk.body.cancel();
check("A5 鉴权三态", a5none.status === 401 && a5bad.status === 401 && a5good.status === 200 && ev401.status === 401 && evOk.status === 200,
  `invoke ${a5none.status}/${a5bad.status}/${a5good.status}，events ${ev401.status}/${evOk.status}`);

// ---- 阶段1 并发起会话：C2 通配 / C9 双租户隔离 / B1 生命周期 ----
const sC9a = sseOpen(PORT, "g-s1", TOKEN);
const sC9b = sseOpen(PORT, "g-s2", TOKEN);
const sB1 = sseOpen(PORT, "g-b1", TOKEN);
await invokeOnce(PORT, baseSend("g-star", "C2 marker", { mcp_headers: { "*": { "X-User-Token": "GW-STAR" } } }), TOKEN);
await invokeOnce(PORT, baseSend("g-s1", "C9-S1 marker", { mcp_headers: { biz1: { "X-User-Token": "TOK_S1" } } }), TOKEN);
await invokeOnce(PORT, baseSend("g-s2", "C9-S2 marker", { mcp_headers: { biz1: { "X-User-Token": "TOK_S2" } } }), TOKEN);
const iB1 = await invokeOnce(PORT, baseSend("g-b1", "B1-turn1"), TOKEN);
const init = (s: SseStream) => waitFor("session_init", () => eventsOf(s).find((e) => e.type === "session_init") as { session_id?: string } | undefined, 60_000);
const [realC9a, realB1] = [
  (await init(sC9a).catch(() => null))?.session_id,
  (await init(sB1).catch(() => null))?.session_id,
];
sC9b.cancel();

// C2：`"*"` 头到达**所有** http server（biz1+biz2 都要有 GW-STAR）
await waitFor("C2 hits", () => biz1.hits.some((h) => h.value === "GW-STAR") && biz2.hits.some((h) => h.value === "GW-STAR"), 60_000).catch(() => null);
check("C2 通配注入达所有 http server", biz1.hits.some((h) => h.value === "GW-STAR") && biz2.hits.some((h) => h.value === "GW-STAR"),
  `biz1=${JSON.stringify(biz1.hits.map((h) => h.value))} biz2=${JSON.stringify(biz2.hits.map((h) => h.value))}（stdio 面不适用 HTTP 头，单测已证不受影响）`);

// ---- B1 re-key 语义钉死 ----
check("B1 会话启动事件面", iB1.status === 200 && !!realB1 && realB1 !== "g-b1", `client sid=g-b1 → SDK 真 id=${realB1 ?? "未出现"}`);
// 断言1：死端点 error 帧 fatal:false、进程存活。双通道观察（error 可能落在 re-key 前的
// client sid 通道或之后的真 id 通道），窗口拉 90s——CLI 对死端点有内部重试，40s 未必够。
const sB1r = realB1 ? sseOpen(PORT, realB1, TOKEN) : null;
const tInit = Date.now();
const errHit = sB1r ? await waitFor("B1 error 帧", () => {
  const r = eventsOf(sB1r).find((e) => e.type === "error");
  if (r) return { ch: "真 id 通道", e: r } as const;
  const c = eventsOf(sB1).find((e) => e.type === "error");
  if (c) return { ch: "client sid 通道(re-key 前)", e: c } as const;
  return null;
}, 90_000, 500).catch(() => null) : null;
// 窗口内到达与否只作注记——终判在收口处用长观察（实测 error 帧 ≤337s 才到，90s 窗口必空）。
if (errHit) console.log(`[note] B1 error 帧窗口内到达（${Math.round((Date.now() - tInit) / 1000)}s，${errHit.ch}）`);
else console.log("[note] B1 error 帧 90s 窗口未达（死端点轮挂 CLI 内部重试，收口长观察终判）");
// 断言2：后续命令必须用真 id —— send(realB1) 复用同一 worker（真 id 通道见 user_message、无新 session_init）
if (realB1) {
  await invokeOnce(PORT, baseSend(realB1, "B1-turn2-via-real"), TOKEN);
  await sleep(2_500);
  const rCh = eventsOf(sB1r!);
  check("B1 用真 id 续发=同 worker", rCh.some((e) => e.type === "user_message" && String(e.text).includes("B1-turn2")) && !rCh.some((e) => e.type === "session_init"), `真 id 通道 ${rCh.length} 帧`);
  // 断言3：拿旧 client sid 续发=全新会话（对接文档必须写明）
  const oldCh = sseOpen(PORT, "g-b1", TOKEN);
  await invokeOnce(PORT, baseSend("g-b1", "B1-via-stale-sid"), TOKEN);
  const reInit = await init(oldCh).catch(() => null);
  check("B1 旧 sid 续发=新会话（re-key 陷阱实锤）", !!reInit && reInit.session_id !== realB1, `stale sid 再收 session_init=${reInit?.session_id ?? "无"}`);
  oldCh.cancel();
}
sB1.cancel();

// ---- C9 会话间头隔离：两次连接的命中按源端口分组互不混 ----
const s1Ports = new Set(biz1.hits.filter((h) => h.value === "TOK_S1").map((h) => h.remotePort));
const s2Ports = new Set(biz1.hits.filter((h) => h.value === "TOK_S2").map((h) => h.remotePort));
const crossed = biz1.hits.some((h) => (s1Ports.has(h.remotePort) && h.value !== "TOK_S1") || (s2Ports.has(h.remotePort) && h.value !== "TOK_S2"));
check("C9 会话间头隔离", s1Ports.size > 0 && s2Ports.size > 0 && s1Ports.size + s2Ports.size > 0 && !crossed && ![...s1Ports].some((p) => s2Ports.has(p)),
  `S1 连接×${s1Ports.size} 全带 TOK_S1；S2 连接×${s2Ports.size} 全带 TOK_S2；交叉=${crossed ? "有!" : "无"}`);


// ---- B3 display 回灌在网关形态同样成立（带未知块的真 send 流） ----
const sB3 = realB1 ? sseOpen(PORT, realB1, TOKEN) : sseOpen(PORT, "g-b3", TOKEN);
await invokeOnce(PORT, baseSend(realB1 ?? "g-b3", "B3 see @a.ts", {
  display: [{ type: "mention", path: "a.ts:1-9" }, { type: "brand_new_kind", z: 1 }],
}), TOKEN);
const umB3 = await waitFor("B3 user_message", () => eventsOf(sB3).find((e) => e.type === "user_message" && String(e.text).includes("B3")), 20_000).catch(() => null);
const dispB3 = JSON.stringify(umB3?.display ?? []);
check("B3 display 原样回灌（含未知块）", dispB3.includes("brand_new_kind") && dispB3.includes("a.ts:1-9"), dispB3.slice(0, 120));
sB3.cancel();

// ---- B6 session_stop：worker 停止 + claude.exe 释放 ----
const b6before = claudePids();
const sB6 = sseOpen(PORT, "g-b6", TOKEN);
await invokeOnce(PORT, baseSend("g-b6", "B6 hi"), TOKEN);
const realB6 = (await init(sB6).catch(() => null))?.session_id;
const b6Live = diffPids(b6before, claudePids());
await invokeOnce(PORT, { cmd: "session_stop", session_id: realB6 ?? "g-b6" }, TOKEN);
const gone = await waitFor("B6 子进程释放", () => (b6Live.filter((p) => !claudePids().has(p)).length === b6Live.length ? true : undefined), 20_000).catch(() => undefined);
check("B6 session_stop 释放 claude.exe", !!gone && b6Live.length >= 1, `拉起 ${b6Live.length} 个 → 全部退场=${!!gone}`);
// 再 send 同 sid = 新会话（resume 语义另测，真模型批次）
const sB6b = sseOpen(PORT, "g-b6", TOKEN);
await invokeOnce(PORT, baseSend("g-b6", "B6 again"), TOKEN);
const reB6 = await init(sB6b).catch(() => null);
check("B6 停止后再 send=新会话", !!reB6 && reB6.session_id !== realB6, `新 id=${reB6?.session_id ?? "无"}（旧=${realB6}）`);
sB6.cancel(); sB6b.cancel();

// ---- B13 同 sid 连发：排队不乱序；D4 网关重启韧性借用本会话 ----
const sB13 = sseOpen(PORT, "g-b13", TOKEN);
await invokeOnce(PORT, baseSend("g-b13", "B13-boot"), TOKEN);
const realB13 = (await init(sB13).catch(() => null))?.session_id ?? "g-b13";
const sB13r = sseOpen(PORT, realB13, TOKEN);
for (const n of ["Q1", "Q2", "Q3"]) {
  await invokeOnce(PORT, baseSend(realB13, `B13-${n}`), TOKEN);
  await sleep(150);
}
await sleep(6_000);
const seqs = eventsOf(sB13r).filter((e) => e.type === "user_message").map((e) => String(e.text));
const got = ["Q1", "Q2", "Q3"].filter((n) => seqs.some((t) => t.includes(`B13-${n}`)));
check("B13 同 sid 三连发排队不丢不乱", got.length === 3 && seqs.findIndex((t) => t.includes("Q1")) < seqs.findIndex((t) => t.includes("Q3")), seqs.join("|"));
// D4：所有订阅掐断（网关死）→ 重订阅继续收（无回放语义下新事件照到）
sB13.cancel(); sB13r.cancel();
await sleep(500);
const rtAlive = rssKBOf(rt.child.pid!) !== undefined;
const sB13c = sseOpen(PORT, realB13, TOKEN);
await invokeOnce(PORT, baseSend(realB13, "D4-after-gw-restart"), TOKEN);
const d4 = await waitFor("D4 续收", () => eventsOf(sB13c).find((e) => e.type === "user_message" && String(e.text).includes("D4-after")), 20_000).catch(() => null);
check("D4 网关重启韧性（runtime 无感）", rtAlive && !!d4 && (await invokeOnce(PORT, { cmd: "interrupt", session_id: "z" }, TOKEN)).status === 200, "掐订阅→重订阅续收新事件，宿主存活");
sB13c.cancel();

// ---- B12 并发 3 会话：事件各归各 + 进程线性 + 停止回收 ----
const b12before = claudePids();
const b12 = ["X", "Y", "Z"].map((k) => ({ sid: `g-b12-${k}`, s: sseOpen(PORT, `g-b12-${k}`, TOKEN) }));
for (const c of b12) await invokeOnce(PORT, baseSend(c.sid, `B12-${c.sid} marker`), TOKEN);
const b12Inits = await Promise.all(b12.map((c) => init(c.s).catch(() => null)));
await sleep(2_000);
const b12Live = diffPids(b12before, claudePids());
const b12Cross = b12.filter((c) => eventsOf(c.s).some((e) => String(e.text ?? "").includes("B12-") && !String(e.text).includes(c.sid))).length;
check("B12 并发 3 会话各自成流不串", b12Inits.every(Boolean) && b12Cross === 0 && b12Live.length >= 3, `init ${b12Inits.filter(Boolean).length}/3，claude.exe 净增 ${b12Live.length}，串扰 ${b12Cross}`);
for (const p of b12Live) killPid(p); // 定点回收（D6 会更严谨地测停止面，这里保环境）
// 只断言「这 3 个 PID 没了」——全量 diff 会把其他阶段迟到的 CLI 卷进来（第一轮实测教训）
const b12Left = b12Live.filter((p) => claudePids().has(p));
check("B12 回收", b12Live.length >= 3 && b12Left.length === 0, `净增 ${b12Live.length}，kill 后残留 ${b12Left.length}`);

// ---- D6 10 会话容量摸底（重启前在当前宿主做，停止/峰值都在当前 configDir） ----
const d6before = claudePids();
const rssD6a = rssKBOf(rt.child.pid!);
const d6 = Array.from({ length: 10 }, (_, i) => ({ sid: `g-d6-${i}`, s: sseOpen(PORT, `g-d6-${i}`, TOKEN) }));
for (const c of d6) {
  await invokeOnce(PORT, baseSend(c.sid, `D6-${c.sid} marker`), TOKEN);
  await sleep(400);
}
const d6Inits = await Promise.all(d6.map((c) => init(c.s).catch(() => null)));
const d6Real = d6Inits.map((i) => i?.session_id);
const okInits = d6Real.filter(Boolean).length;
const rssD6b = rssKBOf(rt.child.pid!);
const d6Live = diffPids(d6before, claudePids());
// 帧不串：每通道只认自家 marker
const crossed6 = d6.filter((c) => eventsOf(c.s).some((e) => String(e.text ?? "").includes("g-d6") && !String(e.text).includes(c.sid))).length;
for (const rid of d6Real) if (rid) await invokeOnce(PORT, { cmd: "session_stop", session_id: rid }, TOKEN);
await sleep(8_000);
const d6Left = d6Live.filter((p) => claudePids().has(p));
for (const p of d6Left) killPid(p);
for (const c of d6) c.s.cancel();
check("D6 10 并行会话全成流", okInits === 10, `session_init ${okInits}/10，claude.exe 净增 ${d6Live.length}，runtime RSS ${rssD6a}→${rssD6b}KB（Δ${(rssD6b ?? 0) - (rssD6a ?? 0)}KB 亚线性/缓冲级）`);
check("D6 帧不串 + 停止回收", crossed6 === 0 && d6Left.length === 0, `串扰=${crossed6}，停后残留 ${d6Left.length}`);

// ---- B1 终判 + C4 token 轮换（必须在 D5 杀宿主之前：都要原宿主活着） ----
// error 帧到达时刻实测很长（CLI 重试梯度）：再给 180s 有界长等，超时按实况判词。
await waitFor("B1 error 到达（长等）", () => (sB1r ? eventsOf(sB1r).find((e) => e.type === "error") : undefined), 180_000, 2_000).catch(() => null);
const lateErr = sB1r ? eventsOf(sB1r).find((e) => e.type === "error") : null;
check("B1 死端点 error 帧 fatal:false（延迟到达=实测行为）", !!lateErr && lateErr.fatal === false,
  lateErr ? `≤${Math.round((Date.now() - tInit) / 1000)}s 到达（90s 窗口空=CLI 重试梯度，对接侧须有超时/interrupt 策略）：${JSON.stringify(lateErr).slice(0, 120)}`
    : "270s 长观察仍未到达 error 帧");
sB1r?.cancel();
// C4：头轮换钉在「下一次 query 启动」——上一 query 终态（error→loop break）后 send 才触发重启重连
if (realC9a) {
  const tBefore = Date.now();
  await invokeOnce(PORT, baseSend(realC9a, "C4-rotate", { mcp_headers: { biz1: { "X-User-Token": "TOK_ROT" } } }), TOKEN);
  const rot = await waitFor("C4 新头命中", () => biz1.hits.find((h) => h.value === "TOK_ROT" && h.t >= tBefore), 90_000).catch(() => null);
  check("C4 轮换后下一 query 连接带新头", !!rot, rot
    ? "端到端钉「下一 query=新头」；「存活 query 仍用旧头」边界以单测为准（本轮绿）"
    : "90s 无 TOK_ROT 命中——上一 query 未终态则不重连（与 B1 长轮时序同源）");
}

// ---- D5 runtime 崩溃恢复：强杀 → SSE 断开可感 → 重启新会话可用/旧会话不恢复 ----
const sD5watch = sseOpen(PORT, "g-d5-watch", TOKEN);
const oldRealB13 = realB13;
const liveBeforeCrash = claudePids();
rt.child.kill(); // 无信号名 = 默认强杀语义（崩溃场景模拟）
const goneD5 = await waitFor("D5 订阅断开", () => (sD5watch.closed ? true : undefined), 15_000).catch(() => undefined);
const crashOrphans = diffPids(liveBeforeCrash, claudePids());
console.log(`[note] D5 观测：崩溃时存活 worker 的 claude.exe 残留 ${crashOrphans.length} 个（网关侧清理义务，已定点回收）`);
for (const p of crashOrphans) killPid(p);
const rt2 = await spawnRuntime({ port: PORT2, token: TOKEN, configDir: cfg.dir });
const sD5new = sseOpen(PORT2, "g-d5-fresh", TOKEN);
await invokeOnce(PORT2, baseSend("g-d5-fresh", "D5 fresh session"), TOKEN);
const d5New = await init(sD5new).catch(() => null);
const sD5old = sseOpen(PORT2, oldRealB13, TOKEN);
await invokeOnce(PORT2, baseSend(oldRealB13, "D5-old-sid-revive?"), TOKEN);
const d5Old = await init(sD5old).catch(() => null);
check("D5 崩溃→重启：新会话可用", !!goneD5 && !!d5New, `断开=${sD5watch.closeReason ?? sD5watch.error ?? goneD5}，新会话=${d5New?.session_id ?? "失败"}`);
check("D5 旧会话不恢复（内存态约束实锤）", !!d5Old && d5Old.session_id !== d5New?.session_id, `旧键重发得到的是全新 SDK 会话 ${d5Old?.session_id}（上下文丢失——对接文档必须写明）`);
sD5watch.cancel(); sD5new.cancel(); sD5old.cancel();

// ---- 收束：C8 日志零泄漏 + 宿主关停 + 孤儿台账 ----
const leaks = scanLeaks([...rt.logs, ...rt2.logs], [TOKEN, DEAD_KEY, "TOK_S1", "TOK_S2", "TOK_ROT", "GW-STAR"]);
check("C8 runtime 日志零凭据", leaks.length === 0, leaks.length ? `泄漏哨兵: ${leaks.join(",")}` : `扫描 ${rt.logs.length + rt2.logs.length} 行 × 6 哨兵，零命中`);
// 收口：先停 rt2 上两个 D5 会话（避免制造孤儿），再关宿主
for (const rid of [d5New?.session_id, d5Old?.session_id]) {
  if (rid) await invokeOnce(PORT2, { cmd: "session_stop", session_id: rid }, TOKEN).catch(() => {});
}
await sleep(1_500);
rt2.child.kill("SIGTERM");
await Promise.race([rt2.exit, sleep(10_000)]);
await biz1.close(); await biz2.close();
cfg.cleanup();
console.log(`\n[gateway-smoke] 总耗时 ${Math.round((Date.now() - t0) / 1000)}s；孤儿基线复查留给收尾人工核对（claude.exe 现存 ${claudePids().size} 个，含 aide 自身会话）`);
process.exit(report() === 0 ? 0 : 1);
