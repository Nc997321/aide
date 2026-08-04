import { ref, watch, type Ref } from "vue";
import { api } from "../api";

/** 语言 server 状态。idle = 未探测（LSP 关 / 未打开过面板）。 */
export type LspServerStatus = "idle" | "ok" | "missing" | "failed";

export interface LspLangStatus {
  lang: string;
  status: LspServerStatus;
}

/**
 * 每语言 LSP server 状态跟踪（标题栏 LSP 面板用）。
 * 语义：detect 工作区语言 → 逐个 ensure → ok（已就绪）/ missing（server_not_found，
 * 未安装）/ failed（spawn 或握手失败）。ensure 对已启动的 server 幂等，重复探测便宜。
 * 只在 LSP 开启时探测（关着不 spawn server，保持懒启动语义）；workspaceRoot 或
 * enabled 变化时清空重探。
 */
export function useLspStatus(getWorkspaceRoot: () => string, enabled: Ref<boolean>) {
  const langs = ref<LspLangStatus[]>([]);
  const probing = ref(false);

  async function probe() {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot || !enabled.value) return;
    probing.value = true;
    try {
      const detected = await api.lspDetectLanguages(workspaceRoot);
      const results = await Promise.all(
        detected.map(async (lang): Promise<LspLangStatus> => {
          let status: LspServerStatus = "failed";
          try {
            const r = await api.lspEnsureServer(workspaceRoot, lang);
            status = r.ok ? "ok" : r.kind === "server_not_found" ? "missing" : "failed";
          } catch {
            status = "failed";
          }
          return { lang, status };
        })
      );
      langs.value = results;
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
      void probe();
    },
    { immediate: true }
  );

  return { langs, probing, probe };
}
