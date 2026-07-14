import { api } from "../api";
import { useFileViewer } from "./useFileViewer";
import type { Session } from "../types";

// ── Search provider interface ──

export interface SearchResult {
  id: string;
  label: string;
  description?: string;
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

// ── Provider registry ──

const providers: SearchProvider[] = [];

function register(provider: SearchProvider) {
  // Replace if already registered, otherwise push
  const idx = providers.findIndex(p => p.id === provider.id);
  if (idx >= 0) {
    providers[idx] = provider;
  } else {
    providers.push(provider);
  }
}

function unregister(id: string) {
  const idx = providers.findIndex(p => p.id === id);
  if (idx >= 0) providers.splice(idx, 1);
}

/**
 * Run all registered providers in parallel and merge results,
 * sorted by provider priority then by match quality.
 */
async function search(query: string, limit = 10): Promise<SearchResult[]> {
  if (!query.trim()) return [];
  const q = query.trim().toLowerCase();

  const resultsPerProvider = await Promise.all(
    providers
      .sort((a, b) => a.priority - b.priority)
      .map(p =>
        p.search(q, limit).catch(() => [] as SearchResult[]),
      ),
  );

  return resultsPerProvider.flat();
}

// ── Built-in: Session search provider ──

function createSessionProvider(
  getSessionList: () => Promise<Session[]>,
  onSelect: (sessionId: string) => void,
): SearchProvider {
  return {
    id: "sessions",
    label: "会话",
    priority: 0,
    async search(query, limit) {
      try {
        const sessions = await getSessionList();
        const filtered = sessions
          .filter(
            s =>
              s.name.toLowerCase().includes(query) ||
              s.last_message.toLowerCase().includes(query),
          )
          .slice(0, limit);
        return filtered.map(s => ({
          id: s.id,
          label: s.name,
          description: s.last_message || undefined,
          icon: "session",
          action: () => onSelect(s.id),
        }));
      } catch {
        return [];
      }
    },
  };
}

// ── Built-in: File search provider ──
//
// 文件检索走服务端 `find_files_by_name`（Rust，spawn_blocking + ignore crate）：
//  - 尊重 .gitignore / .git/info/exclude / 全局 gitignore，target/、.idea/、*.iml、
//    *.class、log/ 等被 ignore 的垃圾天然不进结果；
//  - 遍历整棵树（max_depth=20），cap 只限"匹配数"，不会因目录靠后而漏文件——
//    旧实现客户端 walkFiles 把"已访问文件数"卡在 500，大项目深层文件全搜不到；
//  - ignore crate 是 ripgrep 同款，3k 文件遍历几十毫秒且不卡主线程；
//  - palette 已 150ms 防抖，按查询实时检索无需客户端缓存，无脏数据。
// 复用 useFileResolver 同一条检索路径（单一事实源）。

function createFileProvider(
  getWorkspacePath: () => string,
): SearchProvider {
  return {
    id: "files",
    label: "文件",
    priority: 1,
    async search(query, limit) {
      const wsPath = getWorkspacePath();
      if (!wsPath) return [];
      // 多取一些候选再截到 limit，保证排序头部质量（服务端已按 exact_suffix > exact > partial 排好）。
      const fetchLimit = Math.max(limit, 50);
      let paths: string[];
      try {
        paths = await api.findFilesByName(query, wsPath, fetchLimit);
      } catch {
        return [];
      }
      return paths.slice(0, limit).map(p => {
        const name = p.replace(/\\/g, "/").split("/").pop() || p;
        return {
          id: p,
          label: name,
          description: p,
          icon: "file",
          action: () => {
            const viewer = useFileViewer();
            viewer.open(p);
          },
        };
      });
    },
  };
}

// ── Built-in: CodeGraph symbol search provider ──

function createCodegraphProvider(
  getWorkspacePath: () => string,
): SearchProvider {
  return {
    id: "codegraph",
    label: "代码定义",
    priority: 5, // after sessions (0) and files (1)
    async search(query, limit) {
      if (!query.trim() || query.trim().length < 2) return [];
      const projectRoot = getWorkspacePath();
      if (!projectRoot) return [];
      try {
        const results = await api.codegraphGotoDefinition(
          query, "", 0, 0, projectRoot,
        );
        return results.slice(0, limit).map((r) => ({
          id: `${r.symbol.file}:${r.symbol.line}:${r.symbol.name}`,
          label: r.symbol.name,
          description: `${r.confidence === "Structure" ? "精确" : "相似"} · ${r.symbol.file}:${r.symbol.line}`,
          icon: r.confidence === "Structure" ? "link" : "search",
          action() {
            const separator = projectRoot.includes("\\") ? "\\" : "/";
            const fullPath = projectRoot + separator + r.symbol.file.replace(/\//g, separator);
            useFileViewer().openAndScrollTo(fullPath, r.symbol.line);
          },
        }));
      } catch {
        return [];
      }
    },
  };
}

/**
 * Initialize the search provider registry with the built-in session, file,
 * and codegraph providers. Call once from App.vue during mount, passing
 * callback functions so the providers can interact with the rest of the app
 * without direct component dependencies.
 */
function initProviders(
  getSessionList: () => Promise<Session[]>,
  onSessionSelect: (sessionId: string) => void,
  getWorkspacePath: () => string,
) {
  register(createSessionProvider(getSessionList, onSessionSelect));
  register(createFileProvider(getWorkspacePath));
  register(createCodegraphProvider(getWorkspacePath));
}

function getProviders(): SearchProvider[] {
  return [...providers].sort((a, b) => a.priority - b.priority);
}

export function useSearchProviders() {
  return { register, unregister, search, getProviders, initProviders };
}
