export interface PluginEntry {
  name: string;
  displayName: string;
  description: string;
  /** 语义版本（marketplace.json version 字段），仅显示用；sha-pinned 插件为空。 */
  version: string;
  /** 安装身份（version 或 short_sha），仅用于 hasUpdate 比对，不展示给用户。 */
  versionId: string;
  sourceId: string;
  marketName: string;
  category: string;
  homepage: string;
  repository: string;
  availability: "available" | "mixed" | "unavailable" | "unknown";
  unsupported: string[];
  /** Aide 内置清单提供的图标（data:image/png;base64 URL）；无图标 → undefined，前端回退首字母占位。 */
  icon?: string;
  /** Aide 精选推荐标记（内置清单驱动）。 */
  isFeatured: boolean;
}

export interface InstalledPlugin {
  name: string;
  market: string;
  /** 语义版本（plugin.json 的 version，如 "6.2.0"），仅用于显示；sha-pinned 插件无此值时为空。 */
  version: string;
  /** 安装身份 = 版本目录名（sha），仅用于 hasUpdate 比对，不展示给用户。 */
  versionId: string;
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
