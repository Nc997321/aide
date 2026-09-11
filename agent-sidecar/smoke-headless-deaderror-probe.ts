// 定向探针（不进验收台账）：死端点 error 帧的真实到达时刻——B1/C4/D3 文档结论依赖它。
// 手动：npx tsx smoke-headless-deaderror-probe.ts   （跑满 6 分钟，输出到达时间线）
import { spawnRuntime, invokeOnce, sseOpen, eventsOf, waitFor, makeConfigRoot, deadEndpointEnv } from "./smoke-headless-lib.js";

const PORT = 18198;
const cfg = makeConfigRoot({});
const rt = await spawnRuntime({ port: PORT, configDir: cfg.dir });
const env = deadEndpointEnv("probe-fake-key");
const s1 = sseOpen(PORT, "probe-1");
const t0 = Date.now();
const el = () => `${Math.round((Date.now() - t0) / 1000)}s`;
await invokeOnce(PORT, { cmd: "send", session_id: "probe-1", prompt: "probe deaderror", cwd: cfg.dir, env });
const init = await waitFor("session_init", () => eventsOf(s1).find((e) => e.type === "session_init") as { session_id?: string } | undefined, 60_000).catch(() => null);
console.log(`[${el()}] session_init=${init?.session_id ?? "FAIL"}`);
const real = init?.session_id ?? "probe-1";
const s2 = sseOpen(PORT, real); // re-key 后长挂观察（不掐）
for (let i = 0; i < 36; i++) {
  await new Promise((r) => setTimeout(r, 10_000));
  for (const s of [s1, s2]) {
    for (const e of eventsOf(s)) {
      if (e.type === "error" || e.type === "message_stop") console.log(`[${el()}] 帧@${s === s1 ? "client" : "real"}: ${JSON.stringify(e).slice(0, 160)}`);
    }
  }
  const seen = [...eventsOf(s1), ...eventsOf(s2)];
  if (seen.some((e) => e.type === "error" || e.type === "message_stop")) break;
}
console.log(`[${el()}] 探针结束：client 通道 ${s1.frames.length} 帧 / real 通道 ${s2.frames.length} 帧；runtime 存活=${!rt.child.killed}`);
rt.child.kill();
await new Promise((r) => rt.child.once("exit", r));
cfg.cleanup();
process.exit(0);
