import { expect, it } from "vitest";
import { isTerminalReply } from "./terminalReply";

it("keeps approval pending for terminal-generated replies, including focus changes", () => {
  for (const reply of ["\x1b[I", "\x1b[O", "\x1b[12;4R", "\x1b[?1;2c", "\x1b]11;rgb:0000/0000/0000\x1b\\"]) {
    expect(isTerminalReply(reply)).toBe(true);
  }
  for (const input of ["\r", "x", "\x03", "\x1b[D", "\x1b[200~ls\x1b[201~", "\x1b[Iextra"]) {
    expect(isTerminalReply(input)).toBe(false);
  }
});
