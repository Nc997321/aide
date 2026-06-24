import { reactive, ref } from "vue";
import { api } from "../api";
import type { AppSettings } from "../types";

const defaults: AppSettings = {
  fontSize: 14,
  fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  notificationsEnabled: true,
  proxy: "",
  shellPath: "",
  workbenchHeight: 0,
  keybindings: {
    searchOpen: "Ctrl+P",
  },
  theme: "warm-dark",
};

// Module-level reactive singleton — shared across TerminalPanel and SettingsPanel
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
      settings.keybindings = s.keybindings ?? defaults.keybindings;
      settings.theme = s.theme ?? defaults.theme;
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
    // Persist asynchronously
    try {
      await api.setSettings(partial);
    } catch (_) { /* best effort */ }
  }

  return { settings, loaded, load, update };
}
