import { ref } from "vue";
import { lspPacksApi } from "@aide/sdk/api/lspPacks";
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
let inflight: Promise<void> | null = null;

function replace(next: LanguagePack): void {
  packs.value = packs.value.some((p) => p.id === next.id)
    ? packs.value.map((p) => (p.id === next.id ? next : p))
    : [...packs.value, next];
}

function refresh(): Promise<void> {
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
  inflight = null;
}
