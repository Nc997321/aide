import { computed, ref, watch, getCurrentScope, onScopeDispose, type Ref } from "vue";
import { api, listen } from "../api";
import type { LspBoardStatus } from "@aide/sdk/types/lspPacks";

/** 语言 server 状态。idle = 未探测（LSP 关 / 未打开过面板）。 */
export type LspServerStatus = "idle" | "ok" | "missing" | "failed" | "indexing" | "sleeping";

export interface LspLangStatus {
  lang: string;
  status: LspServerStatus;
  /** 后端失败详情（spawn/handshake 的可读错误，含 stderr 摘要）；ok/missing/indexing 时无。 */
  error?: string;
  /** 说明行：Host 状态板的阶段 / 进度 / 已等待时长（旧 Host：90s 慢索引兜底文案）。 */
  note?: string;
  /** 语言服务器进程树实际占用的内存（字节），Host 约 30s 采样一次；没在跑 / 旧 Host = 缺省。 */
  memory?: number;
}

/** 内存读数 → `1.3 GB` / `512 MB`。 */
export function formatMemory(bytes: number): string {
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export type { LspBoardStatus };

function sameRoot(a: string, b: string): boolean {
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return /^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

const PHASE_STATUS: Record<LspBoardStatus["phase"], LspServerStatus> = {
  off: "idle",
  disabled: "idle",
  missing: "missing",
  starting: "indexing",
  loading: "indexing",
  indexing: "indexing",
  ready: "ok",
  failed: "failed",
  sleeping: "sleeping",
};

function waited(since: number, now: number): string {
  const s = Math.max(0, Math.round((now - since) / 1000));
  return s < 60 ? `已 ${s} 秒` : `已 ${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/** 状态板 → 说明行。就绪不写；其余如实说在哪一步、等了多久、server 自报的进度。 */
export function boardNote(b: LspBoardStatus, now: number): string | undefined {
  const pct = b.progress !== undefined ? `${b.progress}%` : "";
  const detail = [pct, b.message].filter(Boolean).join(" ");
  const tail = (head: string) => [head, detail, waited(b.since, now)].filter(Boolean).join(" · ");
  switch (b.phase) {
    case "starting":
      return tail("启动中");
    case "loading":
      return tail("加载工程");
    case "indexing":
      return tail(b.nav ? "跳转可用，按名查询索引中" : "建立索引中");
    case "sleeping":
      return "空闲休眠中，用到时自动唤醒";
    case "ready":
      if (b.keptBy === "editor") return "编辑器开着该语言的文件 · 不休眠";
      if (b.sleepAt) {
        const left = b.sleepAt - now;
        return left < 60_000 ? "即将休眠" : `${Math.ceil(left / 60_000)} 分钟后休眠`;
      }
      return undefined;
    default:
      return undefined;
  }
}

/**
 * 单语言 ensure 兜底超时：后端握手超时按语言（Java 30s 因 jdtls 首次启动慢，其余 5s），
 * invoke 层再留余量——挂起的语言标 failed，不阻塞其他。
 */
const ENSURE_TIMEOUT_MS: Record<string, number> = {
  java: 35_000,
};
const ENSURE_TIMEOUT_DEFAULT = 8_000;
/** Java 索引中诚实兜底：超过此时长仍无 ServiceReady，加提示但仍 indexing（不切假就绪）。 */
const INDEXING_SLOW_MS = 90_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

/**
 * 每语言 LSP server 状态跟踪（标题栏 LSP 面板用）。
 * 语义：detect 工作区语言 → 逐个 ensure → ok（已就绪）/ indexing（握手成功但 jdtls 索引中，
 * 仅 Java）/ missing（未安装）/ failed（spawn/握手失败）。ensure 对已启动 server 幂等。
 * Java 索引中显示「索引中…」，收到后端 lsp-server-ready 事件（jdtls ServiceReady）才切 ok；
 * 超 90s 仍无信号加「较慢…」提示但不切假就绪。server 死（lsp-server-dead）→ 清计时器重 probe。
 * 只在 LSP 开启时探测；workspaceRoot 或 enabled 变化时清空重探。
 */
export function useLspStatus(getWorkspaceRoot: () => string, enabled: Ref<boolean>) {
  /** 探测得到的行（detect + ensure）；Host 状态板有这一语言的状态时以状态板为准（见 langs）。 */
  const rows = ref<LspLangStatus[]>([]);
  /** lang → Host 状态板（就绪只认 Host 的实测探针；旧 Host 没有状态板时退回 ensure 结果）。 */
  const board = ref<Map<string, LspBoardStatus>>(new Map());
  const now = ref(Date.now());
  let ticker: ReturnType<typeof setInterval> | null = null;
  const langs = computed<LspLangStatus[]>({
    get: () =>
      rows.value.map((r) => {
        const b = board.value.get(r.lang);
        if (!b) return r;
        const out: LspLangStatus = { lang: r.lang, status: PHASE_STATUS[b.phase] };
        const err = b.error ?? r.error;
        if (err && out.status === "failed") out.error = err;
        const note = boardNote(b, now.value);
        if (note) out.note = note;
        if (b.memory) out.memory = b.memory;
        return out;
      }),
    set: (v) => {
      rows.value = v;
    },
  });
  const probing = ref(false);
  /** lang → 90s 慢索引计时器（indexing 进入起；ready/重 probe/切工作区清）。 */
  const slowTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let listening = false;
  let unlistenReady: (() => void) | null = null;
  let unlistenDead: (() => void) | null = null;

  function clearSlowTimer(lang: string) {
    const t = slowTimers.get(lang);
    if (t) { clearTimeout(t); slowTimers.delete(lang); }
  }
  function clearAllSlowTimers() {
    for (const t of slowTimers.values()) clearTimeout(t);
    slowTimers.clear();
  }

  /** 订阅后端就绪/死亡事件（LSP 开启后首次 probe 成功时调，幂等）。callback 按 workspaceRoot 过滤旧事件。 */
  function applyBoard(b: LspBoardStatus) {
    if (!sameRoot(b.workspaceRoot, getWorkspaceRoot())) return; // 旧工作区的事件
    const next = new Map(board.value);
    next.set(b.lang, b);
    board.value = next;
    syncTicker();
  }

  /** 有行在启动 / 加载 / 索引时每秒刷新「已 N 秒」，否则停表。 */
  function syncTicker() {
    // 启动 / 加载 / 索引要走「已 N 秒」，就绪的要走休眠倒计时
    const busy = [...board.value.values()].some(
      (b) => ["starting", "loading", "indexing"].includes(b.phase) || (b.phase === "ready" && !!b.sleepAt),
    );
    if (busy && !ticker) {
      ticker = setInterval(() => (now.value = Date.now()), 1000);
    } else if (!busy && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  let unlistenBoard: (() => void) | null = null;
  async function ensureListening() {
    if (listening) return;
    listening = true;
    unlistenBoard = await listen<LspBoardStatus>("lsp-status", (ev) => applyBoard(ev.payload));
    unlistenReady = await listen<{ workspaceRoot: string; lang: string }>(
      "lsp-server-ready",
      (ev) => {
        const p = ev.payload;
        if (p.workspaceRoot !== getWorkspaceRoot()) return; // 旧工作区事件忽略
        const idx = langs.value.findIndex((x) => x.lang === p.lang && x.status === "indexing");
        if (idx >= 0) {
          langs.value = langs.value.map((x, i) =>
            i === idx ? { ...x, status: "ok", note: undefined } : x,
          );
          clearSlowTimer(p.lang);
        }
      },
    );
    unlistenDead = await listen("lsp-server-dead", () => {
      // server 死 → 清计时器 + 重 probe（免卡「索引中」；ensure 幂等重拉）
      clearAllSlowTimers();
      void probe();
    });
  }

  async function probe() {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot || !enabled.value) {
      // 关闭/无工作区：显式复位。若上一次 probe 挂起未收尾（invoke 慢/挂死），
      // 这里把它拉回 false，杜绝「LSP 已关却永远显示探测中」。
      probing.value = false;
      clearAllSlowTimers();
      return;
    }
    probing.value = true;
    try {
      const detected = await api.lspDetectLanguages(workspaceRoot);
      const results = await Promise.all(
        detected.map(async (lang): Promise<LspLangStatus> => {
          let status: LspServerStatus = "failed";
          let error: string | undefined;
          try {
            const r = await withTimeout(
              api.lspEnsureServer(workspaceRoot, lang),
              ENSURE_TIMEOUT_MS[lang] ?? ENSURE_TIMEOUT_DEFAULT,
            );
            if (r.ok) {
              // ready=true（握手即就绪，非 Java）→ ok；ready=false（jdtls 索引中）→ indexing
              status = r.ready ? "ok" : "indexing";
            } else {
              status = r.kind === "server_not_found" ? "missing" : "failed";
              error = r.error;
            }
          } catch {
            status = "failed";
          }
          // Java 索引中：启动诚实兜底计时器（90s 仍无 ServiceReady → 加提示，不切假就绪）
          if (status === "indexing") {
            clearSlowTimer(lang);
            slowTimers.set(
              lang,
              setTimeout(() => {
                const idx = langs.value.findIndex((x) => x.lang === lang && x.status === "indexing");
                if (idx >= 0) {
                  langs.value = langs.value.map((x, i) =>
                    i === idx ? { ...x, note: "较慢，定义/补全可能暂时为空" } : x,
                  );
                }
              }, INDEXING_SLOW_MS),
            );
          }
          const entry: LspLangStatus = { lang, status };
          if (error) entry.error = error;
          return entry;
        }),
      );
      rows.value = results;
      void ensureListening(); // LSP 开启时订阅状态板 / 就绪 / 死亡事件
      // 回种状态板（之后靠 lsp-status 事件）；旧 Host 没有这条命令 → 保持 ensure 结果
      const snap = await api.lspStatus(workspaceRoot).catch(() => null);
      if (Array.isArray(snap)) for (const b of snap) applyBoard(b);
    } catch {
      rows.value = [];
    } finally {
      probing.value = false;
    }
  }

  watch(
    [getWorkspaceRoot, enabled],
    () => {
      rows.value = [];
      board.value = new Map();
      syncTicker();
      clearAllSlowTimers();
      void probe();
    },
    { immediate: true },
  );

  // 组件卸载清计时器 + 取消订阅（test 无 effect scope → getCurrentScope() null → skip，无警告）
  if (getCurrentScope()) {
    onScopeDispose(() => {
      clearAllSlowTimers();
      if (ticker) clearInterval(ticker);
      unlistenReady?.();
      unlistenDead?.();
      unlistenBoard?.();
    });
  }

  return { langs, probing, probe };
}