import { api } from "../api";
import { useFileViewer } from "./useFileViewer";
import type { Session, FileEntry } from "../types";

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
          icon: "📝",
          action: () => onSelect(s.id),
        }));
      } catch {
        return [];
      }
    },
  };
}

// ── Built-in: File search provider ──

let fileCache: { files: FileEntry[]; timestamp: number } | null = null;
const FILE_CACHE_TTL = 30000; // 30 seconds
const MAX_FILES = 500; // stop recursing after hitting this limit

/**
 * Recursively walk directory tree to collect all files.
 * Stops at MAX_FILES to avoid excessive I/O for huge projects.
 */
async function walkFiles(dirPath: string, count: { n: number }): Promise<FileEntry[]> {
  if (count.n >= MAX_FILES) return [];
  try {
    const entries = await api.listDirectory(dirPath);
    const files: FileEntry[] = [];
    for (const entry of entries) {
      if (count.n >= MAX_FILES) break;
      if (entry.is_dir) {
        const children = await walkFiles(entry.path, count);
        files.push(...children);
      } else {
        count.n++;
        files.push(entry);
      }
    }
    return files;
  } catch {
    return [];
  }
}

async function getWorkspaceFiles(workspacePath: string): Promise<FileEntry[]> {
  if (fileCache && Date.now() - fileCache.timestamp < FILE_CACHE_TTL) {
    return fileCache.files;
  }
  try {
    const files = await walkFiles(workspacePath, { n: 0 });
    fileCache = { files, timestamp: Date.now() };
    return files;
  } catch {
    return [];
  }
}

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
      try {
        const files = await getWorkspaceFiles(wsPath);
        // Score: exact filename match > path contains > filename contains
        const scored = files
          .map(f => {
            const name = f.name.toLowerCase();
            const path = f.path.toLowerCase();
            let score = 0;
            if (name === query) score = 3;
            else if (name.startsWith(query)) score = 2;
            else if (name.includes(query)) score = 1;
            else if (path.includes(query)) score = 0.5;
            return { file: f, score };
          })
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

        return scored.map(x => ({
          id: x.file.path,
          label: x.file.name,
          description: x.file.path,
          icon: "📄",
          action: () => {
            const viewer = useFileViewer();
            viewer.open(x.file.path);
          },
        }));
      } catch {
        return [];
      }
    },
  };
}

/**
 * Invalidate the file cache (call when workspace changes or files are modified).
 */
function invalidateFileCache() {
  fileCache = null;
}

/**
 * Initialize the search provider registry with the built-in session and file providers.
 * Call once from App.vue during mount, passing callback functions so the providers
 * can interact with the rest of the app without direct component dependencies.
 */
function initProviders(
  getSessionList: () => Promise<Session[]>,
  onSessionSelect: (sessionId: string) => void,
  getWorkspacePath: () => string,
) {
  register(createSessionProvider(getSessionList, onSessionSelect));
  register(createFileProvider(getWorkspacePath));
}

export function useSearchProviders() {
  return { register, unregister, search, initProviders, invalidateFileCache };
}
