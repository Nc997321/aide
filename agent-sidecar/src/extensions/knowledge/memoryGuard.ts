// 圈选改写的那一轮不许写记忆。
//
// 为什么：知识库文档里「圈一段让 AI 改」是一次**定点编辑**，不该顺手把文档里的内容、这次的改法沉淀成
// 个人记忆——记忆会跨会话、跨项目带进以后的对话（日常记忆尤其），而文档正文团队里任何人可写、可读。
// 记忆的写入要么来自用户在普通对话里明说「记住…」，要么来自 agent 在普通对话里的判断，不该由一次圈选触发。
//
// 范围：与圈选授权同一生命周期——**本轮用户消息带圈选**（KbScopeStore.active）期间生效，下一条不带圈选的
// 用户消息到达后自动恢复。卡片里的每条消息都带圈选，所以卡片会话从不写记忆；用户回到该会话的普通聊天里
// 说「记住…」就照常写。拦的是 Write / Edit / MultiEdit / NotebookEdit 落在 `<configDir>/projects/*/memory/`
// 的调用（含任意工作区的记忆，不止当前的）。
//
// 已知边界：Bash 重定向（`echo > …/memory/x.md`）这里拦不到——命令字符串没有可靠的路径解析，硬拦会误伤；
// 这一轮的 Bash 本来也要过权限确认，用户看得到。
import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { toForwardSlashes } from "../../engine/winPaths.js";
import type { KbScopeStore } from "./scope.js";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function norm(p: string): string {
  const f = toForwardSlashes(p).replace(/\/+/g, "/");
  // 盘符路径不区分大小写
  return /^[a-zA-Z]:\//.test(f) ? f.toLowerCase() : f;
}

/** file 是不是 `<configDir>/projects/<任意工作区>/memory/` 下的文件。 */
export function isMemoryFilePath(configDir: string, file: string): boolean {
  if (!configDir || !file) return false;
  const base = norm(configDir).replace(/\/$/, "") + "/projects/";
  const f = norm(file);
  if (!f.startsWith(base)) return false;
  const rest = f.slice(base.length).split("/");
  // rest = [<工作区 key>, "memory", ...文件]
  return rest.length >= 3 && rest[0] !== "" && rest[1] === "memory";
}

export const MEMORY_GUARD_REASON =
  "这一轮是知识库里「圈选一段让 AI 改」的定点编辑，不写入记忆。只改圈中的那一段；要记住什么，请在普通对话里明说。";

export function makeKbMemoryGuardHook(opts: { configDir: string; scopes: KbScopeStore | undefined }): HookCallback | null {
  const { configDir, scopes } = opts;
  if (!scopes || !configDir) return null;
  return async (input: HookInput) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    if (!scopes.active || !WRITE_TOOLS.has(input.tool_name)) return {};
    const ti = input.tool_input;
    if (!ti || typeof ti !== "object" || Array.isArray(ti)) return {};
    const r = ti as Record<string, unknown>;
    const file = typeof r.file_path === "string" ? r.file_path : typeof r.notebook_path === "string" ? r.notebook_path : "";
    if (!isMemoryFilePath(configDir, file)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: MEMORY_GUARD_REASON,
      },
    };
  };
}
