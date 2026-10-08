// 冒烟（台账）：**CLAUDE_CODE_EXTRA_BODY 能不能让「快速档关思考」在兼容端点上真正生效**。
//
// 背景（2026-09-19 实测）：CLI 按模型名查**它自己编译在 claude.exe 里的**能力表，对不认识的
// 模型名（deepseek-* / 本地 ollama 模型等）整个 `thinking` 字段都不发；兼容端点「无该字段 =
// 默认开推理」。所以在这些通道上，「快速」只隐藏了显示、token 照烧。
// 兜底：sidecar 在 spawn 时把 `{"thinking":{"type":"disabled"}}` 经 CLAUDE_CODE_EXTRA_BODY
// 注入（engine/cliEnv.ts），绕过那份名单直接写请求体——**不依赖模型名、也不依赖端点认
// Claude 名**（对照：旧的线名别名方案要供应商认 Claude 名，ollama 直接 404）。
//
// 两臂对照 + 三条判据：
//   A 臂（不注入）：有思考块 —— 这是"CLI 丢参数"这个前提的**金丝雀**：哪天它绿了（无思考块），
//                    说明 CLI 自己修了这个行为，EXTRA_BODY 注入可以撤掉。
//   B 臂（注入）  ：① 无思考块（真关掉了）
//                   ② 响应自报 model 仍是传入的真名（**没被静默换成别的模型**——只验①会漏这条）
//
// 用法（agent-sidecar 目录）：
//   AIDE_BASE_URL=$ANTHROPIC_BASE_URL AIDE_TOKEN=$ANTHROPIC_AUTH_TOKEN AIDE_MODEL=deepseek-flash \
//   npx tsx smoke-thinking-extrabody.ts
import { existsSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { check, report } from "./smoke-ledger.js";

export {};

const DEFAULT_CLAUDE_EXE = process.env.USERPROFILE + "/IdeaProjects/aide/agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe";
const claudeExe = process.env.AIDE_CLAUDE_EXE ?? (existsSync(DEFAULT_CLAUDE_EXE) ? DEFAULT_CLAUDE_EXE : undefined);
const BASE_URL = process.env.AIDE_BASE_URL;
const TOKEN = process.env.AIDE_TOKEN;
const REAL_MODEL = process.env.AIDE_MODEL ?? "deepseek-flash";
const PROMPT = "估算 127*349 的精确值。先仔细心算验证两遍，再只输出最终数字。";

/** 与 engine/cliEnv.ts 的 THINKING_DISABLED_BODY 同值——两边漂移等于这条冒烟失效。 */
const THINKING_DISABLED_BODY = '{"thinking":{"type":"disabled"}}';

/** 一臂的参数。extraBody 缺省 = 不设该 env（对照臂）。 */
interface ProbeArm {
  /** 写进 CLAUDE_CODE_EXTRA_BODY 的值；不给 = 不设该 env。 */
  extraBody?: string;
}

type Obs = { blocks: string[]; text: string; reportedModel: string };

/** CLI 在上游出错时回一条**合成**消息（model 标记 `<synthetic>`），此时既没有 thinking 块、
 *  也没有自报真名——不认这条就会把"请求失败"读成"真的不推理"，是**假绿**。
 *  （2026-09-19 实测踩到：ollama 那条 A 臂返回 ["text"]+<synthetic>，B1 判据直接错了。） */
function armError(o: Obs): string | null {
  if (o.reportedModel === "<synthetic>") return o.text.slice(0, 300) || "（合成消息无文本）";
  return null;
}

async function probe(arm: ProbeArm): Promise<Obs> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ANTHROPIC|CLAUDECODE|CLAUDE_CODE_|CLAUDE_EFFORT|CLAUDE_AGENT_SDK|CLAUDE_PID)/.test(k)) delete env[k];
  env.CLAUDE_CONFIG_DIR = process.env.USERPROFILE + "/.aide/claude";
  if (BASE_URL) env.ANTHROPIC_BASE_URL = BASE_URL;
  // 没给 token 也要能跑（ollama 这类本地端点不需要真凭据）：CLI 无凭据时直接回
  // "Not logged in · Please run /login" 并且**根本不发请求**——那会让 B1 假绿。
  // 端点自己不校验，占位即可（probe-cli-body-replay.ts 同款）。
  if (TOKEN) env.ANTHROPIC_AUTH_TOKEN = TOKEN;
  else env.ANTHROPIC_API_KEY = "smoke-dummy";
  if (arm.extraBody) env.CLAUDE_CODE_EXTRA_BODY = arm.extraBody;

  const q = query({
    prompt: PROMPT,
    options: {
      model: REAL_MODEL,
      settingSources: [],
      allowedTools: [],
      // 快速档的真实形状：请求关闭思考
      thinking: { type: "disabled" } as never,
      env,
      ...(claudeExe ? { pathToClaudeCodeExecutable: claudeExe } : {}),
    },
  });
  let blocks: string[] = [];
  let text = "";
  let reportedModel = "?";
  for await (const m of q as AsyncIterable<any>) {
    if (m.type === "assistant" && m.message) {
      const content = (m.message.content ?? []) as Array<{ type: string; text?: string }>;
      blocks = content.map((b) => b.type);
      text = content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      // API 自报的模型名——徽标就盖这个戳（adoptAssistantModel）
      reportedModel = String(m.message.model ?? "?");
      break;
    }
  }
  return { blocks, text, reportedModel };
}

console.log(`=== EXTRA_BODY 冒烟（真端点）===`);
console.log(`  模型=${REAL_MODEL}  注入=${THINKING_DISABLED_BODY}`);
console.log(">>> A 臂：不注入（预期仍有思考块 = CLI 丢了参数）");
const a = await probe({});
console.log(`   块=${JSON.stringify(a.blocks)}  自报 model=${a.reportedModel}`);
console.log(">>> B 臂：注入 EXTRA_BODY（预期无思考块）");
const b = await probe({ extraBody: THINKING_DISABLED_BODY });
console.log(`   块=${JSON.stringify(b.blocks)}  自报 model=${b.reportedModel}`);

const aErr = armError(a);
const bErr = armError(b);
if (aErr) console.log(`   ⚠️ A 臂走上游错误路径：${aErr}`);
if (bErr) console.log(`   ⚠️ B 臂走上游错误路径：${bErr}`);

// 先钉"两臂都真的打到上游"：合成消息下 B1/B2 会**假绿**——没有 thinking 块只是因为请求失败了。
check("B0 两臂都真打到上游（无 <synthetic> 合成消息）", !aErr && !bErr, `A=${aErr ?? "ok"} / B=${bErr ?? "ok"}`);
check("B1 注入臂真的不推理（无 thinking 块）", !bErr && !b.blocks.includes("thinking"), `块=${JSON.stringify(b.blocks)}`);
check("B2 注入臂响应自报 model 仍是真名（没被静默换模型）", !bErr && b.reportedModel === REAL_MODEL, `自报=${b.reportedModel}，期望=${REAL_MODEL}`);
check("A 金丝雀：不注入时仍有思考块——CLI 仍丢参数（绿了 = CLI 修了，可撤注入）", !aErr && a.blocks.includes("thinking"), `块=${JSON.stringify(a.blocks)}`);
process.exit(report() === 0 ? 0 : 1);
