export interface SearchResult {
  id: string;
  label: string;
  description?: string;
  /** Full context revealed through the theme-aware command-palette tooltip. */
  tooltip?: string;
  icon?: string;
  /** Called when user selects this result. */
  action: () => void;
}

export interface SearchProvider {
  id: string;
  label: string; // group label shown in dropdown, e.g. "会话" / "文件"
  priority: number; // lower = shown first
  search(query: string, limit: number): Promise<SearchResult[]>;
}
