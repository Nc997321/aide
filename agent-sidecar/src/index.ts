import * as readline from "readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent, ModelOption, SidecarCommand } from "./types.js";
import { MessageQueue } from "./generator.js";
import { PermissionManager } from "./permissions.js";
import { TaskTracker } from "./tasks.js";
import { SubagentTracker } from "./subagents.js";
import { mapSdkMessage, buildUserMessage } from "./mapper.js";

function emit(event: ChatEvent) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.https_proxy ||
  process.env.http_proxy;
if (proxyUrl) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const queue = new MessageQueue();
const permMgr = new PermissionManager();
const taskTracker = new TaskTracker();
const subagentTracker = new SubagentTracker();
let currentQuery: Awaited<ReturnType<typeof query>> | null = null;
let sessionId: string | undefined;
// 模型选择只存内存，不落盘——重开会话回落到 provider 默认模型。
let currentModel = "";
/** 最近一次从 assistant 消息里坐实的具体 wire model id，用来判断是否需要重新映射+广播。 */
let lastConcreteModel = "";
let lastModels: ModelOption[] = [];
// 内部用：alias(value) → resolvedModel 前缀，用来把 assistant 消息里的具体
// wire model id（如 "claude-sonnet-5-20260101"）反查回下拉里对应的别名选项。
let aliasByResolvedPrefix: { value: string; resolvedPrefix: string }[] = [];

async function emitModelsAvailable(q: Awaited<ReturnType<typeof query>>) {
  try {
    const init = await q.initializationResult();
    lastModels = init.models.map((m) => ({ value: m.value, displayName: m.displayName }));
    aliasByResolvedPrefix = init.models
      .filter((m) => m.resolvedModel)
      .map((m) => ({ value: m.value, resolvedPrefix: m.resolvedModel as string }));
    emit({ type: "models_available", models: lastModels, current: currentModel });
  } catch {
    // SDK 版本不支持时静默跳过，前端下拉直接隐藏
  }
}

/** 把 assistant 消息里的具体 wire model id 映射回下拉框里能选中的别名值；
 *  找不到对应别名时原样返回（下拉显示为空，属于已知的展示边界情况）。 */
function resolveDropdownValue(concreteModel: string): string {
  const hit = aliasByResolvedPrefix.find(
    (a) => concreteModel === a.resolvedPrefix || concreteModel.startsWith(`${a.resolvedPrefix}-`),
  );
  return hit ? hit.value : concreteModel;
}

/** 每轮结束后查一次当前上下文窗口用量，喂前端的进度条。SDK 版本不支持
 *  `getContextUsage` 时静默跳过——前端没收到事件就不显示这块 UI。 */
async function emitContextUsage(q: Awaited<ReturnType<typeof query>>) {
  try {
    const usage = await q.getContextUsage();
    emit({
      type: "context_usage",
      total_tokens: usage.totalTokens,
      max_tokens: usage.maxTokens,
      percentage: usage.percentage,
    });
  } catch {
    // 同上：拿不到就跳过
  }
}

async function startLoop(cwd?: string) {
  try {
    // 出错后继续循环，等待下一条消息（避免 queue 无消费者）
    while (true) {
      try {
        const q = query({
          prompt: queue[Symbol.asyncIterator](),
          options: {
            permissionMode: "default",
            canUseTool: permMgr.makeCallback(emit) as any,
            settingSources: ["project", "user"],
            allowedTools: ["Agent", "Task"],
            skills: "all",
            ...(cwd ? { cwd } : {}),
            // release 打包：Rust 侧把随 app 分发的原生 CLI 路径通过环境变量传入；
            // 未设置时 SDK 从 node_modules 解析（dev 模式）
            ...(process.env.AIDE_CLAUDE_EXE
              ? { pathToClaudeCodeExecutable: process.env.AIDE_CLAUDE_EXE }
              : {}),
            ...(sessionId ? { resume: sessionId } : {}),
          },
        });
        currentQuery = q;

        for await (const msg of q) {
          mapSdkMessage(msg, emit, taskTracker, subagentTracker);
          if ((msg as any).type === "system" && (msg as any).subtype === "init") {
            sessionId = (msg as any).session_id;
            void emitModelsAvailable(q);
          } else if (
            // 主线程（非子代理）assistant 消息自带实际用的模型——SDK 没有别的渠道
            // 告诉我们"没手动切换时默认用的是哪个"，只能从这里坐实。
            (msg as any).type === "assistant" &&
            !(msg as any).parent_tool_use_id &&
            (msg as any).message?.model &&
            (msg as any).message.model !== lastConcreteModel
          ) {
            lastConcreteModel = (msg as any).message.model;
            currentModel = resolveDropdownValue(lastConcreteModel);
            if (lastModels.length > 0) {
              emit({ type: "models_available", models: lastModels, current: currentModel });
            }
          } else if ((msg as any).type === "result") {
            // 每轮结束后上下文用量才稳定，这里查一次刷新进度条
            void emitContextUsage(q);
          }
        }
        // for await 正常结束（queue closed）
        break;
      } catch (e: any) {
        currentQuery = null;
        if (e?.name !== "AbortError") {
          emit({ type: "error", message: String(e?.message ?? e) });
        }
        // AbortError（用户中断）或普通错误后继续循环，等待下一条消息
      }
    }
  } finally {
    currentQuery = null;
  }
}

const rl = readline.createInterface({ input: process.stdin });
let loopStarted = false;

rl.on("line", (line) => {
  let cmd: SidecarCommand;
  try {
    cmd = JSON.parse(line);
  } catch {
    return;
  }

  if (cmd.cmd === "send") {
    if (cmd.session_id) sessionId = cmd.session_id;
    if (!loopStarted) {
      loopStarted = true;
      startLoop(cmd.cwd);
    }
    queue.push({
      type: "user",
      message: buildUserMessage(cmd.prompt, cmd.images ?? []),
      parent_tool_use_id: null,
    } as any);
  } else if (cmd.cmd === "permission_response") {
    permMgr.resolve(cmd.id, cmd.approved, cmd.always);
  } else if (cmd.cmd === "interrupt") {
    currentQuery?.interrupt().catch(() => {});
  } else if (cmd.cmd === "set_model") {
    currentQuery
      ?.setModel(cmd.model)
      .then(() => {
        currentModel = cmd.model;
        emit({ type: "models_available", models: lastModels, current: currentModel });
      })
      .catch(() => {});
  }
});

rl.on("close", () => {
  queue.close();
  process.exit(0);
});
