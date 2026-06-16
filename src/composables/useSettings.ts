import { reactive, ref } from "vue";
import { api } from "../api";
import type { AppSettings } from "../types";

const defaults: AppSettings = {
  fontSize: 14,
  fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  notificationsEnabled: true,
};

// Module-level reactive singleton — shared across TerminalPanel and SettingsModal
const settings = reactive<AppSettings>({ ...defaults });
const loaded = ref(false);

export function useSettings() {
  async function load(): Promise<void> {
    try {
      const s = await api.getSettings();
      settings.fontSize = s.fontSize ?? defaults.fontSize;
      settings.fontFamily = s.fontFamily ?? defaults.fontFamily;
      settings.notificationsEnabled = s.notificationsEnabled ?? defaults.notificationsEnabled;
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
    // Persist asynchronously
    try {
      await api.setSettings(partial);
    } catch (_) { /* best effort */ }
  }

  return { settings, loaded, load, update };
}
