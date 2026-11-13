// @vitest-environment jsdom
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, expect, it, vi } from "vitest";
import CommandBar from "./CommandBar.vue";

const { suggestCommand, executeSuggestion, rejectSuggestion } = vi.hoisted(() => ({
  suggestCommand: vi.fn(),
  executeSuggestion: vi.fn(),
  rejectSuggestion: vi.fn(),
}));

vi.mock("../../composables/useWorkbenchTerminal", () => ({
  useWorkbenchTerminal: () => ({ suggestCommand, executeSuggestion, rejectSuggestion }),
}));

const props = {
  sessionId: "terminal-one",
  blockId: 1,
  initialRequest: "退回到上一级",
  actionable: true,
};

beforeEach(() => vi.clearAllMocks());

it("shows generation and keeps the approved command in the same card", async () => {
  suggestCommand.mockResolvedValue("Set-Location ..");
  executeSuggestion.mockResolvedValue(undefined);
  const wrapper = mount(CommandBar, { props });
  expect(wrapper.get('[role="status"]').text()).toBe("正在生成命令…");
  await flushPromises();
  expect(suggestCommand).toHaveBeenCalledExactlyOnceWith("terminal-one", "退回到上一级", 1);
  expect(wrapper.get("code").text()).toBe("Set-Location ..");
  expect(executeSuggestion).not.toHaveBeenCalled();

  await wrapper.get(".terminal-command-allow").trigger("click");
  await flushPromises();
  expect(executeSuggestion).toHaveBeenCalledExactlyOnceWith("terminal-one", "Set-Location ..", 1);
  expect(wrapper.get('[role="status"]').text()).toBe("已提交");
  expect(wrapper.get("code").text()).toBe("Set-Location ..");
  wrapper.unmount();
});

it("executes only the edited command when the user approves", async () => {
  suggestCommand.mockResolvedValue("ls -la");
  executeSuggestion.mockResolvedValue(undefined);
  const wrapper = mount(CommandBar, { props });
  await flushPromises();
  await wrapper.findAll("button").find(button => button.text() === "修改")!.trigger("click");
  await wrapper.get("input").setValue("ls -l");
  expect(executeSuggestion).not.toHaveBeenCalled();
  await wrapper.get(".terminal-command-allow").trigger("click");
  await flushPromises();
  expect(executeSuggestion).toHaveBeenCalledExactlyOnceWith("terminal-one", "ls -l", 1);
  expect(wrapper.get("code").text()).toBe("ls -l");
  wrapper.unmount();
});

it("records rejection and ignores a model reply that arrives afterward", async () => {
  let resolve!: (command: string) => void;
  suggestCommand.mockReturnValue(new Promise<string>(done => { resolve = done; }));
  const wrapper = mount(CommandBar, { props });
  await wrapper.get("button").trigger("click");
  resolve("ls -la");
  await flushPromises();
  expect(rejectSuggestion).toHaveBeenCalledExactlyOnceWith("terminal-one", 1);
  expect(executeSuggestion).not.toHaveBeenCalled();
  expect(wrapper.get('[role="status"]').text()).toBe("已拒绝");
  expect(wrapper.find("code").exists()).toBe(false);
  wrapper.unmount();
});
