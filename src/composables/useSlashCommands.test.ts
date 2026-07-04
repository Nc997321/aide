import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, computed, nextTick } from "vue";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useSlashCommands } from "./useSlashCommands";

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

describe("useSlashCommands", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("会话未开始（sdkCommands 为 null）时，下拉选项来自本地扫描，含描述", async () => {
    invokeMock.mockResolvedValue([
      { name: "brainstorming", description: "头脑风暴", source: "user", filePath: "/a/SKILL.md", provider: "claude" },
    ]);
    const workspacePath = ref<string | undefined>("/workspace");
    const sdkCommands = computed<string[] | null>(() => null);

    const { dropdownOptions } = useSlashCommands(workspacePath, sdkCommands);
    await flush();

    expect(dropdownOptions.value).toEqual([{ name: "brainstorming", description: "头脑风暴" }]);
  });

  it("sdkCommands 变为非 null 后，下拉选项切换为纯命令名（无描述）", async () => {
    invokeMock.mockResolvedValue([
      { name: "brainstorming", description: "头脑风暴", source: "user", filePath: "/a/SKILL.md", provider: "claude" },
    ]);
    const workspacePath = ref<string | undefined>("/workspace");
    const commands = ref<string[] | null>(null);
    const sdkCommands = computed(() => commands.value);

    const { dropdownOptions } = useSlashCommands(workspacePath, sdkCommands);
    await flush();
    expect(dropdownOptions.value).toEqual([{ name: "brainstorming", description: "头脑风暴" }]);

    commands.value = ["compact", "clear"];
    await flush();
    expect(dropdownOptions.value).toEqual([{ name: "compact" }, { name: "clear" }]);
  });

  it("一旦切换为 SDK 权威清单，workspacePath 再变化也不回退到本地清单", async () => {
    invokeMock.mockResolvedValue([
      { name: "brainstorming", description: "头脑风暴", source: "user", filePath: "/a/SKILL.md", provider: "claude" },
    ]);
    const workspacePath = ref<string | undefined>("/workspace-a");
    const commands = ref<string[] | null>(["compact"]);
    const sdkCommands = computed(() => commands.value);

    const { dropdownOptions } = useSlashCommands(workspacePath, sdkCommands);
    await flush();
    expect(dropdownOptions.value).toEqual([{ name: "compact" }]);

    workspacePath.value = "/workspace-b";
    await flush();
    expect(dropdownOptions.value).toEqual([{ name: "compact" }]);
  });

  it("scanPluginSkills 失败时本地清单为空数组，不抛异常", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));
    const workspacePath = ref<string | undefined>("/workspace");
    const sdkCommands = computed<string[] | null>(() => null);

    const { dropdownOptions } = useSlashCommands(workspacePath, sdkCommands);
    await flush();

    expect(dropdownOptions.value).toEqual([]);
  });
});
