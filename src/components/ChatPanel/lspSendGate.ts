/**
 * 新会话发出首条消息时：这个工作区开不开语言服务器（docs/superpowers/specs/2026-10-14-lsp-switch-readiness-design.md §3）。
 *
 * **只在「新会话点发送」那一刻判定，且不阻塞发送**——不在打开 / 浏览会话时弹（2026-10-15 真机反馈：
 * 常驻卡片点开任何会话都会出现，体验很差）。日常模式不问：日常目录不是工程，没有跳转需求。
 * 要不要问由 Host 判定（`lsp_session_preflight`：未信任 / 已选过 / 没有可用语言 → 不问），
 * 按**会话自持的工作区**，不是窗口活动工作区。
 *
 * 写的是同一个工作区开关（标题栏「语言环境」、其他客户端随 `lsp-switch-changed` 同步）。
 */
import { ref } from "vue";
import { api } from "@/api";
import { useLsp } from "@/composables/useLsp";
import { useLanguagePacks } from "@/composables/useLanguagePacks";
import { useNotifications } from "@/composables/useNotifications";
import { installGuideFor } from "@/lspInstallGuide";
import type { PreflightLang } from "@aide/sdk/types/lspPacks";

const short = (lang: string) => installGuideFor(lang)?.shortName ?? lang;

/**
 * 待回答的询问——**记在工作区上，不记在面板上**。新会话从空白面板到拿到正式 id，面板的会话号、
 * 工作区路径写法都可能变、面板也可能重建；挂在面板上的状态会跟着丢，提示一闪就没（2026-10-15 真机）。
 * 只在用户选了（开启 / 不开启）、点了 ×、或别处已替这个工作区选了时才收起。
 */
export const pendingLspAsk = ref<{ workspaceRoot: string; langs: PreflightLang[] } | null>(null);

/** 该不该问：返回可开的语言；不问返回 null。Host 不支持（旧版）/ 出错一律不问——别挡发送。 */
export async function lspLangsToAsk(workspaceRoot: string): Promise<PreflightLang[] | null> {
  if (!workspaceRoot) return null;
  const r = await api.lspSessionPreflight(workspaceRoot).catch(() => null);
  return r?.kind === "ask" && r.langs.length > 0 ? r.langs : null;
}

/** 输入框上方那条提示的文案。 */
export function lspPromptModel(langs: PreflightLang[]) {
  const needInstall = langs.some((l) => !l.installed && l.packId);
  return {
    langs: langs.map((l) => short(l.lang)).join("、"),
    primaryLabel: needInstall ? "安装并开启" : "开启",
    secondaryLabel: "不开启",
  };
}

/**
 * 落实选择。开启时已装的直接写开关（Host 随即在后台启动并预热，见 workspace_set_lsp_enabled）；
 * 需要先装语言包的在后台装完再开（装包可能几十秒），失败弹通知。
 */
export async function applyLspChoice(workspaceRoot: string, langs: PreflightLang[], enable: boolean): Promise<void> {
  const lsp = useLsp();
  if (!enable) {
    await lsp.disableLsp(workspaceRoot).catch(() => {});
    return;
  }
  const toInstall = langs.filter((l) => !l.installed && l.packId);
  if (toInstall.length === 0) {
    await lsp.enableLsp(workspaceRoot).catch(() => {});
    return;
  }
  void (async () => {
    const packs = useLanguagePacks();
    for (const l of toInstall) {
      if (!(await packs.install(l.packId!))) {
        useNotifications().push({
          severity: "warning",
          source: "lsp",
          title: `${short(l.lang)} 语言服务器安装失败`,
          body: packs.errors.value[l.packId!] ?? "未知错误",
          timestamp: Date.now(),
          dedupKey: `lsp:install-failed:${l.packId}`,
        });
      }
    }
    await lsp.enableLsp(workspaceRoot).catch(() => {});
  })();
}
