// 补测批次（清单 §3 遗留项）：B10 update_permission_policy 实质裁决面（P1）
// + B9 stop_bg_task 后台任务终止（P2）。
// 手动：npm run build && npx tsx smoke-headless-policy.ts
//
// B10 判定设计（manual 模式是对照基线）：manual 下「无规则匹配」必然走
// permission_request 弹窗（B4 已钉死）——因此本臂零弹窗 + 落盘/不落盘
// 就能把「策略 hook 在裁决」与「CLI 默认流」区分开：
//   rev1 deny（send 首带）→ 模型 Write 被 hook 直拒：零弹窗、零落盘、
//     deny 理由（含规则 id）进 tool_result；
//   rev2 allow（存活会话中 POST update_permission_policy 推送，不重启）→
//     同 worker 下一轮 Write 零弹窗直接落盘；
//   rev1 重放（revision 落后）→ 被单调守卫忽略，allow 仍生效。
// 「零重启」判据（probe-reinit.ts 2026-09-11 实锤）：CLI 流式输入模式下存活
// query **每轮都重发 system/init（同 id）**——session_init 计数不是重启证据；
// 重启的判据是 init id 变化 / error 帧 / claude.exe PID 更换，三者都必须为零。
// B9 判定设计：bypassPermissions 绕开 qwen 下 flaky 的 auto 分类器（F9，
// 与 C7 同法）；bg_task_ended(stopped) 必须在 session_stop 之前到达——
// worker 关闭时 stopAllRunning 会合成同款终态，顺序错了就测不出 stop_bg_task 本身。
// 凭据红线：真 token 只在内存→send.env；收口 C8-lite 扫描 runtime 日志（N5）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  spawnRuntime, invokeOnce, sseOpen, eventsOf, waitFor, check, report,
  makeConfigRoot, claudePids, claudeChildrenOf, killPid, sleep, scanLeaks,
  type RuntimeHandle, type SseStream,
} from "./smoke-headless-lib.js";
import { resolveProviderEnv } from "./smoke-headless-provider-env.js";

const PORT = 18195;
const TOKEN = "POL-TOKEN-9k2";
const t0 = Date.now();
const el = () => `${Math.round((Date.now() - t0) / 1000)}s`;
const tryRead = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };

const pe = resolveProviderEnv();
console.log(`[policy] provider: ${pe.describe()}`);
const cfg = makeConfigRoot({});
const rt: RuntimeHandle = await spawnRuntime({ port: PORT, token: TOKEN, configDir: cfg.dir });
const pidBaseline = claudePids();
// 会话 CLI 归属判据：runtime node 进程名下的 claude.exe（CIM 父进程面，F11 后
// tasklist 名字差分不再可信）。b10 臂内只有 b10 一个会话 → 子进程集即它的 CLI。
const rtPid = rt.child.pid ?? 0;
const cliPids = (): Set<number> => claudeChildrenOf(rtPid);
const sameSet = (a: Set<number>, b: Set<number>): boolean => a.size === b.size && [...a].every((p) => b.has(p));

// ---- 会话驱动器（realmodel 同款 re-key 纪律 + 事件窗口计数） ----
type Ev = Record<string, unknown>;
class Sess {
  private answered = new Set<string>();
  readonly client: SseStream;
  real: SseStream | null = null;
  realId = "";
  constructor(readonly sid: string) { this.client = sseOpen(PORT, sid, TOKEN); }
  all(): Ev[] { return [...eventsOf(this.client), ...(this.real ? eventsOf(this.real) : [])]; }
  target(): string { return this.realId || this.sid; }
  async send(prompt: string, extra: Record<string, unknown> = {}): Promise<number> {
    const r = await invokeOnce(PORT, { cmd: "send", session_id: this.target(), prompt, cwd: cfg.dir, env: pe.env, ...extra }, TOKEN);
    if (!this.real) {
      const i = await waitFor(`${this.sid} session_init`, () => eventsOf(this.client).find((e) => e.type === "session_init") as { session_id?: string } | undefined, 90_000).catch(() => null);
      this.realId = i?.session_id ?? this.sid;
      this.real = sseOpen(PORT, this.realId, TOKEN);
    }
    return r.status;
  }
  /** 轮次终判：等下一个 message_stop；期间自动应答权限请求（decide 决定批准与否）。
   *  缺省 deny——本脚本里弹窗出现即断言失败，deny 只是让模型别挂住。 */
  async turn(timeoutMs = 180_000, decide: (ev: Ev) => boolean = () => false): Promise<Ev | null> {
    const before = this.all().filter((e) => e.type === "message_stop").length;
    const tEnd = Date.now() + timeoutMs;
    while (Date.now() < tEnd) {
      for (const e of this.all()) {
        if (e.type === "permission_request" && !this.answered.has(String(e.id))) {
          this.answered.add(String(e.id));
          await invokeOnce(PORT, { cmd: "permission_response", session_id: this.target(), id: String(e.id), approved: decide(e) }, TOKEN);
        }
      }
      const stops = this.all().filter((e) => e.type === "message_stop");
      if (stops.length > before) return stops[stops.length - 1] ?? null;
      await sleep(300);
    }
    return null;
  }
  stop(): void { this.client.cancel(); this.real?.cancel(); }
}

/** 事件窗口：mark 之后的新事件（每轮独立计数，避免跨轮污染归因）。 */
const windowFrom = (s: Sess, mark: number): Ev[] => s.all().slice(mark);
const countType = (evs: Ev[], type: string): number => evs.filter((e) => e.type === type).length;
const resultText = (evs: Ev[]): string => evs.filter((e) => e.type === "tool_result").map((e) => String(e.content ?? "")).join("\n");

// ---- 策略 DTO（HTTP 边界纯数据，形状由 headless-schema permissionRule 校验） ----
const writePathRule = (id: string, effect: "allow" | "deny", file: string) => ({
  id, scope: "user" as const, order: 0, effect, tool: "Write",
  matcher: { kind: "path" as const, field: "file_path" as const, file },
});
const pushPolicy = async (s: Sess, revision: number, rules: ReturnType<typeof writePathRule>[]): Promise<number> => {
  const r = await invokeOnce(PORT, { cmd: "update_permission_policy", session_id: s.target(), policy: { revision, rules } }, TOKEN);
  return r.status;
};

// ---- B10：deny(rev1) → allow(rev2 推送) → 旧 rev 重放被忽略 ----
const p1 = join(cfg.dir, "b10-policy.txt").replace(/\\/g, "/");
const b10 = new Sess("pol-b10");

const m1 = b10.all().length;
await b10.send(`用 Write 工具把内容 B10-DENY 写入文件「${p1}」（这个绝对路径，一字不差），就这一个操作。如果被拒绝，不要重试、不要改用任何其他工具或方式，直接回复「被拒」两个字。`, {
  permission_mode: "manual",
  permission_policy: { revision: 1, rules: [writePathRule("b10-deny-rule", "deny", p1)] },
});
// 轮中采样（B10-4 观测有效性守卫）：send 已回（session_init 已到）、轮次进行中——
// 此刻 runtime 名下必有会话 claude.exe；为空 = 观测面失效（F11），判据显式失败而非静默失真。
await sleep(6_000);
const pidsMid = cliPids();
// deny 轮给 240s 窗：qwen 慢尾（F9 同源）在带诊断采样的轮次实测超 180s。
const t1 = await b10.turn(240_000);
const w1 = windowFrom(b10, m1);
const perm1 = countType(w1, "permission_request");
const denyText = resultText(w1);
check("B10-1 首带 rev1 deny：hook 直拒（零弹窗/零落盘/理由进 tool_result）",
  !!t1 && perm1 === 0 && tryRead(p1) === null && denyText.includes("b10-deny-rule") && denyText.includes("was denied"),
  `stop=${!!t1} 弹窗=${perm1} 文件=${tryRead(p1) ?? "无(对)"} tool_result 摘要=${JSON.stringify(denyText.slice(0, 140))}`);
const pidsT1 = cliPids();

const rev2Status = await pushPolicy(b10, 2, [writePathRule("b10-allow-rule", "allow", p1)]);
const m2 = b10.all().length;
await b10.send(`用 Write 工具把内容 B10-ALLOW 写入文件「${p1}」（这个绝对路径，一字不差），就这一个操作，写完回复 done。`);
const t2 = await b10.turn();
const w2 = windowFrom(b10, m2);
const perm2 = countType(w2, "permission_request");
const f2 = tryRead(p1);
check("B10-2 存活会话推 rev2 allow：下一轮零弹窗按新策略放行",
  rev2Status === 200 && !!t2 && perm2 === 0 && !!f2?.includes("B10-ALLOW"),
  `push=${rev2Status} stop=${!!t2} 弹窗=${perm2} 文件=${JSON.stringify((f2 ?? "无").slice(0, 40))}`);

const staleStatus = await pushPolicy(b10, 1, [writePathRule("b10-deny-rule", "deny", p1)]);
const m3 = b10.all().length;
await b10.send(`用 Write 工具把内容 B10-STALE 写入文件「${p1}」（这个绝对路径，一字不差），就这一个操作，写完回复 done。`);
const t3 = await b10.turn();
const w3 = windowFrom(b10, m3);
const perm3 = countType(w3, "permission_request");
const f3 = tryRead(p1);
check("B10-3 旧 revision 重放被忽略：allow 仍生效",
  staleStatus === 200 && !!t3 && perm3 === 0 && !!f3?.includes("B10-STALE"),
  `push(旧rev)=${staleStatus}(入队 200，裁决面忽略) stop=${!!t3} 弹窗=${perm3} 文件=${JSON.stringify((f3 ?? "无").slice(0, 40))}`);

// 零重启三判据（见头注）：init id 唯一、零 error 帧、runtime 名下 claude.exe
// 集合跨「轮中→轮1后→轮3后」三采样点不变（pidsMid 为空 = 观测失效，显式 FAIL）。
const initIds = b10.all().filter((e) => e.type === "session_init").map((e) => String(e.session_id));
const errCount = countType(b10.all(), "error");
const pidsEnd = cliPids();
const pidsSame = pidsMid.size >= 1 && sameSet(pidsMid, pidsT1) && sameSet(pidsT1, pidsEnd);
check("B10-4 策略推送全程零会话重启（同 query 存活）",
  new Set(initIds).size === 1 && errCount === 0 && pidsSame,
  `init 重发=${initIds.length} 次/唯一 id=${new Set(initIds).size}（每轮重发同 id=CLI 良性行为，F10） error 帧=${errCount} cli pid 轮中=${JSON.stringify([...pidsMid])} 轮1后=${JSON.stringify([...pidsT1])} 轮3后=${JSON.stringify([...pidsEnd])}`);
await invokeOnce(PORT, { cmd: "session_stop", session_id: b10.realId }, TOKEN);
b10.stop();

// ---- B9：后台任务 stop_bg_task → bg_task_ended(stopped) ----
const b9 = new Sess("pol-b9");
await b9.send('用 Bash 工具启动一个后台任务：command 为 sleep 60，必须把 run_in_background 参数设为 true。启动成功后立即回复「BG-OK」，不要等待任务结束、不要做其他任何事。', {
  permission_mode: "bypassPermissions",
});
const started = await waitFor("bg_task_started", () => b9.all().find((e) => e.type === "bg_task_started") as { id?: string } | undefined, 150_000).catch(() => null);
await b9.turn(120_000).catch(() => null);
let ended: Ev | null = null;
if (started?.id) {
  const stopStatus = await invokeOnce(PORT, { cmd: "stop_bg_task", session_id: b9.realId, task_id: String(started.id) }, TOKEN);
  ended = await waitFor("bg_task_ended(stopped)", () => b9.all().find((e) => e.type === "bg_task_ended" && String(e.id) === String(started.id)) ?? null, 60_000).catch(() => null);
  check("B9 stop_bg_task：started→stop→ended(stopped)",
    stopStatus.status === 200 && !!ended && ended.status === "stopped",
    `task=${String(started.id).slice(0, 24)}… invoke=${stopStatus.status} ended=${ended ? JSON.stringify({ status: ended.status, summary: String(ended.summary ?? "").slice(0, 60) }) : "未到达"}`);
} else {
  const tools = b9.all().filter((e) => e.type === "tool_use_start").map((e) => `${e.name}:${JSON.stringify(e.input ?? {}).slice(0, 90)}`);
  check("B9 stop_bg_task：started→stop→ended(stopped)", false, `bg_task_started 未观测；工具调用=${JSON.stringify(tools.slice(0, 3))}（模型未按 run_in_background 启动则如实 FAIL）`);
}
// session_stop 必须在断言之后：worker 关闭的 stopAllRunning 会合成 stopped 终态，先发就测不出 stop_bg_task 本身
await invokeOnce(PORT, { cmd: "session_stop", session_id: b9.realId }, TOKEN);
b9.stop();

// ---- 收束：C8-lite 真凭据零落日志 + 定点孤儿清理 ----
const secrets = [TOKEN, pe.env.ANTHROPIC_AUTH_TOKEN ?? "", pe.env.ANTHROPIC_API_KEY ?? ""];
const leaks = scanLeaks(rt.logs, secrets.filter(Boolean));
check("C8-lite 真凭据零落 runtime 日志", leaks.length === 0, `扫描 ${rt.logs.length} 行 × ${secrets.filter(Boolean).length} 哨兵，命中=${leaks.length}`);

rt.child.kill("SIGTERM");
await Promise.race([rt.exit, sleep(10_000)]);
await sleep(1_500);
const strays = [...claudePids()].filter((p) => !pidBaseline.has(p));
for (const p of strays) killPid(p);
cfg.cleanup();
console.log(`\n[policy-smoke] 总耗时 ${el()}；本轮新起 claude.exe 残留 ${strays.length} 个（已定点回收）`);
process.exit(report() === 0 ? 0 : 1);
