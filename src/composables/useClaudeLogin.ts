// Claude 官方账号登录的界面侧流程：Host 驱动随包 claude CLI（Rust `claude_login.rs`），
// 这里负责「谁开浏览器」的跨界决定、轮询结果、递授权码。
//
// 登录发生在 Host 上，浏览器在用户面前的机器上：
//  - 本机 Host：CLI 自己开浏览器并接回调，用户什么都不用粘贴；
//  - WSL / SSH Host：回调到不了目标机 → 这里在本机打开登录链接，用户把页面最后给的
//    授权码粘贴回来。
import { onScopeDispose, ref } from "vue";
import { hostApi } from "@aide/sdk/api";
import { api, openExternal } from "../api";

export type ClaudeLoginPhase = "idle" | "starting" | "waiting" | "succeeded" | "failed";

const POLL_MS = 1000;

function messageOf(e: unknown, fallback: string): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : fallback;
}

export function useClaudeLogin(onSuccess?: () => void) {
  const phase = ref<ClaudeLoginPhase>("idle");
  const error = ref("");
  /** 登录链接（「浏览器没打开？」时手动再开）。 */
  const authorizeUrl = ref("");
  /** 浏览器由 Host 上的 CLI 打开（本机 Host）；false = 由本界面打开、需要粘贴授权码。 */
  const hostOpensBrowser = ref(true);
  const submitting = ref(false);
  let timer: ReturnType<typeof setInterval> | null = null;

  function stopPolling() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function pollOnce() {
    try {
      const state = await api.claudeLoginState();
      if (state.phase === "succeeded") {
        stopPolling();
        phase.value = "succeeded";
        onSuccess?.();
      } else if (state.phase === "failed") {
        stopPolling();
        phase.value = "failed";
        error.value = state.error;
      } else if (state.phase === "idle") {
        // Host 那边已经没有这次登录了（Host 重启 / 别处取消）
        stopPolling();
        phase.value = "idle";
      }
    } catch {
      // 一次轮询失败不算登录失败（Host 短暂断线会自己回来），下一拍再问
    }
  }

  async function isLocalHost(): Promise<boolean> {
    try {
      return (await hostApi.current()).key === "local";
    } catch {
      return true; // 问不到按本机处理：最坏是 CLI 多试一次开浏览器，链接仍可手动打开
    }
  }

  async function start() {
    stopPolling();
    phase.value = "starting";
    error.value = "";
    try {
      const local = await isLocalHost();
      hostOpensBrowser.value = local;
      const { authorizeUrl: url } = await api.claudeLoginStart(local);
      authorizeUrl.value = url;
      if (!local) await openExternal(url);
      phase.value = "waiting";
      timer = setInterval(() => void pollOnce(), POLL_MS);
    } catch (e) {
      phase.value = "failed";
      error.value = messageOf(e, "登录启动失败");
    }
  }

  async function submitCode(code: string) {
    if (!code.trim()) return;
    submitting.value = true;
    try {
      await api.claudeLoginSubmitCode(code.trim());
      await pollOnce();
    } catch (e) {
      error.value = messageOf(e, "提交授权码失败");
    } finally {
      submitting.value = false;
    }
  }

  async function cancel() {
    stopPolling();
    phase.value = "idle";
    error.value = "";
    await api.claudeLoginCancel().catch(() => {});
  }

  /** 手动再开一次登录页（这个链接走「页面给授权码」的流程，本机 Host 也能用）。 */
  function openLoginPage() {
    if (authorizeUrl.value) void openExternal(authorizeUrl.value);
  }

  onScopeDispose(stopPolling);

  return { phase, error, authorizeUrl, hostOpensBrowser, submitting, start, submitCode, cancel, openLoginPage };
}
