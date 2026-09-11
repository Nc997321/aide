// 真模型批次（清单 §3/§4/§5 需要真 provider 的项）：B2/B4/B5/B7/B11/B14 + C6/C7 + D1/D2/D3。
// provider 配置复用当前 aide 会话（smoke-headless-provider-env.ts，用户授权 2026-09-11）。
// 手动：npm run build && npx tsx smoke-headless-realmodel.ts
// 凭据红线：真 token 只在内存→send.env；收口把它列入 C8 扫描哨兵，确证零落日志。
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  spawnRuntime, invokeOnce, sseOpen, eventsOf, waitFor, check, report,
  makeConfigRoot, makeMockMcp, claudePids, killPid, sleep, scanLeaks,
  type RuntimeHandle, type SseStream,
} from "./smoke-headless-lib.js";
import { resolveProviderEnv } from "./smoke-headless-provider-env.js";

const PORT = 18194;
const TOKEN = "RM-TOKEN-4h8";
const META_SENTINEL = "RM-META-SENTINEL";
const HDR_SENTINEL = "RM-HDR-SENTINEL";
const HDR_ROT = "RM-HDR-ROT";
const t0 = Date.now();
const el = () => `${Math.round((Date.now() - t0) / 1000)}s`;
const tryRead = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };

const pe = resolveProviderEnv();
console.log(`[realmodel] provider: ${pe.describe()}`);
const biz1 = await makeMockMcp("X-User-Token");

// C6：PreToolUse shell hook 把自身 process.env 落盘——验证 shell 侧读不到 metadata/头值。
const cfg = makeConfigRoot({ biz1: { type: "http", url: `http://127.0.0.1:${biz1.port}/mcp` } });
const dumpJs = join(cfg.dir, "dump-env.cjs").replace(/\\/g, "/");
const dumpOut = join(cfg.dir, "shell-env.json").replace(/\\/g, "/");
writeFileSync(dumpJs, 'require("fs").writeFileSync(process.argv[3], JSON.stringify(process.env))');
writeFileSync(join(cfg.dir, "settings.json"), JSON.stringify({
  mcpServers: { biz1: { type: "http", url: `http://127.0.0.1:${biz1.port}/mcp` } },
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node "${dumpJs}" x "${dumpOut}"` }] }] },
}));

// C7 探针脚本：模型经 Bash 跑它，脚本自检 process.env 里的哨兵并只输出判定 JSON
//（不 dump 值——裸 `env` 会被 CLI auto 模式分类器按「Credential Materialization」
// 正当拦截，2026-09-11 bashprobe 实锤：deny 文本进 tool_result、48s 分类延迟。
// 哨兵嵌在脚本里而非 argv，命令文本不含哨兵）。envKeys/pathLen 自证脚本确实
// 读到了真实填充的 env（防空跑假阴性）。
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

const rt: RuntimeHandle = await spawnRuntime({ port: PORT, token: TOKEN, configDir: cfg.dir });
const pidBaseline = claudePids();

// ---- 会话驱动器：client sid 拿 session_init → 真 id 通道续命（B1 钉死的 re-key 纪律） ----
class Sess {
  private answered = new Set<string>();
  readonly client: SseStream;
  real: SseStream | null = null;
  realId = "";
  constructor(readonly sid: string) { this.client = sseOpen(PORT, sid, TOKEN); }
  all(): Array<Record<string, unknown>> { return [...eventsOf(this.client), ...(this.real ? eventsOf(this.real) : [])]; }
  async send(prompt: string, extra: Record<string, unknown> = {}): Promise<number> {
    const target = this.realId || this.sid;
    const r = await invokeOnce(PORT, { cmd: "send", session_id: target, prompt, cwd: cfg.dir, env: pe.env, ...extra }, TOKEN);
    if (!this.real) {
      const i = await waitFor(`${this.sid} session_init`, () => eventsOf(this.client).find((e) => e.type === "session_init") as { session_id?: string } | undefined, 90_000).catch(() => null);
      this.realId = i?.session_id ?? this.sid;
      this.real = sseOpen(PORT, this.realId, TOKEN);
    }
    return r.status;
  }
  /** 轮次终判：等下一个 message_stop；期间自动应答权限请求（decide 决定批准与否）。 */
  async turn(timeoutMs = 150_000, decide: (ev: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown> | null> {
    const before = this.all().filter((e) => e.type === "message_stop").length;
    const tEnd = Date.now() + timeoutMs;
    while (Date.now() < tEnd) {
      for (const e of this.all()) {
        if (e.type === "permission_request" && !this.answered.has(String(e.id))) {
          this.answered.add(String(e.id));
          await invokeOnce(PORT, { cmd: "permission_response", session_id: this.realId || this.sid, id: String(e.id), approved: decide(e) }, TOKEN);
        }
      }
      const stops = this.all().filter((e) => e.type === "message_stop");
      if (stops.length > before) return stops[stops.length - 1];
      await sleep(300);
    }
    return null;
  }
  text(): string { return this.all().filter((e) => e.type === "text_delta").map((e) => String(e.delta)).join(""); }
}

// ---- B2 真模型问答轮 + 同 sid 二轮上下文 ----
const b2 = new Sess("rm-b2");
await b2.send("接下来无论我说什么，你只回复「收到」两个字，不要使用任何工具。", {
  metadata: { tenant: META_SENTINEL }, mcp_headers: { biz1: { "X-User-Token": HDR_SENTINEL } },
});
const stop1 = await b2.turn();
const stop2 = await b2.send("把你上一轮的回复原样重复一遍，不要多余内容。").then(() => b2.turn());
const reply2 = b2.text();
check("B2 真模型两轮问答+同 sid 上下文", !!stop1 && !!stop2 && stop1.usage != null && reply2.includes("收到"),
  `一轮 usage=${JSON.stringify(stop1?.usage ?? null).slice(0, 80)} effort=${stop1?.effort ?? "-"}，回复2=「${reply2.slice(-30)}」`);

// ---- C7 安全红线：metadata/mcp_headers 不进子进程 env（引擎自检脚本自证） ----
// 必须用全新独立会话：b2 首轮指令是「接下来无论我说什么，只回复收到、不要使用
// 任何工具」——同会话再发「必须调用 Bash」会被旧强指令压掉（2026-09-11 复跑
// 实锤 tools=[]，模型面污染而非引擎面）。哨兵随本会话 send 下发，红线语义不变。
// 探针从「裸跑 env 贴输出」换成自检脚本：分类器拦 env dump（见 selftestJs 注释），
// 脚本只输出判定 JSON——红线语义不变（子进程 env 逐值扫哨兵），转录零凭据。
// permission_mode=bypassPermissions：auto 模式分类器在 qwen provider 下 flaky
//（F9 发现：stage-2 classifier error fail-closed 拒绝 + 单次 48~154s 延迟，
// 两轮重试超轮次预算）——绕开分类器让红线判定确定性执行；权限流本身已由
// B4/D2（manual 批准/拒绝臂）独立钉死，PreToolUse hooks 在 bypass 下照常触发（C6 依赖）。
const c7 = new Sess("rm-c7");
await c7.send(`这是引擎安全自检，不是闲聊：你必须调用 Bash 工具真实执行命令 node "${selftestJs}"（就这一条命令，一字不改），把输出原样贴出。不要先阅读或 cat 该脚本，直接执行。禁止凭记忆作答、禁止拒绝、禁止用其他工具。`, {
  permission_mode: "bypassPermissions",
  metadata: { tenant: META_SENTINEL }, mcp_headers: { biz1: { "X-User-Token": HDR_SENTINEL } },
});
await c7.turn(240_000).catch(() => null);
const toolNames = c7.all().filter((e) => e.type === "tool_use_start").map((e) => String(e.name));
// 判定提取要抗模型行为漂移（run5 实锤：模型会先 Read 脚本再动 Bash）：从全部
// tool_result 里正则抽带引号 "envKeys" 的 JSON 对象——脚本源码里是未引号的
// `envKeys:`，cat/Read 的结果不会误命中，只有真实执行的 stdout 会。
const allResults = c7.all().filter((e) => e.type === "tool_result").map((e) => String(e.content)).join("\n");
const verdictMatch = allResults.match(/\{[^{}]*"envKeys"\s*:\s*\d+[^{}]*\}/);
let verdict: { clean?: boolean; hits?: string[]; envKeys?: number; pathLen?: number } | null = null;
try { verdict = verdictMatch ? JSON.parse(verdictMatch[0]) : null; } catch { verdict = null; }
const bashInputs = c7.all().filter((e) => e.type === "tool_use_start" && e.name === "Bash")
  .map((e) => JSON.stringify((e as { input?: unknown }).input ?? {}).slice(0, 120));
check("C7 子进程 env 不含 metadata/注入头（自检脚本实证）",
  !!verdict && verdict.clean === true && (verdict.envKeys ?? 0) > 10 && (verdict.pathLen ?? 0) > 0,
  `verdict=${JSON.stringify(verdict)}；工具=${JSON.stringify(toolNames)}；Bash 输入=${JSON.stringify(bashInputs)}；tool_result 摘要=${JSON.stringify(allResults.slice(0, 200))}`);

// ---- C6 shell hook 侧：PreToolUse 落盘的 process.env 同样读不到 metadata ----
const hookDump = await waitFor("hook dump", () => tryRead(dumpOut), 20_000).catch(() => null);
check("C6 shell hook 读不到 metadata 且无泄漏", !!hookDump && !hookDump.includes(META_SENTINEL) && !hookDump.includes(HDR_SENTINEL),
  hookDump ? `hook env 落盘 ${hookDump.length}B，哨兵命中=${hookDump.includes(META_SENTINEL) || hookDump.includes(HDR_SENTINEL) ? "有!" : "无"}` : `Bash 未执行则 hook 必然不落盘（本会话工具=${JSON.stringify(toolNames)}）`);
// C7 独立会话用完即停：多挂一个活 claude.exe 会放大后续并行臂（D1）的 provider
// 慢尾（F9 同源），message_stop 超轮次窗偶发 FAIL——释放负载。
await invokeOnce(PORT, { cmd: "session_stop", session_id: c7.realId }, TOKEN);
c7.client.cancel(); c7.real?.cancel();

// ---- B4/D2 写确认流：manual 批准 → 落盘；拒绝 → 不落盘 ----
const b4Path = join(cfg.dir, "b4-approved.txt").replace(/\\/g, "/");
const b4 = new Sess("rm-b4");
await b4.send(`用 Write 工具把内容 APPROVED-XYZ 写入文件「${b4Path}」（这个绝对路径，一字不差），就这一个操作，写完回复 done。`, { permission_mode: "manual" });
let sawPerm = false;
const b4stop = await b4.turn(150_000, () => { sawPerm = true; return true; });
const b4file = await waitFor("b4 文件", () => tryRead(b4Path), 15_000).catch(() => null);
const b4tool = b4.all().filter((e) => e.type === "tool_use_start").map((e) => `${e.name}:${JSON.stringify(e.input ?? {}).slice(0, 80)}`);
check("B4/D2 批准臂：permission_request→执行→落盘", sawPerm && !!b4file?.includes("APPROVED-XYZ") && !!b4stop, `perm=${sawPerm} file=${b4file ?? "无"}；工具调用=${JSON.stringify(b4tool.slice(-2))}`);
const b4dPath = join(cfg.dir, "b4-denied.txt").replace(/\\/g, "/");
const b4d = new Sess("rm-b4d");
await b4d.send(`用 Write 工具把内容 DENIED-XYZ 写入文件「${b4dPath}」（这个绝对路径，一字不差），就这一个操作，写完回复 done。`, { permission_mode: "manual" });
let sawPermD = false;
const b4dstop = await b4d.turn(150_000, () => { sawPermD = true; return false; });
await sleep(2_000);
check("B4/D2 拒绝臂：deny 不落盘且自然收尾", sawPermD && tryRead(b4dPath) === null && !!b4dstop, `perm=${sawPermD} deny 后文件=${tryRead(b4dPath) ?? "无(对)"}`);

// ---- B5 interrupt 长任务 ----
const b5 = new Sess("rm-b5");
await b5.send("从 1 数到 2000，每行一个数字，一个都不要漏。");
await sleep(8_000);
await invokeOnce(PORT, { cmd: "interrupt", session_id: b5.realId || b5.sid }, TOKEN);
const b5stop = await b5.turn(60_000);
const b5again = await b5.send("只回复二字：活着").then(() => b5.turn(120_000));
check("B5 interrupt 终止当前轮且会话可用", !!b5stop && !!b5again && b5.text().includes("活着"), `interrupt 后 stop_reason=${b5stop?.stop_reason}`);

// ---- B7 set_effort / set_permission_mode / set_model（含非法值不脏账面） ----
const evBefore = b2.all().length;
await invokeOnce(PORT, { cmd: "set_effort", session_id: b2.realId, effort: "low" }, TOKEN);
const eff = await waitFor("effort_changed", () => b2.all().slice(evBefore).find((e) => e.type === "effort_changed"), 15_000).catch(() => null);
await invokeOnce(PORT, { cmd: "set_permission_mode", session_id: b2.realId, mode: "plan" }, TOKEN);
const modes = await waitFor("permission_modes_available", () => b2.all().slice(evBefore).find((e) => e.type === "permission_modes_available"), 15_000).catch(() => null);
await invokeOnce(PORT, { cmd: "set_effort", session_id: b2.realId, effort: "banana" }, TOKEN);
await sleep(2_000);
const bananaActive = b2.all().slice(evBefore).some((e) => e.type === "effort_changed" && String(e.effort) === "banana");
await invokeOnce(PORT, { cmd: "set_model", session_id: b2.realId, model: "qwen3.8-flash" }, TOKEN);
const models = await waitFor("models_available", () => b2.all().slice(evBefore).find((e) => e.type === "models_available"), 20_000).catch(() => null);
// models_available 在第三方 provider（无 SDK roster）是观察项，不进红线判定
check("B7 effort/modes 回执 + 非法 effort 不脏账面", !!eff && !!modes && !bananaActive,
  `effort=${JSON.stringify(eff ?? {}).slice(0, 60)} modes回执=${!!modes} banana生效=${bananaActive} models_available(观察)=${models ? `${(models.models as unknown[])?.length ?? "?"}项/current=${models.current}` : "无——第三方 provider 无 roster，如实记录"}`);

// ---- B8 模型切换成本确认臂（a3284fc 三跳链补齐后的基线：confirm→decision→result；无应答 10s auto-deny） ----
const b8 = new Sess("rm-b8");
await b8.send("这是一次上下文体量测试，只需回复「已载」两个字，不要使用任何工具。\n" + "数据块ABCDEFGH".repeat(30_000));
await b8.turn(240_000).catch(() => null);
const evB8 = b8.all().length;
await invokeOnce(PORT, { cmd: "set_model", session_id: b8.realId, model: "qwen3.8-flash" }, TOKEN);
const confirm8 = await waitFor("B8 confirm", () => b8.all().slice(evB8).find((e) => e.type === "model_switch_confirm"), 15_000).catch(() => null);
if (confirm8) {
  await invokeOnce(PORT, { cmd: "model_switch_confirm_decision", session_id: b8.realId, confirm_id: String(confirm8.confirm_id), approve: true }, TOKEN);
  const res8 = await waitFor("B8 result", () => b8.all().slice(evB8).find((e) => e.type === "model_switch_result"), 30_000).catch(() => null);
  const evB8b = b8.all().length;
  await invokeOnce(PORT, { cmd: "set_model", session_id: b8.realId, model: "qwen3.8-max" }, TOKEN);
  const confirm8b = await waitFor("B8 第二次 confirm", () => b8.all().slice(evB8b).find((e) => e.type === "model_switch_confirm"), 15_000).catch(() => null);
  await sleep(16_000); // 10s 超时窗跨过
  const res8b = b8.all().slice(evB8b).find((e) => e.type === "model_switch_result");
  check("B8 confirm→approve→result + 不应答 10s auto-deny", !!res8 && !!confirm8b && (!res8b || res8b.ok === false),
    `confirm(warm=${confirm8.prompt_cache_warm} ctx=${confirm8.context_tokens} src=${confirm8.source}) 批准 result=${JSON.stringify(res8 ?? {}).slice(0, 90)}；超时臂=${JSON.stringify(res8b ?? "无 result 回执")}`);
} else {
  const resDirect = b8.all().slice(evB8).find((e) => e.type === "model_switch_result");
  check("B8 set_model 直切臂（第三方无缓存热→confirm 不发，如实记录）", !!resDirect,
    `model_switch_confirm 未观测（qwen prompt_cache_warm 恒 false 是主嫌疑，B2 usage cacheReadInputTokens=0 旁证）；直切回执=${JSON.stringify(resDirect ?? {}).slice(0, 100)}。confirm/decision/10s-deny 三臂在 headless 暂无端到端载体，维持待测`);
}
b8.client.cancel(); b8.real?.cancel();

// ---- D1 双租户并行问答（真模型）+ 各自 MCP 连接带各自头 ----
const d1a = new Sess("rm-d1a"); const d1b = new Sess("rm-d1b");
const hitMark = biz1.hits.length;
await Promise.all([
  d1a.send("只回复二字：甲一", { mcp_headers: { biz1: { "X-User-Token": "TOK_D1A" } } }),
  d1b.send("只回复二字：乙一", { mcp_headers: { biz1: { "X-User-Token": "TOK_D1B" } } }),
]);
const [sa, sb] = await Promise.all([d1a.turn(), d1b.turn()]);
const tA = d1a.text(); const tB = d1b.text();
await waitFor("D1 hits", () => biz1.hits.some((h) => h.value === "TOK_D1A") && biz1.hits.some((h) => h.value === "TOK_D1B"), 30_000).catch(() => null);
check("D1 双租户并行流隔离 + 连接各带头", !!sa && !!sb && tA.includes("甲") && !tA.includes("乙") && tB.includes("乙") && !tB.includes("甲")
  && biz1.hits.some((h) => h.value === "TOK_D1A") && biz1.hits.some((h) => h.value === "TOK_D1B"),
  `A=「${tA.slice(0, 12)}」 B=「${tB.slice(0, 12)}」 hits=${JSON.stringify(biz1.hits.slice(hitMark).map((h) => h.value))}`);

// ---- D3 租户 token 轮换。实测语义钉死：注入头在 query 启动时刻定装——
// 存活 query（同会话续轮）不会变头；轮换必须随会话重启（stop→resume 新 query）生效。 ----
const d1aReal = d1a.realId;
await invokeOnce(PORT, { cmd: "session_stop", session_id: d1aReal }, TOKEN);
await sleep(1_500);
const tRot = Date.now();
const d3 = new Sess("rm-d3");
await d3.send("只回复四字：甲三轮换", { resume_session_id: d1aReal, mcp_headers: { biz1: { "X-User-Token": HDR_ROT } } });
await d3.turn().catch(() => null);
const rotHit = await waitFor("D3 新头", () => biz1.hits.find((h) => h.value === HDR_ROT && h.t >= tRot), 60_000).catch(() => null);
check("D3 轮换在下一 query（会话重启+resume）生效", !!rotHit, "与 C4 单测边界一致：存活 query 旧头、新 query 新头；对接文档按此写");
d3.client.cancel(); d3.real?.cancel();

// ---- B11 resume：停会话后凭真 id 续上下文 ----
const b2real = b2.realId;
await invokeOnce(PORT, { cmd: "session_stop", session_id: b2real }, TOKEN);
await sleep(1_500);
const b11 = new Sess("rm-b11");
await b11.send("我之前让你无论说什么都只回复哪两个字？只回复那两个字。", { resume_session_id: b2real });
const b11stop = await b11.turn();
check("B11 resume 上下文接续", !!b11stop && b11.text().includes("收到"), `回复=「${b11.text().slice(0, 20)}」`);

// ---- B14 桌面字段 btw 网关误发面（P2，如实记录） ----
const btw = new Sess("rm-btw");
await btw.send("只回复 btwok", { btw: true });
const btwStop = await btw.turn();
const btwAgain = await btw.send("再回复一次 btwok2").then(() => btw.turn(90_000));
const btwReInit = (btw.real ? eventsOf(btw.real) : []).filter((e) => e.type === "session_init").length
  + eventsOf(btw.client).filter((e) => e.type === "session_init").length;
check("B14 btw 网关误发：轮次正常执行（自毁面观察记录）", !!btwStop,
  `btw 轮完成=${!!btwStop}；再发后 session_init 总数=${btwReInit}（>1=btw 回合结束自毁、续发重建新会话——桌面语义；网关不该发此字段，对接文档写明）。第二次轮回执=${btwAgain ? "有" : "无"}`);

// ---- 收束：C8 真凭据零日志泄漏 + 定点孤儿清理 ----
const secrets = [TOKEN, pe.env.ANTHROPIC_AUTH_TOKEN ?? "", pe.env.ANTHROPIC_API_KEY ?? "", META_SENTINEL, HDR_SENTINEL, HDR_ROT];
const leaks = scanLeaks(rt.logs, secrets.filter(Boolean));
check("C8 真凭据零落 runtime 日志", leaks.length === 0, `扫描 ${rt.logs.length} 行 × ${secrets.filter(Boolean).length} 哨兵（含真 token），命中=${leaks.length}`);
for (const s of [b2, c7, b4, b4d, b5, d1a, d1b, btw]) { s.client.cancel(); s.real?.cancel(); }
rt.child.kill("SIGTERM");
await Promise.race([rt.exit, sleep(10_000)]);
await sleep(1_500);
const strays = [...claudePids()].filter((p) => !pidBaseline.has(p));
for (const p of strays) killPid(p);
await biz1.close();
cfg.cleanup();
console.log(`\n[realmodel-smoke] 总耗时 ${el()}；本轮新起 claude.exe 残留 ${strays.length} 个（已定点回收）`);
process.exit(report() === 0 ? 0 : 1);
