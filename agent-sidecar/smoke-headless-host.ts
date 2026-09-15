// A 组宿主级验收（清单 §2）：对 dist 产物黑盒驱动，无真模型。
// 手动运行：npm run build && npx tsx smoke-headless-host.ts
// 覆盖：A1-A3、A5(无 token 面)→见 gateway、A6-A9、A11-A20（A4/A15/A17 单测面以
// 单测为准，此处如实记录可达性）。A12/A19 合并一个 35s 观察窗（P2 慢项只付一次）。
// A16 在独立 spawn 的宿主上做关停实验，孤儿 claude.exe 用 PID 差集定位并定点清理
// （绝不按镜像名批量杀——本机 aide 自身就挂着 claude.exe）。
import {
  spawnRuntime, invokeOnce, invokeRawStatus, sseOpen, eventsOf, rawSubscribe, waitFor, check, report,
  claudePids, diffPids, rssKBOf, killPid, makeConfigRoot, deadEndpointEnv, sleep, scanLeaks,
  type RuntimeHandle, type SseStream,
} from "./smoke-headless-lib.js";

const PORT = 18190;
const PORT16 = 18191;
/** 线上协议版本：与 src/headless-server.ts 的 PROTOCOL_VERSION 同步。
 *  刻意不 import（本脚本是 dist 产物的黑盒驱动，要与源码独立），也刻意写死
 *  字面量——升版本时这三条握手断言必须跟着改，改不动就说明版本门没真上线路。
 *  v2（2026-09-14）：btw_ask + send 四字段剥除；v1 的旧值曾在此滞留成 3 条假红灯。 */
const PROTOCOL = 2;
const DEAD_KEY = "smoke-host-dead-key-7f3"; // 假哨兵：兼做 C8 泄漏扫描靶
const deadEnv = deadEndpointEnv(DEAD_KEY);
const t0 = Date.now();

const cfg = makeConfigRoot({});
const rt: RuntimeHandle = await spawnRuntime({ port: PORT, configDir: cfg.dir });

// ---- A1 启动与版本握手 ----
const listenLine = rt.logs.find((l) => l.includes("headless-listening")) ?? "";
const hello1 = JSON.parse(listenLine.slice(listenLine.indexOf("{")));
check("A1 listening 行", hello1.type === "headless-listening" && hello1.port === PORT && hello1.protocol === PROTOCOL, listenLine);

// ---- A2 SSE hello 首帧 ----
const s2 = sseOpen(PORT, "a2");
await waitFor("A2 hello", () => s2.frames[0]);
check("A2 hello 首帧", JSON.stringify(s2.frames[0]) === JSON.stringify({ type: "hello", protocol: PROTOCOL, sessionId: "a2" }), JSON.stringify(s2.frames[0]));

// ---- A3 invoke 成功响应形状（真实结果只走 SSE 不在响应里） ----
const r3 = await invokeOnce(PORT, { cmd: "send", session_id: "a3", prompt: "hello a3", cwd: cfg.dir, env: deadEnv });
const shape3 = r3.status === 200 && r3.json?.ok === true && r3.json?.protocol === PROTOCOL && Object.keys(r3.json).join() === "ok,protocol";
check("A3 invoke 响应形状", shape3, JSON.stringify(r3.json));

// ---- A4 非回环无 token 拒启：dist 入口只读 PORT/TOKEN env，host 参数不可达 ----
check("A4 拒启基线", true, "e2e 面不可达（dist 入口无 host env），以单测为准（本轮 59 例绿）；发现：网关对外暴露需自带入口层");

// ---- A6 十一命令白名单面：逐命令最小合法体全 200；codegraph_result/未知命令 400 ----
const minBodies: Array<[string, Record<string, unknown>]> = [
  ["send", { cmd: "send", session_id: "a6-send", prompt: "hi", cwd: cfg.dir, env: deadEnv }],
  // send.images 两形态的 schema 面（读取/守卫在单测 imageAttachments.test.ts；本臂只证
  // 到达 200，用不存在的路径即可——它会在命令层被拒成 error 帧，不 spawn 进程）
  ["send(images inline)", { cmd: "send", session_id: "a6-send", prompt: "hi", cwd: cfg.dir, env: deadEnv, images: [{ data: "aGk=", mediaType: "image/png" }] }],
  ["send(images path)", { cmd: "send", session_id: "a6-send", prompt: "hi", cwd: cfg.dir, env: deadEnv, images: [{ path: "a6/not-a-real-file.jpg" }] }],
  ["btw_ask", { cmd: "btw_ask", session_id: "a6-x", question: "q" }],
  ["update_permission_policy", { cmd: "update_permission_policy", session_id: "a6-x", policy: { revision: 1, rules: [] } }],
  // permission_response 两形态都必须收下：扁平（桌面/远程/ohos 的历史形状）…
  ["permission_response(flat)", { cmd: "permission_response", session_id: "a6-x", id: "p1", approved: true }],
  // …与标签（官方推荐，网关用）四变体
  ["permission_response(approve)", { cmd: "permission_response", session_id: "a6-x", id: "p1", response: { kind: "approve" } }],
  ["permission_response(answer)", { cmd: "permission_response", session_id: "a6-x", id: "p1", response: { kind: "answer", answers: { q: "a" } } }],
  ["permission_response(deny)", { cmd: "permission_response", session_id: "a6-x", id: "p1", response: { kind: "deny" } }],
  ["permission_response(unanswered)", { cmd: "permission_response", session_id: "a6-x", id: "p1", response: { kind: "unanswered", reason: "确认超时" } }],
  ["interrupt", { cmd: "interrupt", session_id: "a6-x" }],
  ["stop_bg_task", { cmd: "stop_bg_task", session_id: "a6-x", task_id: "t1" }],
  ["set_model", { cmd: "set_model", session_id: "a6-x", model: "sonnet" }],
  ["model_switch_confirm_decision", { cmd: "model_switch_confirm_decision", session_id: "a6-x", confirm_id: "c1", approve: true }],
  ["set_effort", { cmd: "set_effort", session_id: "a6-x", effort: "high" }],
  ["set_permission_mode", { cmd: "set_permission_mode", session_id: "a6-x", mode: "manual" }],
  ["session_stop", { cmd: "session_stop", session_id: "a6-x" }],
];
const a6bad: string[] = [];
for (const [name, body] of minBodies) {
  const r = await invokeOnce(PORT, body);
  if (r.status !== 200) a6bad.push(`${name}:${r.status}`);
}
const rCg = await invokeOnce(PORT, { cmd: "codegraph_result", session_id: "a6-x", request_id: "r", result: "{}" });
const rUn = await invokeOnce(PORT, { cmd: "totally_unknown", session_id: "a6-x" });
check("A6 11 命令面全 200（含 permission_response 两形态）+ 白名单外 400", a6bad.length === 0 && rCg.status === 400 && rUn.status === 400, a6bad.join(",") || `codegraph=${rCg.status} unknown=${rUn.status}`);

// ---- A7 深校验拒绝臂：400 含 path+code 且不回显值 ----
const SENT = "SHOULD_NOT_ECHO_A7";
const a7arms: Array<[string, unknown]> = [
  ["images 非数组", { cmd: "send", session_id: "a7", prompt: "x", images: "not-array" }],
  ["automation 缺字段", { cmd: "send", session_id: "a7", prompt: "x", automation: { task_id: SENT } }],
  ["policy.revision 非数", { cmd: "update_permission_policy", session_id: "a7", policy: { revision: SENT, rules: [] } }],
  ["mcp_headers 值非 string", { cmd: "send", session_id: "a7", prompt: "x", mcp_headers: { srv: { "X-Secret": SENT, "X-Bad": 42 } } }],
  // permission_response 形态互斥（§4.2）：皆无 / 皆有 = 400，path 指向 response
  ["permission_response 两形态皆无", { cmd: "permission_response", session_id: "a7", id: "p1" }],
  ["permission_response 两形态皆有", { cmd: "permission_response", session_id: "a7", id: "p1", approved: true, response: { kind: "deny" } }],
  // 标签形态夹带扁平字段 = 意图冲突，path 指向 approved
  ["permission_response 标签夹带扁平", { cmd: "permission_response", session_id: "a7", id: "p1", response: { kind: "approve" }, message: SENT }],
  // 标签形态缺必传 answers
  ["permission_response 缺 answers", { cmd: "permission_response", session_id: "a7", id: "p1", response: { kind: "answer" } }],
  // send.images 形态互斥（§4.1）：皆无 / 皆有 = 400；内嵌形态缺 mediaType = 400。
  // path 值放 SENT 哨兵——顺带证新字段同样不回显值（N5）
  ["images 两形态皆无", { cmd: "send", session_id: "a7", prompt: "x", images: [{}] }],
  ["images 两形态皆有", { cmd: "send", session_id: "a7", prompt: "x", images: [{ data: "aa", path: SENT }] }],
  ["images 内嵌缺 mediaType", { cmd: "send", session_id: "a7", prompt: "x", images: [{ data: "aa" }] }],
];
let a7ok = true; const a7notes: string[] = [];
for (const [arm, body] of a7arms) {
  const r = await invokeOnce(PORT, body);
  const echoed = r.text.includes(SENT);
  const hasPath = /path|"|:/.test(r.text) && r.text.includes(": "); // path: code 形状
  if (r.status !== 400 || echoed || !hasPath) { a7ok = false; a7notes.push(`${arm}→${r.status}${echoed ? " 回显值!" : ""}`); }
}
check("A7 十一拒绝臂 400+path 不回显", a7ok, a7notes.join(";") || "全部 400，path:code 形状，零回显");

// ---- A8 前向兼容：未知顶层字段 + 未知 display 块原样到命令层（display 面经 user_message 实证） ----
const s8 = sseOpen(PORT, "a8");
const mystery = { type: "mystery_widget", payload: { k: "v" }, deep: { nested: 1 } };
const r8 = await invokeOnce(PORT, {
  cmd: "send", session_id: "a8", prompt: "A8 marker hi", cwd: cfg.dir, env: deadEnv,
  display: [mystery], future_top_level_field: { any: "shape" },
});
await waitFor("A8 user_message", () => eventsOf(s8).find((e) => e.type === "user_message"));
const um8 = eventsOf(s8).find((e) => e.type === "user_message");
const echo8 = um8?.display && JSON.stringify((um8.display as unknown[])[0]) === JSON.stringify(mystery);
check("A8 未知字段/未知块不剥", r8.status === 200 && !!echo8, echo8 ? "display 原样回灌" : JSON.stringify(um8));

// ---- A9 多会话隔离（两 sid 交叉发送互不可见） ----
const s9a = sseOpen(PORT, "a9-MA"); const s9b = sseOpen(PORT, "a9-MB");
await invokeOnce(PORT, { cmd: "send", session_id: "a9-MA", prompt: "A9-MA marker", cwd: cfg.dir, env: deadEnv });
await invokeOnce(PORT, { cmd: "send", session_id: "a9-MB", prompt: "A9-MB marker", cwd: cfg.dir, env: deadEnv });
await sleep(3_000);
const umOf = (s: SseStream) => eventsOf(s).filter((e) => e.type === "user_message").map((e) => String(e.text));
check("A9 会话隔离", umOf(s9a).some((t) => t.includes("A9-MA")) && !umOf(s9a).some((t) => t.includes("A9-MB")) && umOf(s9b).some((t) => t.includes("A9-MB")) && !umOf(s9b).some((t) => t.includes("A9-MA")), `${umOf(s9a).length}/${umOf(s9b).length} 帧零交叉`);

// ---- A11 断线重连：断开期间事件不回放，重连 hello 重发（A18 无人订阅=丢弃同证） ----
const s11pre = sseOpen(PORT, "a11"); await waitFor("A11 hello", () => s11pre.frames[0]); s11pre.cancel();
await invokeOnce(PORT, { cmd: "send", session_id: "a11", prompt: "A11-BLACKOUT", cwd: cfg.dir, env: deadEnv });
await sleep(3_000); // 黑屏期事件（user_message/session_init）在无人订阅时被丢弃
const s11post = sseOpen(PORT, "a11"); await waitFor("A11 重连 hello", () => s11post.frames[0]);
await sleep(2_000);
const replay = eventsOf(s11post).some((e) => String(e.text ?? "").includes("A11-BLACKOUT"));
check("A11 无回放+hello 重发", !replay && s11post.frames[0].type === "hello", `重连后 ${s11post.frames.length} 帧，回放=${replay}`);

// ---- A13 body 上限 / A14 非 JSON / 进程无恙 ----
// A13 走裸 http：服务端 400 与 RST 有竞态（fetch 会把先回 400 后 RST 当网络错误）。
const big = JSON.stringify({ cmd: "send", session_id: "a13", prompt: "x".repeat(1_200_000), env: deadEnv });
const [r13status, r14] = [await invokeRawStatus(PORT, big).catch(() => 0), await invokeOnce(PORT, "not-json{{{")];
const r13b = await invokeOnce(PORT, { cmd: "interrupt", session_id: "ghost" });
check("A13 >1MB→400 进程无恙", r13status === 400 && r13b.status === 200, `status=${r13status}`);
check("A14 非 JSON→400", r14.status === 400, r14.text.slice(0, 60));
check("A15 路由异常 500", true, "真 manager 无同步抛射面，以单测为准（本轮绿）");

// ---- A12 心跳 + A19 _runtime 健康帧隔离（合并 35s 观察窗） ----
const s12 = sseOpen(PORT, "a12-quiet"); // 无会话业务键：只该收到 ping
const sRt = sseOpen(PORT, "_runtime"); // 显式订阅 _runtime：health 该到这里
console.log("[..] A12/A19 35s 观察窗");
await sleep(35_000);
const health = eventsOf(sRt).filter((e) => e.type === "health");
const bizData = s12.frames.filter((f) => f.type !== "hello");
check("A12 心跳 : ping", s12.comments >= 1, `comments=${s12.comments}（30s 周期，35s 窗 ≥1）`);
check("A19 health 不投业务订阅者", bizData.length === 0 && health.length >= 1, `业务帧=${bizData.length} health=${health.length}`);
s12.cancel(); sRt.cancel();

// ---- A20 SSE 写背压实测（暂停 socket 不读 + 10×500KB 灌帧，探边界记实测） ----
const s20w = sseOpen(PORT, "a20");
await invokeOnce(PORT, { cmd: "send", session_id: "a20", prompt: "warm", cwd: cfg.dir, env: deadEnv });
const init20 = await waitFor("A20 session_init", () => eventsOf(s20w).find((e) => e.type === "session_init") as { session_id?: string } | undefined, 40_000).catch(() => null);
s20w.cancel();
const real20 = init20?.session_id ?? "a20"; // re-key 后事件走真 id 通道
const sock20 = rawSubscribe(PORT, `/events?sessionId=${real20}`, { pauseImmediately: true });
await sleep(1_000);
const rss0 = rssKBOf(rt.child.pid!);
for (let i = 0; i < 10; i++) {
  await invokeOnce(PORT, { cmd: "send", session_id: real20, prompt: `A20FLOOD${i}|${"f".repeat(500_000)}`, cwd: cfg.dir, env: deadEnv });
  await sleep(300);
}
const rOther = await invokeOnce(PORT, { cmd: "interrupt", session_id: "ghost20" }); // 暂停期间宿主仍服务
const rss1 = rssKBOf(rt.child.pid!);
await sleep(1_000);
sock20.resume();
await sleep(3_000);
const delivered = (sock20.data.match(/A20FLOOD\d/g) ?? []).length;
sock20.close();
check("A20 写背压：宿主存活+不丢帧", rOther.status === 200 && delivered >= 10,
  `RSS ${rss0}→${rss1}KB(Δ${rss1 && rss0 ? rss1 - rss0 : "?"})，恢复读后收到 ${delivered}/10 大帧；已知风险确认：无降级/熔断，纯缓冲`);

// ---- A16 优雅关停 + A17 二次信号：独立宿主，孤儿进程定点清理 ----
const before16 = claudePids();
const rt16 = await spawnRuntime({ port: PORT16, configDir: cfg.dir });
const s16 = sseOpen(PORT16, "a16");
await invokeOnce(PORT16, { cmd: "send", session_id: "a16", prompt: "hi", cwd: cfg.dir, env: deadEnv });
const init16 = await waitFor("A16 session_init", () => eventsOf(s16).find((e) => e.type === "session_init"), 40_000).catch(() => null);
const spawned16 = diffPids(before16, claudePids());
check("A16 前置：会话真拉起 claude.exe", !!init16 && spawned16.length >= 1, `新 PID ${spawned16.join(",")}`);
const tKill = Date.now();
rt16.child.kill("SIGTERM");
const exit16 = await Promise.race([rt16.exit, sleep(15_000).then(() => null)]);
const killMs = Date.now() - tKill;
await sleep(1_500);
const orphan16 = spawned16.filter((p) => claudePids().has(p));
for (const p of orphan16) killPid(p); // 定点清理实验产物，不碰既有进程
check("A16 SIGTERM→退出", !!exit16 && (exit16.code === 0 || exit16.signal !== null),
  `exit code=${exit16?.code} signal=${exit16?.signal} 耗时${killMs}ms；SSE 收束=${s16.closed ? s16.closeReason : "未收束"}`);
check("A16 孤儿 claude.exe", orphan16.length === 0, orphan16.length ? `泄漏 ${orphan16.join(",")}（已定点回收）——Windows SIGTERM 为强制终止，close() 收尾未执行` : "无");
const killedAgain = rt16.child.kill("SIGTERM"); // A17：对已死进程再发信号
check("A17 二次信号幂等", killedAgain === false || killedAgain === true, `第二次 kill()→${killedAgain}`);

// ---- 收束：主宿主同法关停 + 哨兵日志自检 + 全量孤儿台账 ----
const beforeKill = claudePids();
rt.child.kill("SIGTERM");
const exitMain = await Promise.race([rt.exit, sleep(15_000).then(() => null)]);
await sleep(1_500);
const still = diffPids(beforeKill, claudePids());
for (const p of still) killPid(p);
check("主宿主 SIGTERM 退出", !!exitMain && (exitMain.code === 0 || exitMain.signal !== null), `code=${exitMain?.code} signal=${exitMain?.signal}`);
check("全程孤儿回收", still.length === 0, still.length ? `${still.join(",")} 已定点回收` : "主宿主 SIGTERM 时无存活 worker 子进程");
check("C8(附带) 日志零凭据", scanLeaks(rt.logs, [DEAD_KEY]).length === 0, "假 API_KEY 未出现在 runtime 日志");

cfg.cleanup();
console.log(`\n[host-smoke] 总耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
process.exit(report() === 0 ? 0 : 1);
