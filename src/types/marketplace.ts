export interface PluginEntry {
  name: string;
  displayName: string;
  description: string;
  version: string;
  sourceId: string;
  marketName: string;
  category: string;
  homepage: string;
  repository: string;
  availability: "available" | "mixed" | "unavailable" | "unknown";
  unsupported: string[];
}

export interface InstalledPlugin {
  name: string;
  market: string;
  version: string;
  displayName: string;
  description: string;
  author: string;
  path: string;
  installedAt: number;
  enabled: boolean;
}

export interface SourceInfo {
  id: string;
  name: string;
  repo: string;
  enabled: boolean;
}

export interface PluginComponentInfo {
  type: string;
  available: boolean;
}

export interface PluginDetails {
  name: string;
  components: PluginComponentInfo[];
}
