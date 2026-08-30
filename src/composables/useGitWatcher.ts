import { ref, watch } from "vue";
import { api } from "../api";
import { useGit } from "./useGit";
import { useWindowFocus } from "./useWindowFocus";

const FINGERPRINT_INTERVAL = 3000;  // .git 元数据指纹：便宜（mtime 扫描）
const STATUS_INTERVAL = 10000;      // 工作区状态：抓文件保存（保存不改 .git 指纹）
const MAX_CONSECUTIVE_FAILURES = 3; // 无项目/非 git 仓库时退避

let started = false;
const lastFingerprint = ref("");

let fingerprintTimer: ReturnType<typeof setTimeout> | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;
let backedOff = false;

export function useGitWatcher() {
  if (started) return;
  started = true;

  const { loadAll, loadStatus } = useGit();
  const { isFocused } = useWindowFocus();

  /** 轮询只在「窗口可见且聚焦」且未退避时进行。 */
  function pollingActive(): boolean {
    return !backedOff && document.visibilityState === "visible" && isFocused.value;
  }

  async function checkFingerprint() {
    try {
      const fp = await api.gitFingerprint();
      consecutiveFailures = 0;
      if (lastFingerprint.value && fp !== lastFingerprint.value) {
        await loadAll();
      }
      lastFingerprint.value = fp;
    } catch (e) {
      consecutiveFailures++;
      console.warn(`[useGitWatcher] fingerprint failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, e);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        backedOff = true;
        stopTimers();
        console.warn("[useGitWatcher] 连续失败，暂停轮询直至窗口重新聚焦");
      }
    }
  }

  async function refreshStatus() {
    try {
      await loadStatus();
      consecutiveFailures = 0;
    } catch (_) {
      // loadStatus 内部已 console.error；这里不计入指纹退避
    }
  }

  function scheduleFingerprint() {
    if (fingerprintTimer) clearTimeout(fingerprintTimer);
    fingerprintTimer = setTimeout(async () => {
      if (pollingActive()) {
        await checkFingerprint();
        scheduleFingerprint();
      }
    }, FINGERPRINT_INTERVAL);
  }

  function scheduleStatus() {
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(async () => {
      if (pollingActive()) {
        await refreshStatus();
        scheduleStatus();
      }
    }, STATUS_INTERVAL);
  }

  function stopTimers() {
    if (fingerprintTimer) { clearTimeout(fingerprintTimer); fingerprintTimer = null; }
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
  }

  function resume() {
    if (fingerprintTimer || statusTimer) return; // 已在跑
    scheduleFingerprint();
    scheduleStatus();
  }

  /** 从暂停/退避/隐藏中恢复：立即刷一次并重启轮询。 */
  async function resumeAndRefresh() {
    backedOff = false;
    consecutiveFailures = 0;
    // 先查指纹：变了 loadAll（含 status），没变只 loadStatus —— 避免 git_status 重复请求
    try {
      const fp = await api.gitFingerprint();
      if (lastFingerprint.value && fp !== lastFingerprint.value) {
        await loadAll();
      } else {
        await loadStatus();
      }
      lastFingerprint.value = fp;
    } catch (e) {
      console.warn("[useGitWatcher] resume refresh failed:", e);
    }
    resume();
  }

  // 窗口焦点恢复 → 立即刷新（工作区改动不改 .git 指纹，所以指纹没变也要刷 status）
  watch(isFocused, async (focused, wasFocused) => {
    if (focused && wasFocused === false && document.visibilityState === "visible") {
      await resumeAndRefresh();
    } else if (!focused) {
      stopTimers();
    }
  });

  // 页面隐藏（最小化/切虚拟桌面）→ 完全停止；恢复可见 → 立即刷新
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopTimers();
    } else if (isFocused.value) {
      void resumeAndRefresh();
    }
  });

  resumeAndRefresh();
}
