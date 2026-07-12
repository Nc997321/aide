import { ref, readonly } from "vue";
import { api } from "../api";
import type { BuildProgress, BuildIndexResult } from "../types";

/**
 * CodeGraph 构建进度 + 索引生命周期的状态层（模块级单例）。
 *
 * 设计要点（与项目卡死历史对齐）：
 * - 进度由前端定时 poll 同步命令 `codegraph_build_progress`（纯原子读）拉取，
 *   **绝不走 `app.emit`**——跨线程 emit 曾是卡死根因（见 memory）。
 * - 完成信号以 `codegraph_build_index` 的 Promise 为准（最可靠）；
 *   `trackBuild(p)` 启 poll，Promise resolve/reject 时停 poll。
 * - poll 期间若后端 `active` 变 false（build 已结束但 Promise 还没回），也主动停——
 *   双保险。
 * - 500ms 间隔 = 2 条/秒，前端拉不推，天然节流。
 *
 * `ensureIndex(root)` 是项目加载/工作区切换的唯一入口：切到不同 root 时
 * close 上一个索引、对新 root 触发 build 并跟踪进度；同一 root 不重复触发。
 * FileTree.loadRoot（项目加载锚点）和 useFileViewer.open（兜底）都调它，
 * lastIndexedRoot 守卫防重复——这样「只打开项目不打开文件」也能建索引。
 *
 * 渲染层（FileTree.vue）只读 `building` + `progress`，不关心 poll 生命周期。
 */

const progress = ref<BuildProgress>({ active: false, done: 0, total: 0, current: "", index_ready: false });
const building = ref(false);

let timer: number | null = null;
let lastIndexedRoot = "";

function stopPoll() {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
  building.value = false;
}

function startPoll() {
  if (timer != null) return; // 已在 poll
  building.value = true;
  timer = window.setInterval(async () => {
    try {
      const p = await api.codegraphBuildProgress();
      progress.value = p;
      if (!p.active) stopPoll();
    } catch {
      stopPoll();
    }
  }, 500);
}

/**
 * 跟踪一次 build：启 poll 拉中间进度，Promise 落定（成功/失败）时停 poll。
 * 调用方把 `api.codegraphBuildIndex(...)` 的 Promise 传进来即可。
 */
function trackBuild(p: Promise<BuildIndexResult>) {
  startPoll();
  p.then(
    () => stopPoll(),
    () => stopPoll(),
  );
}

/**
 * 项目加载/工作区切换的唯一入口。切到不同 root 时：close 上一个索引、
 * 对新 root 触发 build 并跟踪进度。同一 root 不重复触发（守卫）。
 * build 失败由 trackBuild 内部吞掉，不外泄——fire-and-forget 语义。
 */
function ensureIndex(root: string) {
  if (!root || root === lastIndexedRoot) return;
  const previous = lastIndexedRoot;
  lastIndexedRoot = root;
  if (previous) {
    void api.codegraphClose(previous).catch(() => {});
  }
  trackBuild(
    api.codegraphBuildIndex(root).catch(() => ({ loaded: false, total_symbols: 0 })),
  );
}

/** 仅测试用：清 timer、复位状态、清守卫，防 interval 跨用例泄漏。 */
function __resetForTest() {
  stopPoll();
  progress.value = { active: false, done: 0, total: 0, current: "", index_ready: false };
  lastIndexedRoot = "";
}

export function useCodeGraphProgress() {
  return {
    progress: readonly(progress),
    building: readonly(building),
    ensureIndex,
    trackBuild,
    stopPoll,
    __resetForTest,
  };
}