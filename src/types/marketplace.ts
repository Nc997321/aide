export interface PluginEntry {
  name: string;
  description: string;
  repo: string;
  homepage: string;
}

export interface InstalledPlugin {
  name: string;
  title: string;
  description: string;
  author: string;
  repo_url: string;
  path: string;
  installed_at: number;
}
