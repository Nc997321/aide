// "/" 下拉的候选 = 命令注册表 + 本地技能 + 本会话的 SDK 清单，三路**合并**。
//
// 2026-10-10 修：此前本 composable 写了没接（ChatInputBox 自己只扫本地技能），
// 下拉里既没有 /compact /clear /btw，也永远看不到会话开始后 SDK 给的命令。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref, nextTick } from "vue";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { filterSlashCommands, useSlashCommands } from "./useSlashCommands";

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

const SKILL = { name: "brainstorming", description: "头脑风暴", source: "user", filePath: "/a/SKILL.md", provider: "claude" };
const BUILTIN = ["btw", "compact", "clear"];

describe("useSlashCommands", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("会话未开始（SDK 清单为 null）：命令注册表 + 本地技能（含描述）", async () => {
    invokeMock.mockResolvedValue([SKILL]);

    const { options, localSkills } = useSlashCommands(() => "/workspace", () => null);
    await flush();

    expect(options.value.map((o) => o.name)).toEqual([...BUILTIN, "brainstorming"]);
    expect(options.value[0]).toEqual({ name: "btw", description: "顺便问一下", source: "内置" });
    expect(options.value[3]).toEqual({ name: "brainstorming", description: "头脑风暴", source: "user" });
    // 发送路径靠它内联 SKILL.md
    expect(localSkills.value).toEqual([SKILL]);
  });

  it("会话开始后：SDK 清单里其余的命令追加进来，已有的按名去重、保留带描述的那条", async () => {
    invokeMock.mockResolvedValue([SKILL]);
    const commands = ref<string[] | null>(null);

    const { options } = useSlashCommands(() => "/workspace", () => commands.value);
    await flush();
    commands.value = ["compact", "clear", "brainstorming", "context", "review"];
    await flush();

    expect(options.value.map((o) => o.name)).toEqual([...BUILTIN, "brainstorming", "context", "review"]);
    expect(options.value.find((o) => o.name === "brainstorming")?.description).toBe("头脑风暴");
    expect(options.value.find((o) => o.name === "context")).toEqual({ name: "context", description: "", source: "" });
  });

  it("工作区变化时重扫本地技能", async () => {
    invokeMock.mockResolvedValue([SKILL]);
    const ws = ref<string | undefined>("/workspace-a");

    const { options } = useSlashCommands(() => ws.value, () => null);
    await flush();
    invokeMock.mockResolvedValue([]);
    ws.value = "/workspace-b";
    await flush();

    expect(options.value.map((o) => o.name)).toEqual(BUILTIN);
  });

  it("scanPluginSkills 失败时本地清单为空，不抛异常，其余来源照常", async () => {
    invokeMock.mockRejectedValue(new Error("boom"));

    const { options } = useSlashCommands(() => "/workspace", () => ["context"]);
    await flush();

    expect(options.value.map((o) => o.name)).toEqual([...BUILTIN, "context"]);
  });
});

describe("filterSlashCommands", () => {
  const opts = ["btw", "compact", "clear", "security-review", "context"].map((name) => ({
    name,
    description: "",
    source: "",
  }));

  it("包含即命中，前缀命中排前面", () => {
    expect(filterSlashCommands(opts, "c").map((o) => o.name)).toEqual([
      "compact",
      "clear",
      "context",
      "security-review",
    ]);
  });

  it("空输入给全量，大小写不敏感", () => {
    expect(filterSlashCommands(opts, "")).toHaveLength(5);
    expect(filterSlashCommands(opts, "BT").map((o) => o.name)).toEqual(["btw"]);
  });
});
