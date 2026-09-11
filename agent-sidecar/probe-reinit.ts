// 一次性探针（不进台账）：普通会话同 sid 两次 send，判别 session_init 重发的根因——
// A) 存活 query 每轮重发 system/init（CLI 行为，PID 不变，良性）
// B) 每轮 result 被判 error 终态 → terminate → 续发 resume 重启（PID 变，有 error 帧）
import { join } from "node:path";
import {
  spawnRuntime, invokeOnce, sseOpen, eventsOf, waitFor, check, report,
  makeConfigRoot, claudePids, killPid, sleep, type RuntimeHandle, type SseStream,
} from "./smoke-headless-lib.js";
import { resolveProviderEnv } from "./smoke-headless-provider-env.js";

const PORT = 18196;
const TOKEN = "PROBE-TOK";
const pe = resolveProviderEnv();
const cfg = makeConfigRoot({});
const rt: RuntimeHandle = await spawnRuntime({ port: PORT, token: TOKEN, configDir: cfg.dir });
const pidBaseline = claudePids();

const client: SseStream = sseOpen(PORT, "pr-s1", TOKEN);
let real: SseStream | null = null;
let realId = "";
const all = () => [...eventsOf(client), ...(real ? eventsOf(real) : [])];

async function send(prompt: string): Promise<void> {
  await invokeOnce(PORT, { cmd: "send", session_id: realId || "pr-s1", prompt, cwd: cfg.dir, env: pe.env, permission_mode: "bypassPermissions" }, TOKEN);
  if (!real) {
    const i = await waitFor("session_init", () => eventsOf(client).find((e) => e.type === "session_init") as { session_id?: string } | undefined, 90_000);
    realId = String(i.session_id ?? "");
    real = sseOpen(PORT, realId, TOKEN);
  }
}

await send("只回复一字：甲");
const stops1 = await waitFor("stop1", () => all().filter((e) => e.type === "message_stop").length >= 1 ? true : null, 120_000).catch(() => null);
const pids1 = new Set([...claudePids()].filter((p) => !pidBaseline.has(p)));
const inits1 = all().filter((e) => e.type === "session_init").map((e) => String(e.session_id));
console.log(`[probe] 轮1后: stops=${!!stops1} inits=${JSON.stringify(inits1)} pids=${JSON.stringify([...pids1])}`);

await send("只回复一字：乙");
const stops2 = await waitFor("stop2", () => all().filter((e) => e.type === "message_stop").length >= 2 ? true : null, 120_000).catch(() => null);
await sleep(2_000);
const pids2 = new Set([...claudePids()].filter((p) => !pidBaseline.has(p)));
const inits2 = all().filter((e) => e.type === "session_init").map((e) => String(e.session_id));
const errors = all().filter((e) => e.type === "error").map((e) => JSON.stringify(e).slice(0, 160));
const stops = all().filter((e) => e.type === "message_stop").map((e) => JSON.stringify({ r: e.stop_reason, is_err: e.is_error ?? null }));
console.log(`[probe] 轮2后: stops=${!!stops2} inits=${JSON.stringify(inits2)} pids=${JSON.stringify([...pids2])}`);
console.log(`[probe] error 帧: ${JSON.stringify(errors)}`);
console.log(`[probe] message_stop: ${JSON.stringify(stops)}`);

const samePids = [...pids1].every((p) => pids2.has(p)) && pids1.size === pids2.size;
check("判别A：PID 跨轮不变（存活 query 重发 init=良性 CLI 行为）", samePids && inits2.length >= 2, `samePids=${samePids} inits=${inits2.length} ids唯一=${new Set(inits2).size}`);
check("判别B排除：无 error 帧、无 resume 重启", errors.length === 0, `errors=${errors.length}`);

client.cancel();
// real 在 send() 闭包内赋值，CFA 在闭包外把它收窄回 null——断言回可空类型是正当的（X2）。
(real as SseStream | null)?.cancel();
await invokeOnce(PORT, { cmd: "session_stop", session_id: realId }, TOKEN);
rt.child.kill("SIGTERM");
await Promise.race([rt.exit, sleep(8_000)]);
await sleep(1_000);
for (const p of [...claudePids()].filter((p) => !pidBaseline.has(p))) killPid(p);
cfg.cleanup();
process.exit(report() === 0 ? 0 : 1);
