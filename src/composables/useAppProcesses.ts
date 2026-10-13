import { computed, ref } from "vue";
import { listen } from "@aide/sdk";
import { APP_PROCESSES_CHANGED_EVENT, appsApi } from "@aide/sdk/api/apps";
import type { AppProcess } from "@aide/sdk/types/apps";

/**
 * 侧栏应用在工作区里起的进程（标题栏徽标、应用面板顶条共用一份）。
 *
 * 模块级单例，**只认 Host 的回答**：结束一个进程之后不本地改状态，等 `app-processes-changed`
 * 再重新列。进程归 Host 管——面板关了、切去别的工作区，它照跑，所以这份清单不能长在面板里。
 */
const processes = ref<AppProcess[]>([]);
/** 每秒走一下：已运行时长、结束后留几秒再消失都靠它。只在有东西可显示时走。 */
const now = ref(Date.now());
let inflight: Promise<void> | null = null;
let stale = false;
let started = false;
let ticker: ReturnType<typeof setInterval> | null = null;

/** 结束（跑完 / 失败 / 被结束）的行再留这么久，让人看得到结果。 */
export const FINISHED_LINGER_MS = 8000;

function syncTicker(): void {
  const wanted = processes.value.some((p) => p.running || (p.endedAt ?? 0) + FINISHED_LINGER_MS > Date.now());
  if (wanted && !ticker) {
    ticker = setInterval(() => {
      now.value = Date.now();
      syncTicker();
    }, 1000);
  } else if (!wanted && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function refresh(): Promise<void> {
  if (inflight) stale = true;
  inflight ??= Promise.resolve()
    .then(() => appsApi.processList())
    .then((list) => {
      processes.value = list;
      now.value = Date.now();
      syncTicker();
    })
    .catch(() => {
      /* 旧 Host 没有这条命令：静默，徽标自然不出现 */
    })
    .finally(() => {
      inflight = null;
      if (stale) {
        stale = false;
        void refresh();
      }
    });
  return inflight;
}

/** 幂等：接上事件。App 挂载时调一次。 */
function start(): void {
  if (started) return;
  started = true;
  void refresh();
  void listen(APP_PROCESSES_CHANGED_EVENT, () => void refresh());
}

/** 该显示的：在跑的，加上刚结束不久的。 */
const visible = computed(() =>
  processes.value.filter((p) => p.running || (p.endedAt ?? 0) + FINISHED_LINGER_MS > now.value),
);
const running = computed(() => processes.value.filter((p) => p.running));

/** 「去那个工作区」由 App 接上（切工作区的唯一入口在侧栏，这里不另开一条路）。 */
let gotoWorkspaceImpl: ((path: string) => void) | null = null;

/** `1 分 05 秒` / `42 秒`。 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, "0")} 秒`;
}

/** 一行的状态说明。 */
export function describeProcess(p: AppProcess, at: number): string {
  if (p.running) return `已运行 ${formatElapsed(at - p.startedAt)}`;
  const took = `用时 ${formatElapsed((p.endedAt ?? at) - p.startedAt)}`;
  if (p.killed) return `已结束 · ${took}`;
  if (p.code === 0) return `完成 · ${took}`;
  return p.code === null ? `异常退出 · ${took}` : `失败，退出码 ${p.code} · ${took}`;
}

export type ProcessTone = "running" | "ok" | "failed" | "stopped";
export function processTone(p: AppProcess): ProcessTone {
  if (p.running) return "running";
  if (p.killed) return "stopped";
  return p.code === 0 ? "ok" : "failed";
}

export function useAppProcesses() {
  return {
    processes,
    visible,
    running,
    now,
    start,
    refresh,
    kill: (runId: string) => appsApi.processKill(runId),
    setWorkspaceSwitcher(fn: (path: string) => void): void {
      gotoWorkspaceImpl = fn;
    },
    gotoWorkspace(path: string): void {
      gotoWorkspaceImpl?.(path);
    },
  };
}

/** 仅测试用：清掉模块级状态。 */
export function resetAppProcessesForTest(): void {
  processes.value = [];
  started = false;
  inflight = null;
  stale = false;
  if (ticker) clearInterval(ticker);
  ticker = null;
}
