import { afterEach, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query }));

import { closeTerminalSuggestions, suggestTerminalCommand } from "./terminalSuggestion.js";

const prompts: string[][] = [];
const command = {
  cmd: "suggest_terminal_command" as const,
  session_id: "request",
  conversation: "terminal-a",
  turn_id: 1,
  shell: "bash",
  os: "linux",
  request: "安装 nginx",
  env: {},
};

afterEach(() => {
  closeTerminalSuggestions("terminal-a");
  closeTerminalSuggestions("terminal-b");
  query.mockReset();
  prompts.length = 0;
  vi.useRealTimers();
});

function mockCli() {
  query.mockImplementation(({ prompt }) => {
    const messages: string[] = [];
    prompts.push(messages);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const message of prompt) {
          messages.push(message.message.content);
          yield { type: "result", subtype: "success", result: "ls" };
        }
      },
      close() {},
    };
  });
}

it("reuses only the matching terminal and restores history after a configuration change", async () => {
  mockCli();
  const history = [{ id: 1, request: command.request, command: "ls", outcome: "submitted", submittedCommand: "ls -a" }];
  await expect(suggestTerminalCommand(command)).resolves.toBe("ls");
  await suggestTerminalCommand({ ...command, conversation: "terminal-b" });
  await suggestTerminalCommand({ ...command, turn_id: 2, history });
  expect(query).toHaveBeenCalledTimes(2);
  expect(JSON.parse(prompts[0][1])).toMatchObject({
    previousOutcomes: [{ id: 1, outcome: "submitted", submittedCommand: "ls -a" }],
  });
  expect(JSON.parse(prompts[0][1])).not.toHaveProperty("history");
  await suggestTerminalCommand({ ...command, turn_id: 3, history, env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: "fast-model" } });
  expect(query).toHaveBeenCalledTimes(3);
  expect(JSON.parse(prompts[2][0]).history).toEqual(history);
});

it("reclaims an idle CLI and starts a fresh one for the next turn", async () => {
  vi.useFakeTimers();
  mockCli();
  await suggestTerminalCommand(command);
  const controller = query.mock.calls[0][0].options.abortController;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(controller.signal.aborted).toBe(true);
  await suggestTerminalCommand({ ...command, turn_id: 2 });
  expect(query).toHaveBeenCalledTimes(2);
});
