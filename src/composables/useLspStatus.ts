import { ref, watch, getCurrentScope, onScopeDispose, type Ref } from "vue";
import { api, listen } from "../api";

/** 语言 server 状态。idle = 未探测（LSP 关 / 未打开过面板）。 */
export type LspServerStatus = "idle" | "ok" | "missing" | "failed" | "indexing";

export interface LspLangStatus {
  lang: string;
  status: LspServerStatus;
  /** 后端失败详情（spawn/handshake 的可读错误，含 stderr 摘要）；ok/missing/indexing 时无。 */
  error?: string;
  /** 诚实兜底文案：indexing 超 90s 仍无就绪信号时设置（仍 indexing，不切假就绪）。 */
  note?: string;
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
  const langs = ref<LspLangStatus[]>([]);
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
  async function ensureListening() {
    if (listening) return;
    listening = true;
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
      langs.value = results;
      void ensureListening(); // LSP 开启时订阅就绪/死亡事件
    } catch {
      langs.value = [];
    } finally {
      probing.value = false;
    }
  }

  watch(
    [getWorkspaceRoot, enabled],
    () => {
      langs.value = [];
      clearAllSlowTimers();
      void probe();
    },
    { immediate: true },
  );

  // 组件卸载清计时器 + 取消订阅（test 无 effect scope → getCurrentScope() null → skip，无警告）
  if (getCurrentScope()) {
    onScopeDispose(() => {
      clearAllSlowTimers();
      unlistenReady?.();
      unlistenDead?.();
    });
  }

  return { langs, probing, probe };
}