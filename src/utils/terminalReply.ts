// xterm sends terminal protocol replies through onData alongside keyboard input.
export function isTerminalReply(data: string): boolean {
  return /^(?:\x1b\[[IO]|\x1b\[\??\d+;\d+R|\x1b\[0n|\x1b\[[?>][\d;]+c|\x1b\[\??\d+;\d+\$y|\x1b\[[468];\d+;\d+t|\x1b\](?:4;\d+|10|11|12);rgb:[\da-f/]+(?:\x07|\x1b\\)|\x1bP[01]\$r[^\x1b]*\x1b\\)$/.test(data);
}
