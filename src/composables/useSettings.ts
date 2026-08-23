import { reactive, ref, watch } from "vue";
import { api } from "../api";
import { MONO_FONT_STACK, UI_FONT_STACK, resolveFontFamily, resolveScopedFontFamily } from "../utils/fonts";
import type { AppSettings, CodeGraphEmbedderConfig, JdkEntry, SecretMutation } from "../types";

const defaults: AppSettings = {
  fontSize: 14,
  fontFamily: MONO_FONT_STACK,
  editorFontFamily: MONO_FONT_STACK,
  terminalFontFamily: MONO_FONT_STACK,
  notificationsEnabled: true,
  autoNaming: true,
  thinkingEnabled: true,
  proxy: "",
  shellPath: "",
  workbenchHeight: 0,
  keybindings: {
    searchOpen: "Ctrl+P",
    paneSplitRight: "Ctrl+\\",
    paneSplitDown: "Ctrl+Shift+\\",
    paneCloseTab: "Ctrl+W",
  },
  theme: "glass",
  openWithExtensions: [],
  recentLimit: 10,
  paneLayouts: {},
  codegraphEmbedder: {
    backend: "fastembed",
    baseUrl: "",
    apiKeyConfigured: false,
    model: "nomic-embed-text",
    format: "ollama",
    dim: 0,
  },
  jdkRegistry: [],
  jdkPromptDismissed: [],
  leftSidebarPinned: true,
  onboarded: false,
  editor: { indentSize: 4, vimMode: false, vimKeybindings: { normal: [], insert: [], visual: [] } },
  remote: {
    enabled: false,
    relayUrl: "",
    deviceId: "",
    permissionMode: "auto",
  },
};

// Module-level reactive singleton — shared across ChatPanel and SettingsPanel
const settings = reactive<AppSettings>({ ...defaults });
const loaded = ref(false);

// Keep --aide-font-mono CSS variable in sync with user's configured fontFamily.
// Runs immediately so CodeMirror / xterm / hardcoded var() references always see the
// correct value even before load() completes.
watch(
  () => settings.fontFamily,
  (v) => {
    document.documentElement.style.setProperty("--aide-font-mono", v);
    // UI 正文（按钮/标签/面板）跟随界面字体，但默认栈（用户未设置）时保持
    // Inter 现状——只有用户显式选了字体后 UI 正文才跟随。
    document.documentElement.style.setProperty(
      "--aide-font-ui",
      v === MONO_FONT_STACK ? UI_FONT_STACK : v,
    );
  },
  { immediate: true }
);

export function useSettings() {
  async function load(): Promise<void> {
    try {
      const s = await api.getSettings();
      settings.fontSize = s.fontSize ?? defaults.fontSize;
      settings.fontFamily = resolveFontFamily(s.fontFamily);
      // Persist the upgrade so Rust default never kicks in on subsequent loads
      if (settings.fontFamily !== (s.fontFamily ?? "")) {
        update({ fontFamily: settings.fontFamily });
      }
      // 编辑器/终端字体：新字段未设置（空）→ 回退界面字体，老用户设置自动继承
      settings.editorFontFamily = resolveScopedFontFamily(s.editorFontFamily, settings.fontFamily);
      settings.terminalFontFamily = resolveScopedFontFamily(s.terminalFontFamily, settings.fontFamily);
      settings.notificationsEnabled = s.notificationsEnabled ?? defaults.notificationsEnabled;
      settings.autoNaming = s.autoNaming ?? defaults.autoNaming;
      settings.thinkingEnabled = s.thinkingEnabled ?? defaults.thinkingEnabled;
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
      settings.leftSidebarPinned = s.leftSidebarPinned ?? defaults.leftSidebarPinned;
      settings.onboarded = s.onboarded ?? defaults.onboarded;
      // 旧配置缺 editor → 整块补默认（默认 4 空格缩进）；vimKeybindings 嵌套逐层补空
      // （s.editor 只有 indentSize 时整体 ?? 会丢三模式结构）
      settings.editor = {
        ...defaults.editor,
        ...(s.editor ?? {}),
        vimKeybindings: {
          normal: s.editor?.vimKeybindings?.normal ?? [],
          insert: s.editor?.vimKeybindings?.insert ?? [],
          visual: s.editor?.vimKeybindings?.visual ?? [],
        },
      };
      // 旧配置缺 remote → 整块补默认（远程控制默认关）
      settings.remote = { ...defaults.remote, ...(s.remote ?? {}) };
    } catch (_) {
      // Keep defaults on error
    }
    loaded.value = true;
  }

  async function update(partial: Partial<AppSettings>): Promise<void> {
    // Immediate reactive update
    if (partial.fontSize !== undefined) settings.fontSize = partial.fontSize;
    if (partial.fontFamily !== undefined) settings.fontFamily = partial.fontFamily;
    if (partial.editorFontFamily !== undefined) settings.editorFontFamily = partial.editorFontFamily;
    if (partial.terminalFontFamily !== undefined) settings.terminalFontFamily = partial.terminalFontFamily;
    if (partial.notificationsEnabled !== undefined) settings.notificationsEnabled = partial.notificationsEnabled;
    if (partial.autoNaming !== undefined) settings.autoNaming = partial.autoNaming;
    if (partial.thinkingEnabled !== undefined) settings.thinkingEnabled = partial.thinkingEnabled;
    if (partial.proxy !== undefined) settings.proxy = partial.proxy;
    if (partial.shellPath !== undefined) settings.shellPath = partial.shellPath;
    if (partial.workbenchHeight !== undefined) settings.workbenchHeight = partial.workbenchHeight;
    if (partial.keybindings !== undefined) settings.keybindings = { ...settings.keybindings, ...partial.keybindings };
    if (partial.theme !== undefined) settings.theme = partial.theme;
    if (partial.recentLimit !== undefined) settings.recentLimit = partial.recentLimit;
    if (partial.paneLayouts !== undefined) settings.paneLayouts = partial.paneLayouts;
    if (partial.codegraphEmbedder !== undefined) settings.codegraphEmbedder = partial.codegraphEmbedder;
    if (partial.leftSidebarPinned !== undefined) settings.leftSidebarPinned = partial.leftSidebarPinned;
    if (partial.onboarded !== undefined) settings.onboarded = partial.onboarded;
    // editor 整块替换：后端 set_settings 按 top-level key 整体覆盖，故前端发完整对象
    if (partial.editor !== undefined) settings.editor = { ...settings.editor, ...partial.editor };
    if (partial.remote !== undefined) settings.remote = { ...settings.remote, ...partial.remote };
    // Persist asynchronously
    try {
      await api.setSettings(partial);
    } catch (_) { /* best effort */ }
  }

  // 专门路径：codegraphEmbedder 整块更新（backend 下拉切 http/fastembed 时
  // 一次性写回整块，避免逐字段 partial 多次落盘）。下次 build 读新配置，
  // model_name/dim 变 → meta 不匹配 → 自动全量重建，无需额外 reinit 命令。
  async function setCodegraphEmbedder(
    cfg: CodeGraphEmbedderConfig,
    apiKey: SecretMutation = { action: "unchanged" },
  ): Promise<void> {
    await api.setSettings({
      codegraphEmbedder: { ...cfg, apiKey },
    });
    settings.codegraphEmbedder = {
      ...cfg,
      apiKeyConfigured: apiKey.action === "clear" ? false : cfg.apiKeyConfigured || apiKey.action === "set",
    };
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
