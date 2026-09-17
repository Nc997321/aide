// 跨目录授权（@目录即授权）的**引擎级端到端**：走真实 headless 引擎（与桌面同一套
// session-worker / 同一份 dist）+ 真模型，覆盖方案验收 #3 / #5 / #9 的引擎侧可验部分。
//
//   X（manual 档，同一会话三连）
//     X1 无授权读 B 仓文件      → 必弹 permission_request（边界存在，S2 同源）
//     X2 带 additional_dirs=[B] → 零弹窗 + workspace_attached 全量账本
//                                + 回答里出现 B 仓 CLAUDE.md / 记忆索引的标记
//                                  （当轮可达：sessionPrompt 那条路当轮不生效，F6）
//     X3 再带同一份全量（D9「客户端已知全量」）→ no-op：零弹窗、不重复广播
//   Y（auto 档，新会话）
//     Y1 首条就带 additional_dirs=[B]（spawn 期 systemPrompt 注入）
//     Y2 不带目录、prompt 里也没有任何目录段 → 仍答得出 B 仓规则与记忆标记
//        ⇒ systemPrompt 持久路径（阶段 3 的 loadAideInstructions 附加根注入）
//
// 不覆盖（要真窗口）：@ 芯片 / 卡片药丸 / 界面回声、Rust 裁定与 Tauri IPC 连线。
//
//   npx tsx smoke-headless-attach-dirs.ts
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  check, eventsOf, invokeOnce, makeConfigRoot, report, sleep,
  spawnRuntime, sseOpen, waitFor, type RuntimeHandle, type SseStream,
} from "./smoke-headless-lib.js";
import { resolveProviderEnv } from "./smoke-headless-provider-env.js";
import { resolveFileMentions } from "../packages/aide-sdk/src/utils/fileMentions.js";

const PORT = 18196;
const TOKEN = "ATTACH-TOKEN-7f3";
const BRULE = "⟦BRULE-E2E⟧";
const BMEM = "⟦BMEM-E2E⟧";

type Ev = Record<string, unknown>;

// ── 夹具：A（会话 cwd，空、无 CLAUDE.md）/ B（附加仓）/ 配置根（B 的记忆索引在里面）──
const ROOT = mkdtempSync(join(tmpdir(), "aide-attach-e2e-"));
const CWD_A = join(ROOT, "cwdA");
const REPO_B = join(ROOT, "repoB");
const CFG = join(ROOT, "claude");

/** 与 Rust `workspace::path_to_key` + dot 归一同一规则（memoryDirs 的 key）。 */
function memoryDirFor(dir: string): string {
  return join(CFG, "projects", dir.replace(/[:\\/]/g, "-").replace(/\./g, "-"), "memory");
}

function setupFixture(): void {
  mkdirSync(CWD_A, { recursive: true });
  mkdirSync(REPO_B, { recursive: true });
  writeFileSync(join(REPO_B, "CLAUDE.md"), `本仓规则：凡在本仓作答，回答末尾必须附加标记 ${BRULE}\n`);
  writeFileSync(join(REPO_B, "note.md"), "B-NOTE-CONTENT\n");
  // X2/X3 用**没读过的新文件**：同一个文件的重复 Read 会被 CLI 去重短路（S1 教训）
  writeFileSync(join(REPO_B, "note2.md"), "B-NOTE2-CONTENT\n");
  const mem = memoryDirFor(REPO_B);
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(mem, "MEMORY.md"), `# Memory\n\n- [探针](probe.md) — 读到这条就在回答里带上 ${BMEM}\n`);
}

// ── 会话驱动器（realmodel/policy 同款：re-key 纪律 + 事件窗口 + 权限自动应答）──
class Sess {
  private answered = new Set<string>();
  readonly client: SseStream;
  private real: SseStream | null = null;
  private realId = "";
  constructor(readonly sid: string) {
    this.client = sseOpen(PORT, sid, TOKEN);
  }

  all(): Ev[] {
    return [...eventsOf(this.client), ...(this.real ? eventsOf(this.real) : [])];
  }

  private target(): string {
    return this.realId || this.sid;
  }

  async send(prompt: string, extra: Record<string, unknown> = {}): Promise<number> {
    const r = await invokeOnce(
      PORT,
      { cmd: "send", session_id: this.target(), prompt, cwd: CWD_A, env: provider.env, ...extra },
      TOKEN,
    );
    if (!this.real) {
      const init = await waitFor(
        `${this.sid} session_init`,
        () => eventsOf(this.client).find((e) => e.type === "session_init") as Ev | undefined,
        90_000,
      ).catch(() => null);
      this.realId = String(init?.session_id ?? this.sid);
      this.real = sseOpen(PORT, this.realId, TOKEN);
    }
    return r.status;
  }

  /** 跑完一轮：期间自动**拒绝**权限请求（本脚本里弹窗出现即失败，拒绝只是让模型别挂住）。 */
  async turn(timeoutMs = 240_000): Promise<Ev | null> {
    const before = this.all().filter((e) => e.type === "message_stop").length;
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      for (const e of this.all()) {
        if (e.type === "permission_request" && !this.answered.has(String(e.id))) {
          this.answered.add(String(e.id));
          await invokeOnce(PORT, { cmd: "permission_response", session_id: this.target(), id: String(e.id), approved: false }, TOKEN);
        }
      }
      const stops = this.all().filter((e) => e.type === "message_stop");
      if (stops.length > before) return stops[stops.length - 1] ?? null;
      await sleep(300);
    }
    return null;
  }

  stop(): void {
    this.client.cancel();
    this.real?.cancel();
  }
}

const windowFrom = (s: Sess, mark: number): Ev[] => s.all().slice(mark);
const countType = (evs: Ev[], type: string): number => evs.filter((e) => e.type === type).length;
/** 模型正文 = text_delta 累加（headless 协议里正文只有这一条流式通道）。 */
const answerText = (evs: Ev[]): string =>
  evs.filter((e) => e.type === "text_delta").map((e) => String(e.delta ?? "")).join("");

// ── 启动 ──
setupFixture();
const provider = resolveProviderEnv();
console.log(`[attach] provider: ${provider.describe()}`);
console.log(`[attach] A(cwd)=${CWD_A}\n[attach] B(attached)=${REPO_B}\n[attach] memory=${memoryDirFor(REPO_B)}`);
const cfg = makeConfigRoot({});
const rt: RuntimeHandle = await spawnRuntime({ port: PORT, token: TOKEN, configDir: CFG });

const DENY_NOTE = "如果被拒绝，不要重试、不要改用任何其他工具（尤其不要用 Bash），直接回复「被拒」两个字。";

// ── X1：无授权 → 边界存在 ──
const x = new Sess("attach-x");
let mark = x.all().length;
await x.send(`用 Read 读一次「${join(REPO_B, "note.md")}」，只回一行：读到什么。${DENY_NOTE}`, {
  permission_mode: "manual",
});
const t1 = await x.turn();
const w1 = windowFrom(x, mark);
const perm1 = countType(w1, "permission_request");
check("X1 无授权（manual）读 cwd 外 → 弹窗", !!t1 && perm1 >= 1, `stop=${!!t1} 弹窗=${perm1}`);

// ── X2：中途带 additional_dirs=[B] + 当轮注入（真 SDK 组合器）──
const composed = await resolveFileMentions(
  `再看一眼 @${REPO_B} 这个仓：用 Read 读一次「${join(REPO_B, "note2.md")}」原样贴出来；` +
    `另外回答两件事（原样引用，别猜）：① 这个仓的 CLAUDE.md 写了什么规则？② 它的记忆索引里有哪几条？`,
  {
    readFile: async (p: string) => readFileSync(p, "utf8"),
    listDir: async (p: string) =>
      readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, is_dir: e.isDirectory() })),
    attachedDirs: [],
    // 能力位本体：桌面走 Rust 命令；这里直接读同一份文件（Rust 侧逻辑由 cargo 单测覆盖）
    memoryIndex: async (dir: string) => readFileSync(join(memoryDirFor(dir), "MEMORY.md"), "utf8"),
  },
);
check(
  "X2a 组合器产出：目录段含 B 的 CLAUDE.md 与记忆标记",
  composed.sendText.includes(BRULE) && composed.sendText.includes(BMEM),
  `段长=${composed.sendText.length}`,
);

mark = x.all().length;
await x.send(composed.sendText, { permission_mode: "manual", additional_dirs: [REPO_B] });
const t2 = await x.turn();
const w2 = windowFrom(x, mark);
const perm2 = countType(w2, "permission_request");
const attached2 = w2.filter((e) => e.type === "workspace_attached");
check("X2b 授权后同一次读 → 零弹窗", !!t2 && perm2 === 0, `stop=${!!t2} 弹窗=${perm2}`);
check(
  "X2c workspace_attached 广播全量账本",
  attached2.length === 1 && JSON.stringify(attached2[0]?.dirs ?? []).includes("repoB"),
  JSON.stringify(attached2.map((e) => e.dirs)),
);
const ans2 = answerText(w2);
check("X2d 模型说出 B 仓规则标记（当轮可达）", ans2.includes(BRULE), ans2.slice(0, 120));
check("X2e 模型说出 B 仓记忆标记（当轮可达）", ans2.includes(BMEM), ans2.slice(0, 120));

// ── X3：再带同一份全量 → no-op ──
mark = x.all().length;
await x.send(`再 Read 一次「${join(REPO_B, "note2.md")}」，回一行。`, {
  permission_mode: "manual",
  additional_dirs: [REPO_B],
});
const t3 = await x.turn();
const w3 = windowFrom(x, mark);
check("X3 全量重报 → 零弹窗（粘性）", !!t3 && countType(w3, "permission_request") === 0, `stop=${!!t3}`);
check("X3 账本无变化 → 不重复广播", countType(w3, "workspace_attached") === 0, `广播=${countType(w3, "workspace_attached")}`);
x.stop();

// ── Y：systemPrompt 持久路径（首条带目录 → spawn 注入；后续轮不带也能答）──
const y = new Sess("attach-y");
mark = y.all().length;
await y.send("只回一个字：好。不要调用任何工具。", { permission_mode: "auto", additional_dirs: [REPO_B] });
const ty1 = await y.turn();
check("Y1 首条带目录 → 正常开轮", !!ty1, `stop=${!!ty1}`);

mark = y.all().length;
await y.send(
  `回答两个问题（原样引用，别猜；不要调用任何工具）：① 本会话附加目录的 CLAUDE.md 写了什么规则？② 那个工作区的记忆索引里有哪几条？`,
  { permission_mode: "auto" },
);
const ty2 = await y.turn();
const ansY = answerText(windowFrom(y, mark));
check("Y2 systemPrompt 持久路径：规则标记在上下文里", !!ty2 && ansY.includes(BRULE), ansY.slice(0, 120));
check("Y2 systemPrompt 持久路径：记忆标记在上下文里", !!ty2 && ansY.includes(BMEM), ansY.slice(0, 120));
y.stop();

// ── 收尾 ──
await invokeOnce(PORT, { cmd: "session_stop", session_id: "attach-x" }, TOKEN);
await invokeOnce(PORT, { cmd: "session_stop", session_id: "attach-y" }, TOKEN);
rt.child.kill();
cfg.cleanup();
rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
process.exit(report());
