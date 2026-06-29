import type { Terminal, ILink } from "xterm";
import { api } from "../api";

const FILE_PATH_RE =
  /((?:[\w./\\-]+\/)?[\w.-]+\.(ts|tsx|vue|rs|js|jsx|css|scss|json|md|toml|yaml|yml|sh|py))(:\d+)?/g;

interface LinkProviderOptions {
  workspacePath: () => string;
  openFile: (path: string, line?: number) => void;
}

export function useTerminalLinkProvider({ workspacePath, openFile }: LinkProviderOptions) {
  const existsCache = new Map<string, boolean>();

  function registerTo(terminal: Terminal) {
    terminal.registerLinkProvider({
      provideLinks(y, callback) {
        const bufLine = terminal.buffer.active.getLine(y - 1);
        if (!bufLine) { callback(undefined); return; }

        // Build text and colMap by scanning buffer cells directly.
        // This correctly handles wide characters (CJK, emoji) which occupy 2 terminal
        // columns but only 1 string position — using translateToString() + match.index
        // would give wrong x coordinates whenever wide chars appear before the path.
        const colMap: number[] = []; // colMap[stringIndex] = 0-based terminal column
        let text = "";
        for (let x = 0; x < bufLine.length; x++) {
          const cell = bufLine.getCell(x);
          if (!cell || cell.getWidth() === 0) continue; // skip wide-char continuation cells
          colMap.push(x);
          text += cell.getChars() || " ";
        }

        const links: ILink[] = [];
        let match: RegExpExecArray | null;
        FILE_PATH_RE.lastIndex = 0;

        const pending: Promise<void>[] = [];

        while ((match = FILE_PATH_RE.exec(text)) !== null) {
          const rawPath = match[1];
          const lineNum = match[3] ? parseInt(match[3].slice(1), 10) : undefined;

          const textBefore = text.slice(0, match.index);
          if (/https?:\/\/\S*$/.test(textBefore)) continue;

          // Convert string indices to actual terminal columns via colMap
          const startCol = colMap[match.index] ?? match.index;
          const endCol = colMap[match.index + match[0].length - 1] ?? (match.index + match[0].length - 1);

          const capturedPath = rawPath;
          const capturedLine = lineNum;
          const capturedText = match[0];

          pending.push(
            (async () => {
              const ws = workspacePath();
              const isAbsolute = capturedPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(capturedPath);
              const fullPath = isAbsolute ? capturedPath : `${ws}/${capturedPath}`.replace(/\\/g, "/");

              let exists = existsCache.get(fullPath);
              if (exists === undefined) {
                exists = await api.fileExists(fullPath);
                existsCache.set(fullPath, exists);
              }
              if (!exists) return;

              links.push({
                range: { start: { x: startCol + 1, y }, end: { x: endCol + 1, y } },
                text: capturedText,
                activate(event: MouseEvent) {
                  if (!event.ctrlKey) return;
                  openFile(fullPath, capturedLine);
                },
              });
            })()
          );
        }

        Promise.all(pending).then(() => callback(links.length ? links : undefined));
      },
    });
  }

  return { registerTo };
}
