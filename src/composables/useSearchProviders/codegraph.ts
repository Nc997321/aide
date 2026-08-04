import { api } from "../../api";
import type { QueryResult } from "../../types";
import { useFileViewer } from "../useFileViewer";
import type { SearchProvider, SearchResult } from "./types";

interface CodegraphPathDisplay {
  relativePath: string;
  fileName: string;
  topLevelModule?: string;
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function describePath(path: string): CodegraphPathDisplay {
  const relativePath = normalizeRelativePath(path);
  const parts = relativePath.split("/").filter(Boolean);

  return {
    relativePath,
    fileName: parts[parts.length - 1] || relativePath,
    topLevelModule: parts.length > 1 ? parts[0] : undefined,
  };
}

/**
 * A source-location identity, deliberately stricter than a name or a file.
 * It filters duplicate transport/index entries without hiding valid overloads
 * or separate same-name definitions.
 */
export function codegraphResultIdentity(result: QueryResult): string {
  const { symbol } = result;
  return JSON.stringify([
    normalizeRelativePath(symbol.file),
    symbol.line,
    symbol.column,
    symbol.kind,
    symbol.parent,
    symbol.name,
  ]);
}

function confidenceLabel(result: QueryResult): string {
  return result.confidence === "Structure" ? "精确" : "相似";
}

/** 语义命中带相似度分数；结构层精确命中无分数（score=null）。显示为百分比，便于和阈值对照。 */
function scoreTag(result: QueryResult): string {
  return result.score != null ? ` ${(result.score * 100).toFixed(0)}%` : "";
}

function createResult(
  result: QueryResult,
  identity: string,
  projectRoot: string,
): SearchResult {
  const { relativePath, fileName, topLevelModule } = describePath(result.symbol.file);
  const location = `${fileName}:${result.symbol.line}`;
  const moduleHint = topLevelModule ? ` · ${topLevelModule}` : "";

  return {
    id: `codegraph:${identity}`,
    label: result.symbol.name,
    description: `${confidenceLabel(result)}${scoreTag(result)} · ${location}${moduleHint}`,
    tooltip: `${relativePath}:${result.symbol.line}`,
    icon: result.confidence === "Structure" ? "link" : "search",
    action() {
      const separator = projectRoot.includes("\\") ? "\\" : "/";
      const fullPath = projectRoot + separator + relativePath.replace(/\//g, separator);
      useFileViewer().openAndScrollTo(fullPath, result.symbol.line);
    },
  };
}

/**
 * Adapt CodeGraph hits for the command palette. De-duplicate before limiting so
 * a repeated identity cannot consume one of the palette's visible result slots.
 */
export function toCodegraphSearchResults(
  results: QueryResult[],
  limit: number,
  projectRoot: string,
): SearchResult[] {
  const seen = new Set<string>();
  const output: SearchResult[] = [];

  for (const result of results) {
    const identity = codegraphResultIdentity(result);
    if (seen.has(identity)) continue;
    seen.add(identity);

    output.push(createResult(result, identity, projectRoot));
    if (output.length >= limit) break;
  }

  return output;
}

export function createCodegraphProvider(
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
        return toCodegraphSearchResults(results, limit, projectRoot);
      } catch {
        return [];
      }
    },
  };
}
