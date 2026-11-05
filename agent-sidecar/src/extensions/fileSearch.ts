import { glob } from "tinyglobby";
import { resolve } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const FILE_SEARCH_TOOL = "mcp__aide-search__glob";
const EXCLUDED = [".git", "node_modules", "target", "dist", "build", "coverage", ".next", ".nuxt"];
const MAX_RESULTS = 200;
const MAX_BYTES = 16 * 1024;

export async function findFiles(args: { pattern: string; path?: string }, cwd: string): Promise<string> {
  const root = resolve(cwd, args.path ?? ".");
  // Explicitly named dependency/build directories remain searchable. A generic
  // wildcard never opts in accidentally; no silent widening or retry.
  const named = new Set(args.pattern.replaceAll("\\", "/").split("/"));
  const ignore = EXCLUDED.filter((name) => !named.has(name)).map((name) => `**/${name}/**`);
  const signal = AbortSignal.timeout(1500);
  try {
    const files = await glob(args.pattern, { cwd: root, absolute: true, onlyFiles: true,
      followSymbolicLinks: false, dot: false, ignore, signal });
    if (signal.aborted) return "File search timed out. Results are incomplete; narrow path or pattern before drawing conclusions.";
    return renderFiles(files.sort(), ignore.length > 0);
  } catch (error) {
    if (error instanceof Error && /abort|timeout/i.test(error.name)) return "File search exceeded its 1.5s budget. Narrow path or pattern; no automatic broader search was run.";
    return `File search failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function renderFiles(files: string[], excluded: boolean): string {
  const lines: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file) + 1;
    if (lines.length >= MAX_RESULTS || bytes + size > MAX_BYTES) break;
    lines.push(file);
    bytes += size;
  }
  const note = excluded ? "Dependency/build trees excluded unless explicitly named in path/pattern." : "";
  return [...lines, `Showing ${lines.length} of ${files.length} files. ${note}`,
    ...(lines.length < files.length ? ["Results truncated. Narrow the search; do not assume missing paths do not exist."] : [])].join("\n");
}

export function fileSearchRegistration(cwd: string): Record<string, unknown> {
  const server = createSdkMcpServer({ name: "aide-search", version: "1.0.0",
    tools: [tool("glob", "Find project files with bounded output/time. Excludes dependency and build trees by default. To inspect one, explicitly name it in path or pattern. No file content is read.",
      { pattern: z.string().min(1), path: z.string().optional() }, (args) =>
        findFiles(args, cwd).then((text) => ({ content: [{ type: "text" as const, text }] }))) ] });
  return { "aide-search": server };
}
