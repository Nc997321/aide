import { invoke } from "@tauri-apps/api/core";
import type { PluginEntry, InstalledPlugin } from "../types/marketplace";

export const marketplaceApi = {
  fetchMarketplace(url: string): Promise<PluginEntry[]> {
    return invoke("fetch_marketplace", { url });
  },
  installPlugin(repoUrl: string, name: string): Promise<void> {
    return invoke("install_plugin", { repoUrl, name });
  },
  uninstallPlugin(name: string): Promise<void> {
    return invoke("uninstall_plugin", { name });
  },
  listInstalledPlugins(): Promise<InstalledPlugin[]> {
    return invoke("list_installed_plugins");
  },
};
