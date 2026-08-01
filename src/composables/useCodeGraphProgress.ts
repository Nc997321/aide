import { ref, readonly } from "vue";
import { api } from "../api";
import { useNotifications } from "./useNotifications";
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

const { push, dismiss, dismissMany, notifications, registerActionHandler } = useNotifications();

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
  if (typeof window === "undefined") return; // node/test 环境（无 DOM timer）
  // 不 eager 设 building=true：快速路径（load_project_index 复用既有索引，
  // 后端 build_active 从未置 true）会让首个 poll 立刻看到 active=false 并
  // stopPoll，eager true 会造成进度条闪一帧再消失。改为由 poll 看到真实
  // active=true 才设 building——真构建延后 ≤500ms 显示（可接受），快速路径
  // 不闪。Promise 落定也会 stopPoll 兜底。
  timer = window.setInterval(async () => {
    try {
      const p = await api.codegraphBuildProgress();
      progress.value = p;
      if (p.active) {
        building.value = true;
      } else {
        stopPoll();
      }
    } catch {
      stopPoll();
    }
  }, 500);
}

/**
 * 跟踪一次 build：启 poll 拉中间进度，Promise 落定（成功/失败）时停 poll。
 * 失败/可恢复分支额外 push 通知到通知中心；完全成功时自愈 dismiss 同源旧通知。
 */
function trackBuild(p: Promise<BuildIndexResult>, root: string) {
  startPoll();
  p.then(
    (r) => {
      // 落盘结果便于排查：快速路径复用索引 / 全量重建 / embed 是否完成。
      // has_embeddings=false 表示 embedder 不可用（如 fastembed 模型未下载、
      // http 服务不可达），语义搜索不可用但结构层（精确跳转）正常。
      // r 可能为 undefined（测试 mock / 边界），防御一下不崩。
      if (r) {
        if (r.loaded) {
          console.info("[codegraph] reused existing index:", r);
          // 快速路径复用既有索引也算完全成功：自愈同 root 旧通知。
          selfHeal(root);
        } else if (r.has_embeddings === false) {
          console.warn(
            `[codegraph] build done but embeddings NOT completed — semantic search disabled, structure layer ok. embed_status: ${r.embed_status ?? "(unknown)"}`,
            r,
          );
          push({
            severity: "warning",
            source: "codegraph",
            title: "语义搜索不可用",
            body: `embedder 未就绪：\`${r.embed_status ?? "unknown"}\`。结构层正常。`,
            timestamp: Date.now(),
            dedupKey: `codegraph:embed:${root}`,
            action: { label: "重建索引" },
          });
        } else if (r.total_symbols === 0) {
          console.warn(
            `[codegraph] build done but 0 symbols collected (scanned_files=${r.scanned_files}, files_with_symbols=${r.files_with_symbols}). Either the walk found no supported source files, or extract found no symbols. Check the project root and supported extensions.`,
            r,
          );
          push({
            severity: "warning",
            source: "codegraph",
            title: "未索引到任何代码定义",
            body: `扫描 \`${r.scanned_files ?? 0}\` 个文件。检查项目根目录与支持的扩展名。`,
            timestamp: Date.now(),
            dedupKey: `codegraph:empty:${root}`,
          });
        } else {
          console.info("[codegraph] build done with embeddings:", r);
          // 完全成功：自愈——dismiss 同 root 的旧 codegraph 通知
          selfHeal(root);
        }
      }
      stopPoll();
    },
    (e) => {
      // fire-and-forget 语义，但落盘到 console 便于排查（如 spawn_blocking panic
      // 转成 join error 的场景，否则静默吞掉、进度条只闪一下就消失）。
      console.warn("[codegraph] build failed:", e);
      push({
        severity: "error",
        source: "codegraph",
        title: "向量索引构建失败",
        body: `${String(e ?? "未知错误")} 结构层精确跳转仍可用，语义搜索不可用。`,
        timestamp: Date.now(),
        dedupKey: `codegraph:build:${root}`,
      });
      stopPoll();
    },
  );
}

/** 完全成功后自愈：dismiss 同 root 的所有 codegraph:*:<root> 未读项（一次批量，单次落盘）。 */
function selfHeal(root: string) {
  const ids: string[] = [];
  for (const n of notifications.value) {
    if (n.source === "codegraph" && n.dedupKey?.endsWith(`:${root}`)) {
      ids.push(n.id);
    }
  }
  if (ids.length > 0) dismissMany(ids);
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
  console.info("[codegraph] ensureIndex:", root);
  // 串行化 close → build：codegraph_close 会设全局 build_cancel=true（停旧 root
  // 的在飞 embed），与新 build 的 embed 循环抢同一个全局 flag——若并发，close
  // 的 true 会落在新 build 的 embed 循环里使其 break，导致 embedded < total、
  // has_embeddings=false（结构层在 embed 之前完成所以不受影响）。先 await close
  // 完成（flush+drop，旧 embed 已停）再启 build，build 开头会把 build_cancel 复位
  // 为 false，竞争消除。
  const build = () =>
    trackBuild(api.codegraphBuildIndex(root), root);
  if (previous) {
    void api
      .codegraphClose(previous)
      .catch(() => {})
      .finally(build);
  } else {
    build();
  }
}

/**
 * 增量重扫（手动「更新索引」：只 reindex mtime > indexed_at 的改动文件）。
 * 快——保留未改动文件的符号/向量，只重做改动的。无进度条（通常几秒）；
 * 结果落 console 便于排查。无活跃索引时 no-op。
 */
async function rescan(root: string) {
  if (!root) return;
  try {
    const r = await api.codegraphRescan(root);
    if (!r.active_index) {
      console.warn("[codegraph] rescan: no active index for this root — open the project first.", r);
      return;
    }
    if (r.embed_ready === false) {
      console.warn("[codegraph] rescan skipped: background embed not ready yet.", r);
      return;
    }
    if (r.changed_files === 0) {
      console.info("[codegraph] rescan: no changed files (index up to date).", r);
    } else {
      console.info(
        `[codegraph] rescan: ${r.rescanned_files}/${r.changed_files} files reindexed${r.errors ? `, ${r.errors} errors` : ""}.`,
        r,
      );
    }
  } catch (e) {
    console.warn("[codegraph] rescan failed:", e);
  }
}

/**
 * 全量重建（force=true，跳过快速路径）。走版本化目录 + 进度条（trackBuild），
 * 用户能看到「嵌入符号 N/M」。用于：怀疑索引损坏、或想强制从零重建。
 */
function rebuild(root: string) {
  if (!root) return;
  trackBuild(api.codegraphBuildIndex(root, true), root);
}

/**
 * 会话轮次结束后的防抖增量重扫（3s）。
 *
 * 背景：Claude 通过 sidecar 的 Edit/Write 改文件不会触发任何索引更新（只有
 * 在 aide 文件查看器里手动保存才会 reindex）。改动累积超过 20% 阈值后，下
 * 次构建会退回全量重建。每轮 message_stop 后调一次（防抖合并密集轮次），
 * rescan 只 reindex mtime 变动的文件，保持 indexed_at 新鲜、索引常新。
 * 后端在无活跃索引 / embed 未就绪 / 无变更时是廉价 no-op，放心调。
 */
let rescanTimer: number | null = null;
function scheduleRescan() {
  if (!lastIndexedRoot) return;
  if (typeof window === "undefined") return; // node/test 环境
  if (rescanTimer != null) clearTimeout(rescanTimer);
  rescanTimer = window.setTimeout(() => {
    rescanTimer = null;
    void rescan(lastIndexedRoot);
  }, 3000);
}

// 注册「重建索引」action：dedupKey 形如 codegraph:<kind>:<root>，末段为 root。
// Windows 路径含 C:\... → split(":") 得 ["codegraph","<kind>","C","\..."]，
// slice(2).join(":") 还原为 "C:\..."。模块顶层注册一次即可。
registerActionHandler("codegraph", (n) => {
  if (!n.dedupKey) return;
  const root = n.dedupKey.split(":").slice(2).join(":");
  if (root) rebuild(root);
});

/** 仅测试用：清 timer、复位状态、清守卫，防 interval 跨用例泄漏。 */
function __resetForTest() {
  stopPoll();
  if (rescanTimer != null) {
    clearTimeout(rescanTimer);
    rescanTimer = null;
  }
  progress.value = { active: false, done: 0, total: 0, current: "", index_ready: false };
  lastIndexedRoot = "";
}

export function useCodeGraphProgress() {
  return {
    progress: readonly(progress),
    building: readonly(building),
    ensureIndex,
    trackBuild,
    rescan,
    rebuild,
    scheduleRescan,
    stopPoll,
    __resetForTest,
  };
}