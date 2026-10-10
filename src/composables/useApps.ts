import { computed, reactive, ref } from "vue";
import { listen } from "@aide/sdk";
import { APPS_CHANGED_EVENT, appsApi } from "@aide/sdk/api/apps";
import type { AppInfo } from "@aide/sdk/types/apps";

/**
 * 侧栏应用的状态（右栏 rail、左侧栏导航组、应用面板共用一份）。
 *
 * 模块级单例：一个窗口 = 一个 Host，看到的就是那台 Host 上的应用。**只认 Host 的回答**：
 * 同意、启停之后不本地改状态，等 `apps-changed` 再 `refresh()`。
 *
 * 开发态应用（工作区 `.aide/apps`）的文件是 agent 在改，Host 不发事件，所以有它们在时
 * 每隔几秒重新列一次，靠 `revision` 变化让面板重载——这就是「热加载」。
 */
const apps = ref<AppInfo[]>([]);
/** 应用经桥设的角标（`aide.ui.setBadge`）。 */
const badges = reactive<Record<string, number>>({});
/** 占着主区的那个应用（placement: main）；一次只开一个。 */
const mainOpenId = ref<string | null>(null);
let inflight: Promise<void> | null = null;
/** 拉取途中又来了一次「有变化」：这一趟拿到的可能已经是旧的，结束后再拉一趟。 */
let stale = false;
let started = false;


/** 应用自带的图标。`mask` = 单色 SVG，按主题色着色（和内置图标一个样）；`image` = 位图，原样显示。 */
export interface AppIcon {
  url: string;
  kind: "mask" | "image";
}
const icons = reactive<Record<string, AppIcon>>({});
/** 已经取过的那一份（`图标路径@revision`）：文件没变就不重取。 */
const iconStamps = new Map<string, string>();
const ICON_TYPES: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
const MAX_ICON_BYTES = 256 * 1024;

function dropIcon(id: string): void {
  const old = icons[id];
  if (old) URL.revokeObjectURL(old.url);
  delete icons[id];
  iconStamps.delete(id);
}

/** 图标是应用自己的文件（不可信）：只当**图片**用（blob 地址进 `<img>` / CSS mask），里面的脚本不会跑；
 *  绝不把它的内容当 HTML 塞进页面。取不到或格式不认识就退回内置字形。 */
async function loadIcons(list: AppInfo[]): Promise<void> {
  for (const id of Object.keys(icons)) {
    if (!list.some((a) => a.id === id && a.icon)) dropIcon(id);
  }
  for (const app of list) {
    const type = app.icon ? ICON_TYPES[app.icon.split(".").pop()?.toLowerCase() ?? ""] : undefined;
    if (!app.icon || app.error || !type) continue;
    const stamp = `${app.icon}@${app.revision}`;
    if (iconStamps.get(app.id) === stamp) continue;
    iconStamps.set(app.id, stamp);
    try {
      const bytes = await appsApi.asset(app.id, app.icon);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) throw new Error("图标为空或太大");
      const old = icons[app.id];
      icons[app.id] = {
        url: URL.createObjectURL(new Blob([bytes], { type })),
        kind: type === "image/svg+xml" ? "mask" : "image",
      };
      if (old) URL.revokeObjectURL(old.url);
    } catch {
      const old = icons[app.id];
      if (old) URL.revokeObjectURL(old.url);
      delete icons[app.id];
    }
  }
}

function refresh(): Promise<void> {
  if (inflight) stale = true;
  // 包一层：transport 没就绪时 `list()` 是同步抛，也要落进下面的 catch
  inflight ??= Promise.resolve()
    .then(() => appsApi.list())
    .then((list) => {
      apps.value = list;
      void loadIcons(list);
      if (mainOpenId.value && !list.some((a) => a.id === mainOpenId.value && a.placement === "main")) {
        mainOpenId.value = null;
      }
    })
    .catch(() => {
      /* 旧 Host 没有这条命令：静默，入口自然不出现 */
    })
    .finally(() => {
      inflight = null;
      if (stale) {
        stale = false;
        void refresh();
      }
    });
  return inflight;
}

/** 幂等：接上事件与窗口聚焦。App 挂载时调一次。
 *  不轮询：应用目录由 Host 自己盯着，有变化（新应用、文件改动）它会发 `apps-changed`。 */
function start(): void {
  if (started) return;
  started = true;
  void refresh();
  void listen(APPS_CHANGED_EVENT, () => void refresh());
  window.addEventListener("focus", () => void refresh());
}

const rightApps = computed(() => apps.value.filter((a) => a.placement === "right"));
const mainApps = computed(() => apps.value.filter((a) => a.placement === "main"));
const mainOpenApp = computed(() => apps.value.find((a) => a.id === mainOpenId.value) ?? null);
const mainPanelOpen = computed(() => mainOpenApp.value !== null);

function toggleMain(id: string): void {
  mainOpenId.value = mainOpenId.value === id ? null : id;
}

function closeMain(): void {
  mainOpenId.value = null;
}

/** 右栏 tab id ⇄ 应用 id。 */
export const APP_TAB_PREFIX = "app:";
export const appTabId = (id: string) => `${APP_TAB_PREFIX}${id}` as const;
export const appIdOfTab = (tab: string) => (tab.startsWith(APP_TAB_PREFIX) ? tab.slice(APP_TAB_PREFIX.length) : null);

export function useApps() {
  return {
    apps,
    badges,
    icons,
    rightApps,
    mainApps,
    mainOpenId,
    mainOpenApp,
    mainPanelOpen,
    start,
    refresh,
    toggleMain,
    closeMain,
  };
}
