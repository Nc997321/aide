import { invoke } from "@tauri-apps/api/core";
import type { PluginEntry, InstalledPlugin, SourceInfo } from "../types/marketplace";

export const marketplaceApi = {
  listMarketplaceSources(): Promise<SourceInfo[]> { return invoke("list_marketplace_sources"); },
  setMarketplaceEnabled(sourceId: string, enabled: boolean): Promise<void> {
    return invoke("set_marketplace_enabled", { sourceId, enabled });
  },
  fetchMarketplace(sourceId: string): Promise<PluginEntry[]> { return invoke("fetch_marketplace", { sourceId }); },
  refreshMarketplace(sourceId: string): Promise<void> { return invoke("refresh_marketplace", { sourceId }); },
  installPlugin(sourceId: string, pluginName: string): Promise<void> {
    return invoke("install_plugin", { sourceId, pluginName });
  },
  uninstallPlugin(marketplace: string, pluginName: string): Promise<void> {
    return invoke("uninstall_plugin", { marketplace, pluginName });
  },
  updatePlugin(sourceId: string, pluginName: string): Promise<void> {
    return invoke("update_plugin", { sourceId, pluginName });
  },
  listInstalledPlugins(): Promise<InstalledPlugin[]> { return invoke("list_installed_plugins"); },
  setPluginEnabled(marketplace: string, plugin: string, enabled: boolean): Promise<void> {
    return invoke("set_plugin_enabled", { marketplace, plugin, enabled });
  },
};
