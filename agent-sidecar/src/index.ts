import * as readline from "readline";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ChatEvent, SidecarCommand } from "./types.js";
import { MessageQueue } from "./generator.js";
import { PermissionManager } from "./permissions.js";
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
let currentQuery: Awaited<ReturnType<typeof query>> | null = null;
let sessionId: string | undefined;

async function startLoop(cwd?: string) {
  const originalCwd = process.cwd();
  if (cwd) process.chdir(cwd);

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
            skills: "all",
            ...(sessionId ? { resume: sessionId } : {}),
          },
        });
        currentQuery = q;

        for await (const msg of q) {
          mapSdkMessage(msg, emit);
          if ((msg as any).type === "system" && (msg as any).subtype === "init") {
            sessionId = (msg as any).session_id;
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
    if (cwd) process.chdir(originalCwd);
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
    permMgr.resolve(cmd.id, cmd.approved);
  } else if (cmd.cmd === "interrupt") {
    currentQuery?.interrupt().catch(() => {});
  }
});

rl.on("close", () => {
  queue.close();
  process.exit(0);
});
