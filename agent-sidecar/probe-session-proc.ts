// 一次性探针（不进台账）：终局判别「headless 会话由哪个进程承载」。
// 疑团：smoke 的 b10 臂轮内/轮后 claude.exe 全表差分恒空（send 已见 session_init，
// 轮次事件在流），而 probe-policy-restart 同形态却见 claude.exe:21092 跨轮存活。
// 手段：轮次进行中直接列 runtime node 进程的全部子进程（PS CIM，不靠名字过滤），
// 同时列全量 claude.exe/node.exe 的 pid+父 pid——会话进程身份一次定案。
import { execSync } from "node:child_process";
import { join } from "node:path";
import {
  spawnRuntime, invokeOnce, sseOpen, eventsOf, waitFor,
  makeConfigRoot, claudePids, diffPids, killPid, sleep,
  type RuntimeHandle, type SseStream,
} from "./smoke-headless-lib.js";
import { resolveProviderEnv } from "./smoke-headless-provider-env.js";

const ps = (cmd: string): string => {
  try {
    return execSync(`powershell.exe -NonInteractive -NoProfile -Command "${cmd}"`, { encoding: "utf8", timeout: 25_000 }).trim();
  } catch (e) { return `(PS 失败 ${String((e as Error)?.message ?? e).slice(0, 60)})`; }
};
const childrenOf = (pid: number) =>
  ps(`Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.Name }`);
const procTable = () =>
  ps(`Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'claude|node' } | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.ParentProcessId.ToString() + '|' + $_.Name }`);

const PORT = 18200;
const TOKEN = "PR4-TOK";
const pe = resolveProviderEnv();
const cfg = makeConfigRoot({});
const baseline = claudePids();
const rt: RuntimeHandle = await spawnRuntime({ port: PORT, token: TOKEN, configDir: cfg.dir });
const rtPid = rt.child.pid ?? 0;
console.log(`[probe4] runtime pid=${rtPid} 基线 claude=${JSON.stringify([...baseline])}`);
console.log(`[probe4] 起服后 claude|node 表:\n${procTable()}`);

const client: SseStream = sseOpen(PORT, "pr4-s1", TOKEN);
let real: SseStream | null = null;
const all = () => [...eventsOf(client), ...(real ? eventsOf(real) : [])];
const p1 = join(cfg.dir, "pr4.txt").replace(/\\/g, "/");

await invokeOnce(PORT, {
  cmd: "send", session_id: "pr4-s1", cwd: cfg.dir, env: pe.env,
  prompt: `用 Write 工具把内容 PR4-DENY 写入文件「${p1}」（一字不差），就这一个操作。如果被拒绝，不要重试，直接回复「被拒」。`,
  permission_mode: "manual",
  permission_policy: { revision: 1, rules: [{ id: "pr4-deny", scope: "user", order: 0, effect: "deny", tool: "Write", matcher: { kind: "path", field: "file_path", file: p1 } }] },
}, TOKEN);
const init = await waitFor("session_init", () => eventsOf(client).find((e) => e.type === "session_init") as { session_id?: string } | undefined, 90_000);
const realId = String(init.session_id ?? "");
real = sseOpen(PORT, realId, TOKEN);
console.log(`[probe4] session_init=${realId.slice(0, 8)}… 已到，轮次进行中：`);
await sleep(5_000);
console.log(`[probe4] 轮中 runtime(${rtPid}) 子进程: ${childrenOf(rtPid) || "(无)"}`);
console.log(`[probe4] 轮中 claude|node 表:\n${procTable()}`);
console.log(`[probe4] 轮中 lib claudePids 差分: ${JSON.stringify(diffPids(claudePids(), baseline))}`);

const stopped = await waitFor("message_stop", () => all().find((e) => e.type === "message_stop") ?? null, 150_000).catch(() => null);
console.log(`[probe4] message_stop=${!!stopped} 轮后 runtime 子进程: ${childrenOf(rtPid) || "(无)"}`);
console.log(`[probe4] 轮后 lib claudePids 差分: ${JSON.stringify(diffPids(claudePids(), baseline))}`);

client.cancel(); real?.cancel();
await invokeOnce(PORT, { cmd: "session_stop", session_id: realId }, TOKEN);
rt.child.kill("SIGTERM");
await Promise.race([rt.exit, sleep(8_000)]);
await sleep(1_000);
for (const p of diffPids(claudePids(), baseline)) killPid(p);
cfg.cleanup();
process.exit(0);
