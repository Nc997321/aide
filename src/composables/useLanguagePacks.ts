import { ref } from "vue";
import { lspPacksApi } from "@aide/sdk/api/lspPacks";
import { listen } from "@/api";
import type { LanguagePack } from "@aide/sdk/types/lspPacks";

/**
 * 语言包状态（插件市场「语言服务器」分类 + 标题栏「语言环境」面板共用一份）。
 *
 * 模块级单例：一个窗口 = 一个 Host，两处入口看的是同一台机器上的同一批语言包——在市场里点了
 * 安装，面板那一行立刻显示「安装中」，装好后面板据 `revision` 重新探测、切成就绪。
 * 窗口换绑 Host 后数据会过期：两处入口每次打开都调 `refresh()`。
 */
const packs = ref<LanguagePack[]>([]);
const busy = ref<Record<string, "install" | "uninstall">>({});
const errors = ref<Record<string, string>>({});
/** 每次装 / 卸成功 +1。「语言环境」面板 watch 它重探 server 状态。 */
const revision = ref(0);
/** 下载进度（Host 广播 `lsp-pack-progress`，大文件语言包如 Java 才有）。别的窗口点的安装也看得到。 */
const progress = ref<Record<string, { received: number; total: number | null }>>({});
let progressListening = false;
function ensureProgressListening(): void {
  if (progressListening) return;
  progressListening = true;
  void listen<{ id: string; received: number; total: number | null }>("lsp-pack-progress", (ev) => {
    const p = ev.payload;
    progress.value = { ...progress.value, [p.id]: { received: p.received, total: p.total } };
  }).catch(() => {
    progressListening = false;
  });
}

/** 「安装中…」后面的进度：`37%（19 / 51 MB）`；没有进度事件（npm 小包）返回空串。 */
function progressText(id: string): string {
  const p = progress.value[id];
  if (!p) return "";
  const mb = (n: number) => (n / 1048576).toFixed(0);
  if (!p.total) return ` ${mb(p.received)} MB`;
  return ` ${Math.floor((p.received * 100) / p.total)}%（${mb(p.received)} / ${mb(p.total)} MB）`;
}
let inflight: Promise<void> | null = null;

function replace(next: LanguagePack): void {
  packs.value = packs.value.some((p) => p.id === next.id)
    ? packs.value.map((p) => (p.id === next.id ? next : p))
    : [...packs.value, next];
}

function refresh(): Promise<void> {
  ensureProgressListening();
  inflight ??= lspPacksApi
    .list()
    .then((list) => {
      packs.value = list;
    })
    .catch(() => {
      /* 旧 Host 没有这条命令：静默，入口自然不显示语言包 */
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function run(id: string, kind: "install" | "uninstall"): Promise<boolean> {
  if (busy.value[id]) return false;
  ensureProgressListening();
  busy.value = { ...busy.value, [id]: kind };
  const { [id]: _, ...rest } = errors.value;
  errors.value = rest;
  try {
    replace(kind === "install" ? await lspPacksApi.install(id) : await lspPacksApi.uninstall(id));
    revision.value++;
    return true;
  } catch (e) {
    errors.value = { ...errors.value, [id]: String(e) };
    return false;
  } finally {
    const { [id]: __, ...left } = busy.value;
    busy.value = left;
    const { [id]: ___, ...rest2 } = progress.value;
    progress.value = rest2;
  }
}

/** 服务该语言的语言包（「语言环境」面板的语言键，如 typescript / javascript / python / rust）。 */
function packForLang(lang: string): LanguagePack | undefined {
  return packs.value.find((p) => p.langs.includes(lang));
}

export function useLanguagePacks() {
  return {
    packs,
    busy,
    errors,
    revision,
    progressText,
    refresh,
    install: (id: string) => run(id, "install"),
    uninstall: (id: string) => run(id, "uninstall"),
    packForLang,
  };
}

export function __resetLanguagePacksForTest(): void {
  packs.value = [];
  busy.value = {};
  errors.value = {};
  revision.value = 0;
  progress.value = {};
  inflight = null;
}
