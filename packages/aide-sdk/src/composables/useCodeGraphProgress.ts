import { ref, readonly } from "vue";
import { api } from "../api";
import { useNotifications } from "./useNotifications";
import { useWorkspaceTrust } from "./useWorkspaceTrust";
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
 *
 * 开关（工作区级下沉后）：索引开关是 `~/.aide/state.json` 的
 * `codegraph_workspaces[<trust_key>].enabled`，**每工作区默认关**。权威在后端
 * （Rust gate 兜底），前端 `enabledForRoot` 只是会话内存缓存，承担 UI 渲染与
 * rescan/rebuild/reindexFile 的同步短路；门判定以 `refreshEnabledFor` 的
 * 每次权威拉取为准，不基于陈旧缓存。
 */

const { push, dismiss, dismissMany, notifications, registerActionHandler } = useNotifications();
const { isTrusted, trust } = useWorkspaceTrust();

const progress = ref<BuildProgress>({ active: false, done: 0, total: 0, current: "", index_ready: false });
const building = ref(false);
/** 最近一次 build 结果（成功落盘的），供代码索引面板显示索引健康
 *  （完整/残缺/未完成/语义不可用）。null = 还没建过。失败不覆盖（保留上次成功）。 */
const lastBuild = ref<BuildIndexResult | null>(null);
/** lastBuild 归属的 root——健康条按当前工作区比对，不把上一个工作区的健康
 *  状态错读给另一个工作区。 */
const lastBuildRoot = ref("");

let timer: number | null = null;
let lastIndexedRoot = "";
/** poll 间隔：2 条/秒，前端拉不推，天然节流。 */
const POLL_INTERVAL_MS = 500;
/**
 * 「请求已发出、后端还没置 active」的宽限期（见 startPoll 内注释）。
 * 只影响「Promise 未落定 + 一直没看到 active」这种中间态：Promise 一落定就
 * stopPoll，所以快速路径不会因为宽限期多显示一帧；宽限期内空转几次 poll 无
 * UI 成本（building 仍为 false）。取 5s 覆盖 runner 冷启动的最坏情况（进程
 * spawn + ort/ONNX 初始化，实测 1s 上下，慢机器/冷盘会更久）。
 */
const ACTIVE_GRACE_MS = 5000;
/** 本轮 poll 是否已见过 active=true（区分「还没开始」与「已结束」）。 */
let sawActive = false;
/** 本轮 poll 起始时刻（宽限期计时）。 */
let pollStartedAt = 0;
// 当前已知「不信任」的 root（memoize，避免每次 ensureIndex 都查一次 state.json）。
// 信任工作区后由 onWorkspaceTrusted 清空，使下一次 ensureIndex 能真正建索引。
let untrustedCurrent = "";
// 各工作区索引开关的会话内存缓存（仅渲染 + 同步短路用；权威在 state.json，
// ensureIndex 每次权威拉取刷新）。键为原始 root 路径。
const enabledForRoot = ref<Record<string, boolean>>({});

function isRootEnabled(root: string): boolean {
  return !!enabledForRoot.value[root];
}

/** 权威拉取某工作区开关并回写缓存。读失败按关处理（安全侧，与 Rust gate 兜底一致）。 */
async function refreshEnabledFor(root: string): Promise<boolean> {
  const enabled = await api.isWorkspaceCodegraphEnabled(root).catch(() => false);
  enabledForRoot.value = { ...enabledForRoot.value, [root]: enabled };
  return enabled;
}

/**
 * 门面统一门控：工作区开关关闭时所有写操作（build/rescan/rebuild/reindex）一律
 * no-op。开关逻辑只存在于门面内部——触发点（FileTree/useFileViewer/会话事件）
 * 不感知开关，也不会在调用点散落 if。同步短路读缓存；权威判定在 ensureIndex
 * （每次拉取）与 Rust gate。
 */

/** 释放活跃索引 + 清 dedup 守卫（停后台 embed、释放 shard）。disabled 分支与
 *  setRootEnabled(false) 共用，消除 ensureIndex 里 close 逻辑的重复。
 *  untrustedCurrent 不清——它是调用方管理的 memo（untrusted 分支先设再调本
 *  函数，清了会丢 memo）。 */
function closeActive() {
  const prev = lastIndexedRoot;
  lastIndexedRoot = "";
  if (prev) void api.codegraphClose(prev).catch(() => {});
}

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
  // 后端 build_active 从未置 true）下 eager true 会让进度条闪一帧再消失。
  // 改为由 poll 看到真实 active=true 才设 building。
  //
  // 停止条件不能是「看到一次 inactive 就停」——存在「build 请求已发出、后端
  // 还没置 active」的窗口：首次构建要先 spawn runner（进程启动 + ort/ONNX
  // 初始化），runner 的 progress 通知又是 250ms 一帧，主进程 atomics 要等
  // runner 跑起来之后才会翻 true，实测（2026-09-08）这个窗口 >500ms——旧实现
  // 首个 poll 就撞进去 stopPoll，而 stopPoll 不可恢复（timer 清空且没有后续
  // 触发点），结果是「任务管理器里 codegraph 进程在跑、索引在建，前端进度条
  // 永远不出现」。故：见过 active 之后翻 false = 真结束，才停；一直没见到就
  // 宽限 ACTIVE_GRACE_MS，超时（快速路径/门控早退且 Promise 迟迟不落定）才停。
  sawActive = false;
  pollStartedAt = Date.now();
  const tick = async () => {
    try {
      const p = await api.codegraphBuildProgress();
      progress.value = p;
      if (p.active) {
        sawActive = true;
        building.value = true;
        return;
      }
      if (sawActive || Date.now() - pollStartedAt >= ACTIVE_GRACE_MS) stopPoll();
    } catch {
      stopPoll();
    }
  };
  timer = window.setInterval(tick, POLL_INTERVAL_MS);
  void tick(); // 首帧立即拉，不白等一个 interval（省 500ms 点亮延迟）
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
        // Rust 门控早退（skipped: "untrusted" / "disabled"）：静默处理——
        // 「工作区不受信任」通知已由 ensureIndex 发，这里不重复告警。
        if (r.skipped) {
          stopPoll();
          return;
        }
        // 缓存最近一次 build 结果，供代码索引面板显示索引健康
        // （完整/残缺/未完成/语义不可用）。
        lastBuild.value = r;
        lastBuildRoot.value = root;
        if (r.loaded) {
          console.info("[codegraph] reused existing index:", r);
          // 快速路径复用既有索引也算完全成功：自愈同 root 旧通知。
          selfHeal(root);
        } else if (r.has_embeddings === false) {
          console.warn(
            `[codegraph] build done but embeddings NOT completed — semantic search disabled, structure layer ok. embed_status: ${r.embed_status ?? "(unknown)"} (skipped: ${r.skipped_count ?? 0}, failed: ${r.failed_count ?? 0})`,
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
        } else if (r.incremental) {
          console.info(
            `[codegraph] incremental: ${r.rescanned_files ?? 0} files reindexed (health: ${r.health ?? "complete"}, points: ${r.shard_point_count ?? "?"}):`,
            r,
          );
          selfHeal(root);
        } else if (r.resumed) {
          console.info(
            `[codegraph] resumed build done (health: ${r.health ?? "complete"}, skipped: ${r.skipped_count ?? 0}, points: ${r.shard_point_count ?? "?"}):`,
            r,
          );
          selfHeal(root);
        } else {
          console.info(
            `[codegraph] full build done (health: ${r.health ?? "complete"}, skipped: ${r.skipped_count ?? 0}, failed: ${r.failed_count ?? 0}, points: ${r.shard_point_count ?? "?"}):`,
            r,
          );
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
async function ensureIndex(root: string) {
  if (!root || root === lastIndexedRoot) return;
  // 开关门（**前置于 trust 门**）：每工作区默认关，未开的 root 完全静默 return
  // ——不发「工作区不受信任」通知，否则没开索引用户满屏信任提示。关闭且仍有
  // 活跃索引（刚关开关/从开了索引的工作区切过来）时顺带释放。
  if (!(await refreshEnabledFor(root))) {
    closeActive();
    return;
  }
  if (root === untrustedCurrent) return; // 已知不信任，跳过（信任后 onWorkspaceTrusted 清此标记）
  // 受信任工作区门控：不信任则不建索引。Rust 侧 codegraph_build_index 也有同一
  // 门控（防御纵深），前端先挡可省一次 IPC 并通知用户原因。
  const trusted = await isTrusted(root);
  if (!trusted) {
    console.info("[codegraph] ensureIndex skipped (untrusted):", root);
    untrustedCurrent = root;
    // 切到不信任工作区：释放上一个索引（若存在），不设 lastIndexedRoot——
    // 这样信任后再次 ensureIndex 能真正建（不会被 dedup 守卫挡）。
    closeActive();
    push({
      severity: "warning",
      source: "codegraph",
      title: "工作区不受信任",
      body: "代码索引未加载。信任此工作区后将自动构建。",
      timestamp: Date.now(),
      dedupKey: `codegraph:untrusted:${root}`,
      action: { label: "信任此工作区" },
    });
    return;
  }
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
    // 踩中 212-217 行注释的竞争时（close 失败 → build_cancel 仍是旧 root 的
    // true，会落在新 build 的 embed 循环里使其早退），close 失败后仍然要
    // build——否则新 root 完全没有索引；失败落 warn 便于排查 embed 缺失。
    void api
      .codegraphClose(previous)
      .catch((e) => { console.warn("[codegraph] close previous index failed:", e); })
      .finally(build);
  } else {
    build();
  }
}

/**
 * 工作区被信任后调用：清空不信任 memo 与 dedup 守卫，触发索引构建。
 * 侧栏「信任此工作区」确认后调用，确保索引随即建起来。
 */
function onWorkspaceTrusted(root: string) {
  if (!root) return;
  untrustedCurrent = "";
  lastIndexedRoot = ""; // 清 dedup 守卫，让 ensureIndex 真正跑
  void ensureIndex(root);
}

/**
 * 工作区开关切换（代码索引面板调用）。先落盘（后端权威），再拉权威值刷新
 * 缓存；开 → 清守卫并 ensureIndex（未信任工作区走它既有的 untrusted 通知流，
 * 开关即意向——信任把关在建索引门，不在开开关处）；关 → 释放该 root 的
 * 活跃索引（停后台 embed）。
 */
async function setRootEnabled(root: string, enabled: boolean) {
  if (!root) return;
  await api.setWorkspaceCodegraphEnabled(root, enabled);
  await refreshEnabledFor(root);
  if (!enabled) {
    if (lastIndexedRoot === root) closeActive();
    return;
  }
  // 开：清 dedup/不信任 memo，让 ensureIndex 真正跑（信任门在它内部）。
  if (untrustedCurrent === root) untrustedCurrent = "";
  if (lastIndexedRoot === root) lastIndexedRoot = "";
  void ensureIndex(root);
}

/**
 * 增量重扫（手动「更新索引」：只 reindex mtime > indexed_at 的改动文件）。
 * 快——保留未改动文件的符号/向量，只重做改动的。无进度条（通常几秒）；
 * 结果落 console 便于排查。无活跃索引时 no-op。
 */
async function rescan(root: string) {
  if (!root || root === untrustedCurrent) return;
  if (!isRootEnabled(root)) return; // 工作区开关关闭：不重扫（同步短路，Rust gate 兜底权威）
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
  if (!root || root === untrustedCurrent) return;
  if (!isRootEnabled(root)) return; // 工作区开关关闭：不重建（同步短路，Rust gate 兜底权威）
  trackBuild(api.codegraphBuildIndex(root, { force: true }), root);
}

/**
 * 保存后增量更新索引（门面入口，useFileViewer 不再直连 api）。关闭时返回
 * null——调用方按「未触发」处理（静默，不推通知）。
 */
async function reindexFile(root: string, file: string) {
  if (!isRootEnabled(root)) return null; // 工作区开关关闭：按「未触发」处理
  return api.codegraphReindexFile(root, file);
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
  // 不查开关：lastIndexedRoot 只在「开关门 + 信任门」双门通过后才写入，天然
  // 隐含该工作区已开启（关开关走 closeActive 会清空 lastIndexedRoot）。
  if (typeof window === "undefined") return; // node/test 环境
  if (rescanTimer != null) clearTimeout(rescanTimer);
  rescanTimer = window.setTimeout(() => {
    rescanTimer = null;
    void rescan(lastIndexedRoot);
  }, 3000);
}

// 注册 codegraph 通知 action：dedupKey 形如 codegraph:<kind>:<root>，末段为 root。
// Windows 路径含 C:\... → split(":") 得 ["codegraph","<kind>","C","\..."]，
// slice(2).join(":") 还原为 "C:\..."。两种 action：
// - codegraph:untrusted:<root> →「信任此工作区」（信任后 onWorkspaceTrusted 重建）
// - 其它（codegraph:build/empty/embed:<root>）→ 重建索引
// 模块顶层注册一次即可。
registerActionHandler("codegraph", (n) => {
  if (!n.dedupKey) return;
  if (n.dedupKey.startsWith("codegraph:untrusted:")) {
    const root = n.dedupKey.slice("codegraph:untrusted:".length);
    if (root) void trust(root).then((res) => { if (res.ok) onWorkspaceTrusted(root); });
    return;
  }
  const root = n.dedupKey.split(":").slice(2).join(":");
  if (root) rebuild(root);
});

/** 仅测试用：清 timer、复位状态、清守卫，防 interval 跨用例泄漏。 */
function __resetForTest() {
  stopPoll();
  sawActive = false;
  pollStartedAt = 0;
  if (rescanTimer != null) {
    clearTimeout(rescanTimer);
    rescanTimer = null;
  }
  progress.value = { active: false, done: 0, total: 0, current: "", index_ready: false };
  lastBuild.value = null;
  lastBuildRoot.value = "";
  lastIndexedRoot = "";
  untrustedCurrent = "";
  enabledForRoot.value = {};
}

export function useCodeGraphProgress() {
  return {
    progress: readonly(progress),
    building: readonly(building),
    lastBuild: readonly(lastBuild),
    lastBuildRoot: readonly(lastBuildRoot),
    enabledForRoot: readonly(enabledForRoot),
    ensureIndex,
    onWorkspaceTrusted,
    setRootEnabled,
    isRootEnabled,
    refreshEnabledFor,
    trackBuild,
    rescan,
    rebuild,
    reindexFile,
    scheduleRescan,
    stopPoll,
    __resetForTest,
  };
}