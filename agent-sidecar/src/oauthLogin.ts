import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { resolveClaudeExe } from "./claudeExe.js";

export type OAuthLoginResult =
  | { ok: true; method: "oauth"; authorizeUrl: string }
  | { ok: false; method: "none"; error: string };

/**
 * A2 路径：在临时 query 会话上发 claude_authenticate 控制请求，拿授权 URL。
 * claude.exe 自己的本地回调服务器接住浏览器跳转、把 token 写进 ~/.aide/claude/.credentials.json。
 *
 * NOTE: 当前未接入 runtime 命令——A2 需 runtime 请求-响应/事件通道（现 send_to_runtime
 * 是 fire-and-forget，拿不回 authorize URL）。此函数是 building block，待 OAuth 接入任务
 * 在 session-worker 里调用。单元测试 mock query 验证降级逻辑。
 *
 * 见 docs/superpowers/specs/2026-08-11-onboarding-design.md §6.4。
 */
export async function startOAuthLogin(): Promise<OAuthLoginResult> {
  try {
    const session = query({
      pathToClaudeCodeExecutable: resolveClaudeExe(),
      env: process.env as Record<string, string>,
      // 无 user message——仅承载控制请求。若 SDK 要求首条 user message 才建会话，
      // 此处会抛错 → 返回 ok:false 触发 A1/API key 降级。
    } as Parameters<typeof query>[0]) as Query;
    const resp = (await (session as any).request({
      subtype: "claude_authenticate",
      loginWithClaudeAi: true,
    })) as { automaticUrl?: string; manualUrl?: string };
    const url = resp?.automaticUrl || resp?.manualUrl;
    if (!url) return { ok: false, method: "none", error: "no authorize url" };
    return { ok: true, method: "oauth", authorizeUrl: url };
  } catch (e: any) {
    return { ok: false, method: "none", error: String(e?.message ?? e) };
  }
}