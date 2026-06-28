import type { Terminal, ILink } from "xterm";
import { api } from "../api";

const FILE_PATH_RE =
  /((?:[\w./\\-]+\/)?[\w.-]+\.(ts|tsx|vue|rs|js|jsx|css|scss|json|md|toml|yaml|yml|sh|py))(:\d+)?/g;

interface LinkProviderOptions {
  workspacePath: () => string;
  openFile: (path: string, line?: number) => void;
}

export function useTerminalLinkProvider({ workspacePath, openFile }: LinkProviderOptions) {
  function registerTo(terminal: Terminal) {
    terminal.registerLinkProvider({
      provideLinks(y, callback) {
        const line = terminal.buffer.active.getLine(y);
        if (!line) { callback(undefined); return; }

        const text = line.translateToString(true);
        const links: ILink[] = [];
        let match: RegExpExecArray | null;
        FILE_PATH_RE.lastIndex = 0;

        const pending: Promise<void>[] = [];

        while ((match = FILE_PATH_RE.exec(text)) !== null) {
          const rawPath = match[1];
          const lineNum = match[3] ? parseInt(match[3].slice(1), 10) : undefined;
          const startX = match.index;
          const endX = match.index + match[0].length;

          if (rawPath.startsWith("http://") || rawPath.startsWith("https://")) continue;

          const capturedPath = rawPath;
          const capturedLine = lineNum;
          const capturedText = match[0];

          pending.push(
            (async () => {
              const ws = workspacePath();
              const isAbsolute = capturedPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(capturedPath);
              const fullPath = isAbsolute ? capturedPath : `${ws}/${capturedPath}`.replace(/\\/g, "/");

              const exists = await api.fileExists(fullPath);
              if (!exists) return;

              links.push({
                range: { start: { x: startX + 1, y }, end: { x: endX, y } },
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
