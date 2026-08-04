import { ref, watch, type Ref } from "vue";
import { api } from "../api";
import { useLsp } from "./useLsp";
import { useNotifications } from "./useNotifications";

/** 工作区 LSP 设置前端侧：开关 + 排除目录。权威值在后端 state JSON。
 *  workspaceRoot 用 getter 传入——工作区切换时 enabled/excludes 自动刷新
 * （标题栏 LSP 面板常驻，不同于设置面板每次打开重建）。 */
export function useWorkspaceLsp(getWorkspaceRoot: () => string) {
  const { enableLsp, disableLsp, isLspOn } = useLsp();
  const enabled: Ref<boolean> = ref(isLspOn(getWorkspaceRoot()));
  const excludes = ref<string[]>([]);
  const excludesDirty = ref(false);

  // spec T15 读路径补齐：UI 不再 write-only。best-effort 加载，失败静默
  //（后端命令不存在 / state 损坏时不阻断 UI）。
  async function refreshExcludes() {
    excludes.value = await api
      .workspaceGetLspExcludes(getWorkspaceRoot())
      .catch(() => [] as string[]);
  }
  void refreshExcludes();

  // 工作区切换：enabled 重算 + 排除目录重载（excludesDirty 作废）。
  watch(getWorkspaceRoot, () => {
    enabled.value = isLspOn(getWorkspaceRoot());
    excludesDirty.value = false;
    void refreshExcludes();
  });

  // spec §8：开启时探测各语言的 server，失败分流 toast（server_not_found /
  // handshake_failed / untrusted）。dedupKey 带工作区+语言+kind，重复同因合并。
  async function probeServersAndToast() {
    const workspaceRoot = getWorkspaceRoot();
    let langs: string[];
    try { langs = await api.lspDetectLanguages(workspaceRoot); }
    catch { return; } // 探测失败不阻断；下次 did_open 仍会兜底
    for (const lang of langs) {
      let outcome: { ok: boolean; kind?: string };
      try { outcome = await api.lspEnsureServer(workspaceRoot, lang); }
      catch { continue; } // invoke 报错（spawn failed 等）由后端日志兜底
      if (outcome.ok) continue;
      const kind = outcome.kind ?? "unknown";
      const { push } = useNotifications();
      if (kind === "server_not_found") {
        push({
          severity: "warning", source: "lsp",
          title: `${lang} LSP server not found`,
          body: `Install the ${lang} LSP server (e.g. rust-analyzer / gopls / typescript-language-server) or set its path in settings.`,
          timestamp: Date.now(),
          dedupKey: `lsp:ensure:${workspaceRoot}:${lang}:${kind}`,
        });
      } else if (kind === "handshake_failed") {
        push({
          severity: "error", source: "lsp",
          title: `${lang} LSP handshake failed`,
          body: `Server was found but initialization failed. Check the ${lang} LSP server version / path in settings.`,
          timestamp: Date.now(),
          dedupKey: `lsp:ensure:${workspaceRoot}:${lang}:${kind}`,
        });
      } else if (kind === "untrusted") {
        push({
          severity: "warning", source: "lsp",
          title: `${lang} LSP disabled`,
          body: `Workspace is not trusted. Trust it first to enable LSP.`,
          timestamp: Date.now(),
          dedupKey: `lsp:ensure:${workspaceRoot}:${lang}:${kind}`,
        });
      }
    }
  }

  async function setEnabled(v: boolean) {
    const workspaceRoot = getWorkspaceRoot();
    enabled.value = v;
    if (v) {
      await enableLsp(workspaceRoot);
      void probeServersAndToast(); // best-effort：不阻塞 toggle UI
    } else {
      await disableLsp(workspaceRoot);
    }
  }

  async function saveExcludes(dirs: string[]) {
    const workspaceRoot = getWorkspaceRoot();
    await api.workspaceSetLspExcludes(workspaceRoot, dirs);
    excludes.value = dirs;
    excludesDirty.value = false;
    // 改排除集需重拉 server：disable→enable 完成（spec §5.4）
    if (enabled.value) {
      await disableLsp(workspaceRoot);
      await enableLsp(workspaceRoot);
    }
  }

  return { enabled, excludes, excludesDirty, setEnabled, saveExcludes, refreshExcludes };
}
