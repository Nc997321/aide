import { reactive, ref } from "vue";
import { api } from "../api";
import type { AppSettings, CodeGraphEmbedderConfig } from "../types";

const defaults: AppSettings = {
  fontSize: 14,
  fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
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
};

// Module-level reactive singleton — shared across ChatPanel and SettingsPanel
const settings = reactive<AppSettings>({ ...defaults });
const loaded = ref(false);

export function useSettings() {
  async function load(): Promise<void> {
    try {
      const s = await api.getSettings();
      settings.fontSize = s.fontSize ?? defaults.fontSize;
      settings.fontFamily = s.fontFamily ?? defaults.fontFamily;
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

  // 专门路径：openWithExtensions 需同步 HKCU 注册表，走 set_open_with_extensions
  // 而非通用 set_settings，保证设置与「打开方式」注册原子一致。失败抛出供调用方回滚。
  async function setOpenWithExtensions(exts: string[]): Promise<void> {
    await api.setOpenWithExtensions(exts);
    settings.openWithExtensions = exts;
  }

  return { settings, loaded, load, update, setOpenWithExtensions, setCodegraphEmbedder };
}
