// 冒烟 S1/S2（方案 docs/superpowers/plans/2026-09-17-cross-directory-session.md）：会话中扩根
//
// 用法（agent-sidecar 目录）：npx tsx smoke-attach-dirs.ts [arm]
//   main    R1 主测：基线读 → applyFlagSettings → 再读 + 写。auto 档。
//   manual  R1/S2 决胜臂：auto 档下 cwd 外本来就通（见 main 的基线），权限层只有在
//           manual 档才真做判定 —— 这里才看得出 additionalDirectories 是否改变判定。
//           读 A（同 cwd，对照）vs 读 B（cwd 的兄弟）前后对比 + canUseTool 是否被叫。
//   auto2   对照臂：两轮、不带 flag —— 用于判定"第二次 init"到底是 applyFlagSettings
//           触发的，还是第二轮消息带来的。
//   spawn   F4 探针：launch 时带 additionalDirectories，只看 init 回报了什么。
//
// 判据：① applyFlagSettings 是否既不抛错、也不换 session_id
//       ② canUseTool 是否被叫（被叫 = CLI 本会弹窗/要授权）——路径级信号，与工具无关
//       ③ out.txt 真的落盘（不信模型自述，落盘才是实锤）
//       ④ init.mcp_servers 是否含 B 仓 settings.json 的 marker（阳性对照 s1-control 必须出现）
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(tmpdir(), "aide-s1");
const CWD_A = join(ROOT, "workspaceA"); // 会话 cwd
const REPO_B = join(ROOT, "repoB"); // 要授权的"另一个仓"：A 的兄弟，不在 A 子树里
const OUT_B = join(REPO_B, "out.txt");
const MARKER = "s1-marker"; // B 仓 settings.json 里声明的 MCP server（F4 探针）
const MARKER_CONTENT = "OK-FROM-SPIKE";
const MODEL = "haiku"; // 最便宜的别名；权限语义与模型无关
const A_TXT = join(CWD_A, "a.txt");
const A2_TXT = join(CWD_A, "a2.txt"); // cache 臂：第二轮换新文件，避免 CLI 去重短路
const B_TXT = join(REPO_B, "b.txt");
const B2_TXT = join(REPO_B, "b2.txt"); // manual 臂第二轮用：必须是没读过的新文件

const arm = process.argv[2] ?? "main";

interface ArmPlan {
  mode: string;
  /** launch 时就把 B 挂上（spawn 臂专属）。 */
  attachAtLaunch: boolean;
  before: string;
  /** 有则在第一轮结束后 applyFlagSettings 再发。 */
  flagThen?: string;
  /** 是否真的调 applyFlagSettings（缺省 true）——对照臂必须显式 false，否则不是对照。 */
  applyFlag?: boolean;
}

const ARMS: Record<string, ArmPlan> = {
  main: {
    mode: "auto",
    attachAtLaunch: false,
    before: `用 Read 工具各读一次，把内容原样贴出来；读不到就写"读不到"：\n1) ${A_TXT}\n2) ${B_TXT}`,
    flagThen: `再读一次 ${B_TXT}，然后用 Write 把字符串 ${MARKER_CONTENT} 写进 ${OUT_B}。只回一行：读到什么、写成功没有。`,
  },
  manual: {
    mode: "manual",
    attachAtLaunch: false,
    before: `用 Read 工具各读一次，逐个报告成功还是失败（不要重试）：\n1) ${A_TXT}（同工作区，对照）\n2) ${B_TXT}（工作区之外）`,
    // 必须换一个**没用过**的文件：同一个文件的重复 Read 会被 CLI 去重短路
    // （"Wasted call — file unchanged"），根本走不到权限判定。
    flagThen: `再 Read 一次 ${B2_TXT}（另一个文件），报告成功还是失败。`,
  },
  // manual 的对照：结构完全相同、只是不调 flag —— 用来排除"turn 1 的 allow 已经把整个
  // 目录授予了会话"这条混淆（若是它，本轮 turn 2 也会不弹窗）。
  manual2: {
    mode: "manual",
    attachAtLaunch: false,
    applyFlag: false,
    before: `用 Read 工具各读一次，逐个报告成功还是失败（不要重试）：\n1) ${A_TXT}（同工作区，对照）\n2) ${B_TXT}（工作区之外）`,
    flagThen: `再 Read 一次 ${B2_TXT}（另一个文件），报告成功还是失败。`,
  },
  // manual 的干净正测：flag **先于任何 B 仓接触**，第二轮才第一次读 B —— 没有"已授予"
  // 可借用，弹不弹窗只能是 flag 决定的。
  manual3: {
    mode: "manual",
    attachAtLaunch: false,
    before: `用 Read 读一次 ${A_TXT}，回一行内容。`,
    flagThen: `用 Read 读一次 ${B_TXT}（工作区之外的目录），报告成功还是失败。`,
  },
  auto2: {
    mode: "auto",
    attachAtLaunch: false,
    applyFlag: false,
    before: `用 Read 读一次 ${A_TXT}，回一行内容。`,
    flagThen: `再用 Read 读一次 ${A_TXT}，回一行内容。`,
  },
  spawn: {
    mode: "auto",
    attachAtLaunch: true,
    before: "只回一个字：好。不要调用任何工具。",
  },
  // cache/cache2：applyFlagSettings 会不会改 prompt 前缀（= 中途扩根是否冷缓存）。
  // 两臂**逐字相同**，唯一变量 = 两轮之间有没有调 flag；判据 = RESULT 2 的 cacheRead
  // （前缀没变 → 几乎整段命中；前缀被重写 → 断崖式跌到接近 0、cacheCreate 顶上）。
  cache: {
    mode: "auto",
    attachAtLaunch: false,
    before: `用 Read 读一次 ${A_TXT}，回一行内容。`,
    flagThen: `用 Read 读一次 ${A2_TXT}，回一行内容。`,
  },
  cache2: {
    mode: "auto",
    attachAtLaunch: false,
    applyFlag: false,
    before: `用 Read 读一次 ${A_TXT}，回一行内容。`,
    flagThen: `用 Read 读一次 ${A2_TXT}，回一行内容。`,
  },
};

interface State {
  sessionIds: Set<string>;
  canUse: string[];
  inits: number;
  flagError: string;
  flagMs: number;
  canUseBeforeFlag: number;
  flagApplied: boolean;
  /** 每轮 result 的 token 账（cache 臂用来判"前缀有没有被重写"）。 */
  turns: Array<{ in: number; cacheRead: number; cacheCreate: number; out: number }>;
}

// ── 夹具：两个互不包含的目录 ────────────────────────────────────────────────
function setupFixture(): void {
  mkdirSync(CWD_A, { recursive: true });
  mkdirSync(join(REPO_B, ".claude"), { recursive: true });
  writeFileSync(A_TXT, "A-FILE-CONTENT\n");
  writeFileSync(A2_TXT, "A2-FILE-CONTENT\n");
  writeFileSync(B_TXT, "B-FILE-CONTENT\n");
  writeFileSync(B2_TXT, "B2-FILE-CONTENT\n");
  writeFileSync(join(REPO_B, "CLAUDE.md"), "# B 仓规则\n- 这条来自 B 仓的 CLAUDE.md\n");
  writeFileSync(
    join(REPO_B, ".claude", "settings.json"),
    JSON.stringify({ mcpServers: { [MARKER]: { command: "cmd", args: ["/c", "exit"] } } }, null, 2),
  );
  rmSync(OUT_B, { force: true }); // 先删掉，落盘才算实锤
  console.log(`[fixture] cwd=${CWD_A}\n[fixture] attached=${REPO_B}（cwd 的兄弟，非子目录）`);
}

// ── CLI 可执行文件：优先 env，其次 pnpm 嵌套路径（仓库已两次踩坑），否则交 SDK 默认 ──
function resolveClaudeExe(): string | undefined {
  if (process.env.AIDE_CLAUDE_EXE) return process.env.AIDE_CLAUDE_EXE;
  const pnpm = join(process.cwd(), "node_modules", ".pnpm");
  if (!existsSync(pnpm)) return undefined;
  const hit = readdirSync(pnpm).find((d) => d.startsWith("@anthropic-ai+claude-agent-sdk-win32-x64@"));
  if (!hit) return undefined;
  const exe = join(pnpm, hit, "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe");
  return existsSync(exe) ? exe : undefined;
}

// ── 流式输入：applyFlagSettings 只在 streaming input 模式下可用 ──
const pending: unknown[] = [];
let wake: (() => void) | null = null;
async function* prompts(): AsyncGenerator<unknown> {
  while (true) {
    if (pending.length) {
      yield pending.shift();
      continue;
    }
    await new Promise<void>((r) => {
      wake = r;
    });
  }
}
function push(text: string): void {
  pending.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  wake?.();
}

function buildOptions(plan: ArmPlan, state: State): Record<string, unknown> {
  const claudeExe = resolveClaudeExe();
  return {
    cwd: CWD_A,
    model: MODEL,
    // 复刻 app 的选项形状（queryOptions.ts:52-58 + permissionModes.ts:10-15 的默认档）
    settingSources: [],
    allowDangerouslySkipPermissions: true,
    permissionMode: plan.mode,
    // 记下"CLI 本会要授权"的每一次调用；返回值放行，免得挡住后续动作
    canUseTool: async (toolName: string, input: any) => {
      state.canUse.push(String(input?.file_path ?? toolName));
      console.log("[canUseTool]", toolName, snippet(input?.file_path ?? input));
      return { behavior: "allow", updatedInput: input };
    },
    env: { ...process.env, CLAUDE_CONFIG_DIR: `${process.env.USERPROFILE}/.aide/claude` },
    // 阳性对照：options 里给的 server 必须出现在 init.mcp_servers——否则"B 仓 marker 没出现"
    // 只是这个字段不报东西，不能当作"add-dir 目录不是配置来源"的证据。
    mcpServers: { "s1-control": { command: "cmd", args: ["/c", "exit"] } },
    ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
    ...(plan.attachAtLaunch ? { additionalDirectories: [REPO_B] } : {}),
  };
}

function snippet(content: unknown): string {
  const s = typeof content === "string" ? content : JSON.stringify(content);
  return (s ?? "").replace(/\s+/g, " ").slice(0, 200);
}

function observe(msg: any, state: State): void {
  const sid: string | undefined = msg.session_id ?? msg.sessionId;
  if (sid) state.sessionIds.add(sid);
  if (msg.type === "system") {
    if (msg.subtype === "init") {
      state.inits++;
      console.log(
        `[init #${state.inits}]`,
        JSON.stringify({
          session_id: msg.session_id,
          cwd: msg.cwd,
          model: msg.model,
          mcp_servers: (msg.mcp_servers ?? []).map((s: any) => `${s.name}:${s.status ?? "?"}`),
        }),
      );
    } else if (msg.subtype !== "thinking_tokens") {
      console.log("[system]", msg.subtype);
    }
  }
  if (msg.type === "assistant") {
    for (const b of msg.message?.content ?? []) {
      if (b.type === "tool_use") console.log("[tool_use]", b.name, snippet(b.input?.file_path ?? b.input));
      if (b.type === "text" && b.text?.trim()) console.log("[assistant]", snippet(b.text));
    }
  }
  if (msg.type === "user") {
    for (const b of msg.message?.content ?? []) {
      if (b.type === "tool_result") console.log("[tool_result]", b.is_error ? "ERROR" : "ok", snippet(b.content));
    }
  }
}

async function run(): Promise<void> {
  const plan = ARMS[arm] ?? ARMS.main;
  const state: State = {
    sessionIds: new Set(),
    canUse: [],
    inits: 0,
    flagError: "",
    flagMs: -1,
    canUseBeforeFlag: 0,
    flagApplied: false,
    turns: [],
  };
  const watchdog = setTimeout(() => {
    console.log("!! WATCHDOG 超时（240s）——现场如上");
    process.exit(2);
  }, 240_000);

  const q: any = query({ prompt: prompts() as any, options: buildOptions(plan, state) as any });
  push(plan.before);

  let results = 0;
  for await (const msg of q as AsyncIterable<any>) {
    observe(msg, state);
    if (msg.type !== "result") continue;
    results++;
    const u = msg.usage ?? {};
    state.turns.push({
      in: u.input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheCreate: u.cache_creation_input_tokens ?? 0,
      out: u.output_tokens ?? 0,
    });
    console.log(`=== RESULT ${results} ===`, msg.subtype, "| session_id =", msg.session_id);
    console.log(
      `    usage: in=${u.input_tokens ?? 0} cacheRead=${u.cache_read_input_tokens ?? 0} ` +
        `cacheCreate=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens ?? 0}`,
    );
    if (results >= 2 || !plan.flagThen) break;

    if (results === 1 && plan.flagThen) {
      if (plan.applyFlag === false) {
        console.log(">>> 对照臂：不调 applyFlagSettings，直接发第二轮");
        push(plan.flagThen);
        continue;
      }
      state.canUseBeforeFlag = state.canUse.length;
      state.flagApplied = true;
      console.log(`>>> applyFlagSettings({ permissions: { additionalDirectories: [${REPO_B}] } })`);
      const t0 = Date.now();
      state.flagMs = Date.now() - t0;
      try {
        await q.applyFlagSettings({ permissions: { additionalDirectories: [REPO_B] } });
        state.flagMs = Date.now() - t0;
        console.log(`    OK（${state.flagMs}ms）`);
      } catch (e) {
        state.flagMs = Date.now() - t0;
        state.flagError = String((e as Error)?.message ?? e);
        console.log(`    THREW（${state.flagMs}ms）:`, state.flagError);
      }
      push(plan.flagThen);
    }
  }

  clearTimeout(watchdog);
  verdict(arm, plan, state);
}

function verdict(arm: string, plan: ArmPlan, state: State): void {
  let outContent = "(未落盘)";
  try {
    outContent = readFileSync(OUT_B, "utf8").trim();
  } catch {
    /* 没生成 = 写失败 */
  }
  console.log("\n================ 判据 ================");
  console.log(`臂 / 档位          : ${arm} / ${plan.mode}${plan.attachAtLaunch ? "（launch 带 additionalDirectories）" : ""}`);
  console.log(`session_id 集合    : ${JSON.stringify([...state.sessionIds])}  ${state.sessionIds.size === 1 ? "✓ 未变" : "✗ 变了/缺失"}`);
  console.log(`init 次数          : ${state.inits}`);
  console.log(`canUseTool 被叫    : ${state.canUse.length} 次 ${JSON.stringify(state.canUse)}`);
  if (state.flagApplied) {
    console.log(`  flag 前 / 后     : ${state.canUseBeforeFlag} / ${state.canUse.length - state.canUseBeforeFlag}`);
  }
  if (plan.flagThen) {
    console.log(
      `applyFlagSettings  : ${!state.flagApplied ? "未调（对照臂）" : state.flagError ? `✗ 抛错 ${state.flagError}` : `✓ 未抛错 (${state.flagMs}ms)`}`,
    );
    console.log(`B 仓 out.txt       : ${outContent}${arm === "main" ? (outContent === MARKER_CONTENT ? "  ✓ 写到跨目录了" : "  ✗ 没写成功") : ""}`);
  }
  if (state.turns.length) {
    console.log(
      "每轮 token 账      : " +
        state.turns
          .map((t, i) => `#${i + 1} in=${t.in} cacheRead=${t.cacheRead} cacheCreate=${t.cacheCreate}`)
          .join(" | "),
    );
  }
  if (arm === "cache" || arm === "cache2") {
    const t2 = state.turns[1];
    console.log(
      `判据（RESULT 2）   : cacheRead=${t2?.cacheRead ?? -1} cacheCreate=${t2?.cacheCreate ?? -1}` +
        "—— cache 与 cache2 两臂相等 = 前缀没被 flag 重写（不冷缓存）；cache 断崖式下跌 = 变了",
    );
  }
}

setupFixture();
void run();
