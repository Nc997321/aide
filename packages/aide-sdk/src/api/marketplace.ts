import { getTransport } from "../transport";
import type { PluginEntry, InstalledPlugin, SourceInfo } from "../types/marketplace";

export const marketplaceApi = {
  listMarketplaceSources(): Promise<SourceInfo[]> { return getTransport().invoke("list_marketplace_sources"); },
  setMarketplaceEnabled(sourceId: string, enabled: boolean): Promise<void> {
    return getTransport().invoke("set_marketplace_enabled", { sourceId, enabled });
  },
  fetchMarketplace(sourceId: string): Promise<PluginEntry[]> { return getTransport().invoke("fetch_marketplace", { sourceId }); },
  refreshMarketplace(sourceId: string): Promise<void> { return getTransport().invoke("refresh_marketplace", { sourceId }); },
  installPlugin(sourceId: string, pluginName: string): Promise<void> {
    return getTransport().invoke("install_plugin", { sourceId, pluginName });
  },
  uninstallPlugin(marketplace: string, pluginName: string): Promise<void> {
    return getTransport().invoke("uninstall_plugin", { marketplace, pluginName });
  },
  updatePlugin(sourceId: string, pluginName: string): Promise<void> {
    return getTransport().invoke("update_plugin", { sourceId, pluginName });
  },
  listInstalledPlugins(): Promise<InstalledPlugin[]> { return getTransport().invoke("list_installed_plugins"); },
  setPluginEnabled(marketplace: string, plugin: string, enabled: boolean): Promise<void> {
    return getTransport().invoke("set_plugin_enabled", { marketplace, plugin, enabled });
  },
};
