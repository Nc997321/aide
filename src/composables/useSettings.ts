import { reactive, ref } from "vue";
import { api } from "../api";
import { MONO_FONT_STACK, resolveFontFamily } from "../utils/fonts";
import type { AppSettings, CodeGraphEmbedderConfig, JdkEntry } from "../types";

const defaults: AppSettings = {
  fontSize: 14,
  fontFamily: MONO_FONT_STACK,
  notificationsEnabled: true,
  proxy: "",
  shellPath: "",
  workbenchHeight: 0,
  keybindings: {
    searchOpen: "Ctrl+P",
    paneSplitRight: "Ctrl+\\",
    paneSplitDown: "Ctrl+Shift+\\",
    paneCloseTab: "Ctrl+W",
  },
  theme: "warm-dark",
  openWithExtensions: [],
  recentLimit: 10,
  paneLayouts: {},
  codegraphEmbedder: {
    backend: "fastembed",
    baseUrl: "",
    apiKey: "",
    model: "nomic-embed-text",
    format: "ollama",
    dim: 0,
  },
  jdkRegistry: [],
  jdkPromptDismissed: [],
};

// Module-level reactive singleton — shared across ChatPanel and SettingsPanel
const settings = reactive<AppSettings>({ ...defaults });
const loaded = ref(false);

export function useSettings() {
  async function load(): Promise<void> {
    try {
      const s = await api.getSettings();
      settings.fontSize = s.fontSize ?? defaults.fontSize;
      settings.fontFamily = resolveFontFamily(s.fontFamily);
      settings.notificationsEnabled = s.notificationsEnabled ?? defaults.notificationsEnabled;
      settings.proxy = s.proxy ?? defaults.proxy;
      settings.shellPath = s.shellPath ?? defaults.shellPath;
      settings.workbenchHeight = s.workbenchHeight ?? defaults.workbenchHeight;
      // 旧配置缺新键位时逐字段补默认值（整体 ?? 会让老用户拿不到新增快捷键）
      settings.keybindings = { ...defaults.keybindings, ...(s.keybindings ?? {}) };
      settings.theme = s.theme ?? defaults.theme;
      settings.openWithExtensions = s.openWithExtensions ?? defaults.openWithExtensions;
      settings.recentLimit = s.recentLimit ?? defaults.recentLimit;
      settings.paneLayouts =
        s.paneLayouts && typeof s.paneLayouts === "object" ? s.paneLayouts : {};
      // 旧配置缺 codegraphEmbedder → 整块补默认（后端默认 fastembed）
      settings.codegraphEmbedder = {
        ...defaults.codegraphEmbedder,
        ...(s.codegraphEmbedder ?? {}),
      };
      settings.jdkRegistry = s.jdkRegistry ?? defaults.jdkRegistry;
      settings.jdkPromptDismissed = s.jdkPromptDismissed ?? defaults.jdkPromptDismissed;
    } catch (_) {
      // Keep defaults on error
    }
    loaded.value = true;
  }

  async function update(partial: Partial<AppSettings>): Promise<void> {
    // Immediate reactive update
    if (partial.fontSize !== undefined) settings.fontSize = partial.fontSize;
    if (partial.fontFamily !== undefined) settings.fontFamily = partial.fontFamily;
    if (partial.notificationsEnabled !== undefined) settings.notificationsEnabled = partial.notificationsEnabled;
    if (partial.proxy !== undefined) settings.proxy = partial.proxy;
    if (partial.shellPath !== undefined) settings.shellPath = partial.shellPath;
    if (partial.workbenchHeight !== undefined) settings.workbenchHeight = partial.workbenchHeight;
    if (partial.keybindings !== undefined) settings.keybindings = { ...settings.keybindings, ...partial.keybindings };
    if (partial.theme !== undefined) settings.theme = partial.theme;
    if (partial.recentLimit !== undefined) settings.recentLimit = partial.recentLimit;
    if (partial.paneLayouts !== undefined) settings.paneLayouts = partial.paneLayouts;
    if (partial.codegraphEmbedder !== undefined) settings.codegraphEmbedder = partial.codegraphEmbedder;
    // Persist asynchronously
    try {
      await api.setSettings(partial);
    } catch (_) { /* best effort */ }
  }

  // 专门路径：codegraphEmbedder 整块更新（backend 下拉切 http/fastembed 时
  // 一次性写回整块，避免逐字段 partial 多次落盘）。下次 build 读新配置，
  // model_name/dim 变 → meta 不匹配 → 自动全量重建，无需额外 reinit 命令。
  async function setCodegraphEmbedder(cfg: CodeGraphEmbedderConfig): Promise<void> {
    settings.codegraphEmbedder = cfg;
    try {
      await api.setSettings({ codegraphEmbedder: cfg });
    } catch (_) { /* best effort */ }
  }

  // 专门路径：jdkRegistry 整块更新（扫描/添加/删除时一次性写回整块，避免
  // 逐条 partial 多次落盘）。机器级资源，运行配置编辑器据此列出可选 JDK。
  async function setJdkRegistry(entries: JdkEntry[]): Promise<void> {
    settings.jdkRegistry = entries;
    try {
      await api.setSettings({ jdkRegistry: entries });
    } catch (_) { /* best effort */ }
  }

  // 「检测到 Java 项目」提示的「稍后」关闭：把工作区键加入落盘的 dismissal 列表。
  // 存 config.json 而非 localStorage——重启 / WebView2 清缓存都不丢。整块写回，
  // 避免并发 append 互相覆盖（与 setJdkRegistry 同模式）。
  async function dismissJdkPrompt(wsKey: string): Promise<void> {
    const list = settings.jdkPromptDismissed ?? [];
    if (list.includes(wsKey)) return;
    const next = [...list, wsKey];
    settings.jdkPromptDismissed = next;
    try {
      await api.setSettings({ jdkPromptDismissed: next });
    } catch (_) { /* best effort */ }
  }

  // 专门路径：openWithExtensions 需同步 HKCU 注册表，走 set_open_with_extensions
  // 而非通用 set_settings，保证设置与「打开方式」注册原子一致。失败抛出供调用方回滚。
  async function setOpenWithExtensions(exts: string[]): Promise<void> {
    await api.setOpenWithExtensions(exts);
    settings.openWithExtensions = exts;
  }

  return { settings, loaded, load, update, setOpenWithExtensions, setCodegraphEmbedder, setJdkRegistry, dismissJdkPrompt };
}
