# Slash Commands 对接 SDK 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Claude Agent SDK 的 `system_init.slash_commands` 权威清单真正接入 Aide，退役 `ChatPanel.vue` 里"读 SKILL.md 原文拼 prompt"的本地仿制逻辑，改为原样透传给 SDK 原生处理；同时给工具栏加 `/compact`/`/clear` 快捷按钮，并为未来"自定义工具栏"留扩展点。

**Architecture:** `agent-sidecar/src/mapper.ts` 在 `system/init` 时新增发一条独立事件 `slash_commands_available`（跟 `models_available`/`permission_modes_available` 同构）；Rust 层无需改动（`sidecar.rs` 已是通用 JSON 透传）；前端新增两个独立 composable——`useSlashCommands.ts`（命令发现：会话未开始用 Rust 本地扫描富清单兜底，SDK 权威清单一到就单向切换为纯命令名）和 `useQuickActions.ts`（工具栏快捷操作注册表，仿照 `useSearchProviders.ts` 模式）；`ChatPanel.vue` 删除本地拼装逻辑，接入这两个 composable。

**Tech Stack:** TypeScript + Vue 3 Composition API（前端）、Node.js + `@anthropic-ai/claude-agent-sdk`（sidecar）、Vitest（单测，`vitest.config.ts` 同时覆盖 `src/**/*.test.ts` 和 `agent-sidecar/src/**/*.test.ts`，一条 `pnpm test` 跑全部）。

## Global Constraints

- 跨平台：本次改动不涉及路径拼接或平台特有逻辑，无需 `#[cfg(windows)]` 隔离。
- 多 Agent 抽象红线：Claude 专属逻辑只能出现在 `agent-sidecar/`；`src/types/chat.ts` 里的 `ChatEvent` 新增字段必须是 provider-agnostic 的不透明类型（`commands: string[]`，不解释语义），Rust 层不需要新增任何 Claude 专属类型。
- `slash_commands_available` 事件仅在 `Array.isArray(msg.slash_commands)` 为真时发出——字段缺失（旧版 CLI/无此概念）和字段为空数组是两种不同语义，不能混淆。
- 发送路径删除后不得有任何本地文件读取（`api.readFileContent`）参与 slash command 的 prompt 拼接；`@path` 文件引用展开（`resolveFileMentions`）是独立机制，不在本次改动范围内，保持不变。
- 新建文件遵循项目"文件即架构层级"约定：`useSlashCommands.ts`/`useQuickActions.ts` 各自单一职责，不塞进 `ChatPanel.vue` 内联。

---

### Task 1: Sidecar 发出 `slash_commands_available` 事件

**Files:**
- Modify: `agent-sidecar/src/types.ts`
- Modify: `agent-sidecar/src/mapper.ts:131-134`
- Test: `agent-sidecar/src/mapper.test.ts`

**Interfaces:**
- Produces: `ChatEvent` 新变体 `{ type: "slash_commands_available"; commands: string[] }`，后续任务（Task 2）在前端镜像消费。

- [ ] **Step 1: 写失败测试**

在 `agent-sidecar/src/mapper.test.ts` 文件末尾追加新的 `describe` 块：

```typescript
describe("mapSdkMessage system/init → slash_commands_available", () => {
  function systemInit(sessionId: string, slashCommands?: unknown) {
    return {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      ...(slashCommands !== undefined ? { slash_commands: slashCommands } : {}),
    };
  }

  it("slash_commands 是数组时，session_init 之外多发一条 slash_commands_available", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(
      systemInit("s1", ["clear", "compact", "code-review"]),
      (e) => events.push(e),
      new TaskTracker(),
      new SubagentTracker(),
    );
    expect(events).toEqual([
      { type: "session_init", session_id: "s1" },
      { type: "slash_commands_available", commands: ["clear", "compact", "code-review"] },
    ]);
  });

  it("slash_commands 是空数组时，仍然发出（不是缺省不发）", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(systemInit("s1", []), (e) => events.push(e), new TaskTracker(), new SubagentTracker());
    expect(events).toEqual([
      { type: "session_init", session_id: "s1" },
      { type: "slash_commands_available", commands: [] },
    ]);
  });

  it("slash_commands 字段缺失时（旧版 CLI），只发 session_init", () => {
    const events: ChatEvent[] = [];
    mapSdkMessage(systemInit("s1"), (e) => events.push(e), new TaskTracker(), new SubagentTracker());
    expect(events).toEqual([{ type: "session_init", session_id: "s1" }]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test -- mapper.test.ts`
Expected: FAIL —— 新增的三个用例里，前两个会因为 `ChatEvent` 数组只包含 `session_init` 而失败（`slash_commands_available` 未被发出）；第三个应该已经通过（因为现状本来就只发 `session_init`，可以先确认这一条现在就是绿的）。

- [ ] **Step 3: 实现**

`agent-sidecar/src/types.ts`——在 `ChatEvent` 联合类型里，紧跟 `permission_modes_available` 变体之后加一行：

```typescript
  | { type: "permission_modes_available"; modes: PermissionModeOption[]; current: string }
  // 会话建立时 SDK 回传的权威 slash commands 清单（内置命令 + skills + 自定义命令），
  // 仅当 SDK 提供该字段时才发（见 mapper.ts 的 Array.isArray 判断）。
  | { type: "slash_commands_available"; commands: string[] }
```

`agent-sidecar/src/mapper.ts:131-134`——把现有的

```typescript
  if (msg.type === "system" && msg.subtype === "init") {
    emit({ type: "session_init", session_id: msg.session_id });
    return;
  }
```

改成：

```typescript
  if (msg.type === "system" && msg.subtype === "init") {
    emit({ type: "session_init", session_id: msg.session_id });
    // undefined（旧版 CLI/无此概念）不发；[] 是 SDK 明确给的空清单，正常发。
    if (Array.isArray(msg.slash_commands)) {
      emit({ type: "slash_commands_available", commands: msg.slash_commands });
    }
    return;
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test -- mapper.test.ts`
Expected: PASS（全部用例，包括本任务新增的 3 条）

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/types.ts agent-sidecar/src/mapper.ts agent-sidecar/src/mapper.test.ts
git commit -m "feat(sidecar): emit slash_commands_available on system/init"
```

---

### Task 2: 前端镜像事件类型 + `useChatSession` 消费

**Files:**
- Modify: `src/types/chat.ts`
- Modify: `src/composables/useChatSession.ts`
- Test: `src/composables/useChatSession.test.ts`

**Interfaces:**
- Consumes: Task 1 产出的 `{ type: "slash_commands_available"; commands: string[] }`
- Produces: `useChatSession(sessionId)` 返回对象新增 `slashCommands: ComputedRef<string[] | null>`，供 Task 4 的 `ChatPanel.vue` 消费。

- [ ] **Step 1: 写失败测试**

在 `src/composables/useChatSession.test.ts` 里找到 `it("models_available 更新可选模型列表和当前选中项", ...)` 这个用例（约第 248 行），紧跟其后追加：

```typescript
  it("slash_commands_available 更新会话的命令清单", async () => {
    const sid = ref<string | null>("uuid-a");
    const chat = useChatSession(sid);
    await flush();
    expect(chat.slashCommands.value).toBeNull();

    emit({
      type: "slash_commands_available",
      commands: ["compact", "clear", "review-pr"],
      session_id: "uuid-a",
    });
    await flush();
    expect(chat.slashCommands.value).toEqual(["compact", "clear", "review-pr"]);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test -- useChatSession.test.ts`
Expected: FAIL —— `chat.slashCommands` 是 `undefined`（属性不存在），断言 `.toBeNull()` 失败。

- [ ] **Step 3: 实现**

`src/types/chat.ts`——在 `ChatEvent` 联合类型里，紧跟 `permission_modes_available` 之后加一行（与 sidecar 端镜像）：

```typescript
  | { type: "permission_modes_available"; modes: PermissionModeOption[]; current: string }
  // 会话建立时 SDK 回传的权威 slash commands 清单；跟 agent-sidecar/src/types.ts 镜像。
  | { type: "slash_commands_available"; commands: string[] }
```

`src/composables/useChatSession.ts`——`SessionStore` 接口（约第 42-64 行）在 `currentPermissionMode` 字段后加：

```typescript
  /** 当前生效的权限模式 value；空串表示还没从 sidecar 学到 */
  currentPermissionMode: string;
  /** SDK 权威 slash commands 清单；null 表示本会话还没收到过（会话未开始，
   *  或 provider 不支持该概念）。一旦非 null，下拉框数据源单向切换，不回退。 */
  slashCommands: string[] | null;
  /** 忙碌时排队的待发消息——message_stop 后按序自动续发 */
  queued: QueuedSend[];
```

`getStore()` 里的初始对象（约第 99-112 行）加一行：

```typescript
      permissionModes: [],
      currentPermissionMode: "",
      slashCommands: null,
      queued: [],
```

`handleChatEvent` 的 `switch` 里，紧跟 `case "permission_modes_available":` 分支（约第 334-339 行）之后加：

```typescript
    case "slash_commands_available": {
      store.slashCommands = e["commands"] as string[];
      break;
    }
```

`useChatSession()` 的返回对象（约第 608-637 行），紧跟 `currentPermissionMode` 之后加：

```typescript
    currentPermissionMode: computed(() => current.value?.currentPermissionMode ?? ""),
    /** null 表示本会话还没收到过 SDK 权威清单——不做跨会话共享兜底
     *  （跟 models/permissionModes 不同：这里的兜底走 ChatPanel 里的
     *  useSlashCommands 本地扫描，而不是借用别的会话学到的列表）。 */
    slashCommands: computed(() => current.value?.slashCommands ?? null),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test -- useChatSession.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/types/chat.ts src/composables/useChatSession.ts src/composables/useChatSession.test.ts
git commit -m "feat(chat): thread slash_commands_available through useChatSession"
```

---

### Task 3: 新增 `useSlashCommands.ts`

**Files:**
- Create: `src/composables/useSlashCommands.ts`
- Test: `src/composables/useSlashCommands.test.ts`

**Interfaces:**
- Consumes: `api.scanPluginSkills(cwd: string): Promise<SkillMeta[]>`（`src/api.ts`，已存在，不改）；`SkillMeta`（`src/types.ts` 导出，形状 `{ name, description, source, filePath, provider }`，已存在，不改）
- Produces: `useSlashCommands(workspacePath: Ref<string | undefined>, sdkCommands: ComputedRef<string[] | null>): { dropdownOptions: ComputedRef<SlashCommandOption[]> }`，其中 `SlashCommandOption = { name: string; description?: string }`。供 Task 5 的 `ChatPanel.vue` 消费。

- [ ] **Step 1: 写失败测试**

创建 `src/composables/useSlashCommands.test.ts`：

```typescript
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test -- useSlashCommands.test.ts`
Expected: FAIL —— 找不到模块 `./useSlashCommands`（文件还不存在）。

- [ ] **Step 3: 实现**

创建 `src/composables/useSlashCommands.ts`：

```typescript
import { ref, watch, computed, type Ref, type ComputedRef } from "vue";
import { api } from "@/api";
import type { SkillMeta } from "@/types";

/** useSlashCommands 对外暴露的下拉选项形状——纯 UI 派生数据，不进入
 *  核心 ChatEvent 协议，所以就近定义在这里，不放进 types/chat.ts。 */
export interface SlashCommandOption {
  name: string;
  description?: string;
}

/**
 * "/" 下拉框的命令发现与数据源切换：
 * - 会话未开始（sdkCommands 为 null）：用 Rust 本地扫描的 .claude/skills 富清单
 *   （含 description）兜底，workspacePath 变化时重新扫描。
 * - 一旦本次会话收到过 SDK 权威清单（sdkCommands 非 null）：单向切换为纯命令名，
 *   不再展示描述，也不会因为 workspacePath 之后再变化而回退到本地清单。
 */
export function useSlashCommands(
  workspacePath: Ref<string | undefined>,
  sdkCommands: ComputedRef<string[] | null>,
) {
  const localSkills = ref<SkillMeta[]>([]);

  watch(
    workspacePath,
    async (ws) => {
      try {
        localSkills.value = await api.scanPluginSkills(ws ?? "");
      } catch {
        localSkills.value = [];
      }
    },
    { immediate: true },
  );

  const dropdownOptions = computed<SlashCommandOption[]>(() =>
    sdkCommands.value === null
      ? localSkills.value.map((s) => ({ name: s.name, description: s.description }))
      : sdkCommands.value.map((name) => ({ name })),
  );

  return { dropdownOptions };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test -- useSlashCommands.test.ts`
Expected: PASS（全部 4 条）

- [ ] **Step 5: 提交**

```bash
git add src/composables/useSlashCommands.ts src/composables/useSlashCommands.test.ts
git commit -m "feat(chat): add useSlashCommands composable for / dropdown discovery"
```

---

### Task 4: 新增 `useQuickActions.ts`

**Files:**
- Create: `src/composables/useQuickActions.ts`
- Test: `src/composables/useQuickActions.test.ts`

**Interfaces:**
- Produces: `useQuickActions(): { actions: QuickAction[]; register(action: QuickAction): void; unregister(id: string): void }`，其中 `QuickAction = { id: string; label: string; prompt: string }`。供 Task 5 的 `ChatPanel.vue` 消费；`register`/`unregister` 是留给未来"自定义工具栏"功能的扩展点，本次不接对应 UI。

- [ ] **Step 1: 写失败测试**

创建 `src/composables/useQuickActions.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { useQuickActions } from "./useQuickActions";

describe("useQuickActions", () => {
  it("默认注册表包含 compact 和 clear，形状稳定", () => {
    const { actions } = useQuickActions();
    expect(actions).toEqual([
      { id: "compact", label: "压缩上下文", prompt: "/compact" },
      { id: "clear", label: "清空上下文", prompt: "/clear" },
    ]);
  });

  it("register 可以新增条目，unregister 可以移除——为未来自定义工具栏留的扩展点", () => {
    const { actions, register, unregister } = useQuickActions();
    register({ id: "custom", label: "自定义", prompt: "/custom" });
    expect(actions.find((a) => a.id === "custom")).toEqual({ id: "custom", label: "自定义", prompt: "/custom" });

    unregister("custom");
    expect(actions.find((a) => a.id === "custom")).toBeUndefined();
  });

  it("register 用同 id 调用会替换而不是重复追加", () => {
    const { actions, register, unregister } = useQuickActions();
    register({ id: "custom", label: "第一版", prompt: "/custom" });
    register({ id: "custom", label: "第二版", prompt: "/custom2" });
    expect(actions.filter((a) => a.id === "custom")).toEqual([
      { id: "custom", label: "第二版", prompt: "/custom2" },
    ]);
    unregister("custom");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test -- useQuickActions.test.ts`
Expected: FAIL —— 找不到模块 `./useQuickActions`（文件还不存在）。

- [ ] **Step 3: 实现**

创建 `src/composables/useQuickActions.ts`：

```typescript
/** 工具栏快捷操作——仿照 useSearchProviders.ts 的注册表模式：模块级单例数组，
 *  register/unregister 是留给未来"自定义工具栏"功能的扩展点，当前只暴露
 *  内置的 /compact /clear 两个默认条目，不接任何自定义 UI。 */
export interface QuickAction {
  id: string;
  label: string;
  prompt: string;
}

const actions: QuickAction[] = [
  { id: "compact", label: "压缩上下文", prompt: "/compact" },
  { id: "clear", label: "清空上下文", prompt: "/clear" },
];

function register(action: QuickAction) {
  const idx = actions.findIndex((a) => a.id === action.id);
  if (idx >= 0) {
    actions[idx] = action;
  } else {
    actions.push(action);
  }
}

function unregister(id: string) {
  const idx = actions.findIndex((a) => a.id === id);
  if (idx >= 0) actions.splice(idx, 1);
}

export function useQuickActions() {
  return { actions, register, unregister };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test -- useQuickActions.test.ts`
Expected: PASS（全部 3 条）

- [ ] **Step 5: 提交**

```bash
git add src/composables/useQuickActions.ts src/composables/useQuickActions.test.ts
git commit -m "feat(chat): add useQuickActions toolbar registry (compact/clear built-ins)"
```

---

### Task 5: `ChatPanel.vue` 接入新 composable，退役本地拼装逻辑

**Files:**
- Modify: `src/components/ChatPanel.vue`
- Modify: `src/App.vue`

**Interfaces:**
- Consumes: `useSlashCommands` 和 `useQuickActions`（Task 3、4 产出）；`useChatSession().slashCommands`（Task 2 产出）
- Produces: 无（这是消费端，本任务不产出给后续任务使用的接口）

这一任务没有独立测试文件——项目现有测试都是 composable/util 级别的纯逻辑单测（`vitest.config.ts` 用 `environment: "node"`，没有装 `@vue/test-utils`），`ChatPanel.vue` 本身从未有过组件级测试。核心逻辑（命令发现的合并/切换、发送前不读文件）已经在 Task 3 的 `useSlashCommands.test.ts` 里覆盖；本任务是纯粹的"接线"，正确性通过 Step 2 的类型检查 + Step 3 的人工过一遍 diff 确认。

- [ ] **Step 1: 确认起点——运行一次类型检查建立基线**

Run: `npx vue-tsc --noEmit`
Expected: 无输出（当前无类型错误），作为改动前后的对照基线。

- [ ] **Step 2: 修改 `ChatPanel.vue`**

**2a. imports**——在文件顶部的 import 区（约第 1-17 行），删除：

```typescript
import type { SkillMeta } from "@/types";
```

加入：

```typescript
import { useSlashCommands } from "@/composables/useSlashCommands";
import type { SlashCommandOption } from "@/composables/useSlashCommands";
import { useQuickActions } from "@/composables/useQuickActions";
import type { QuickAction } from "@/composables/useQuickActions";
```

**2b. props**——在 `defineProps` 里（约第 19-36 行），`permissionModes`/`currentPermissionMode` 之后加一行：

```typescript
  permissionModes?: PermissionModeOption[];
  currentPermissionMode?: string;
  /** SDK 权威 slash commands 清单；null/undefined 表示本会话还没收到过，
   *  useSlashCommands 会用本地扫描兜底。 */
  slashCommands?: string[] | null;
  /** 忙碌时排队的待发消息文本（顺序即发送顺序） */
  queuedPrompts?: string[];
```

**2c. 删除旧的本地状态和扫描逻辑**——删除这一整块（约第 209-220 行）：

```typescript
const skillList = ref<SkillMeta[]>([]);
const slashDropdownVisible = ref(false);
const slashFilter = ref("");
const slashSelectedIndex = ref(0);

const filteredSkills = computed(() => {
  if (!slashDropdownVisible.value) return [];
  const q = slashFilter.value.toLowerCase();
  return skillList.value
    .filter((s) => s.name.toLowerCase().includes(q))
    .slice(0, 8);
});
```

替换为：

```typescript
const slashDropdownVisible = ref(false);
const slashFilter = ref("");
const slashSelectedIndex = ref(0);

const { dropdownOptions } = useSlashCommands(
  computed(() => props.workspacePath),
  computed(() => props.slashCommands ?? null),
);
const filteredSkills = computed(() => {
  if (!slashDropdownVisible.value) return [];
  const q = slashFilter.value.toLowerCase();
  return dropdownOptions.value
    .filter((o) => o.name.toLowerCase().includes(q))
    .slice(0, 8);
});
const { actions: quickActions } = useQuickActions();
```

**2d. 删除旧的 workspacePath 扫描 watch**——删除这一整块（约第 225-236 行）：

```typescript
// skills 随工作区变化重扫（onMounted 时 workspacePath 往往还是空串）
watch(
  () => props.workspacePath,
  async (ws) => {
    try {
      skillList.value = await api.scanPluginSkills(ws ?? "");
    } catch {
      skillList.value = [];
    }
  },
  { immediate: true },
);
```

（这段逻辑已经搬进 `useSlashCommands.ts` 内部，2c 里已经调用过了，这里直接删不用替换。）

**2e. `selectSkill` 改用新类型**——把（约第 282-287 行）：

```typescript
function selectSkill(skill: SkillMeta | undefined) {
  if (!skill) return;
  inputText.value = "/" + skill.name + " ";
  slashDropdownVisible.value = false;
  nextTick(() => textareaEl.value?.focus());
}
```

改成：

```typescript
function selectSkill(skill: SlashCommandOption | undefined) {
  if (!skill) return;
  inputText.value = "/" + skill.name + " ";
  slashDropdownVisible.value = false;
  nextTick(() => textareaEl.value?.focus());
}
```

**2f. `handleSend` 删除本地文件拼接**——把（约第 351-369 行）：

```typescript
async function handleSend() {
  const text = inputText.value.trim();
  const hasImages = pendingImages.value.length > 0;
  // 忙碌时不再拦截：useChatSession 会把消息排队，message_stop 后按序续发
  if (!text && !hasImages) return;

  let finalPrompt = text;
  const slashMatch = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
  if (slashMatch) {
    const skillName = slashMatch[1];
    const userText = (slashMatch[2] ?? "").trim();
    const skill = skillList.value.find((s) => s.name === skillName);
    if (skill) {
      try {
        const content = await api.readFileContent(skill.filePath);
        finalPrompt = userText ? `${content}\n\n---\n\n${userText}` : content;
      } catch { /* 读取失败则原样发送 */ }
    }
  }
```

改成：

```typescript
async function handleSend() {
  const text = inputText.value.trim();
  const hasImages = pendingImages.value.length > 0;
  // 忙碌时不再拦截：useChatSession 会把消息排队，message_stop 后按序续发
  if (!text && !hasImages) return;

  // 不管命中下拉框里的哪个命令、还是手打，一律原样透传——frontmatter 剥离/
  // $ARGUMENTS 占位符替换/allowed-tools/!bash 执行块全部交给 SDK 原生处理，
  // 这里不再读文件、不再拼接（2026-07-04 slash-commands 设计退役的本地仿制逻辑）。
  const finalPrompt = text;
```

**2g. 新增快捷操作发送函数**——紧跟 `handleSend` 函数之后（约第 390 行之后，`</script>` 之前）加：

```typescript
function handleQuickAction(action: QuickAction) {
  emit("send", action.prompt, {
    initialModel: selectedModel.value || undefined,
    permissionMode: selectedPermissionMode.value || undefined,
  });
}
```

**2h. 下拉框模板**——把（约第 427-438 行）：

```html
      <div v-if="filteredSkills.length" class="skill-dropdown">
        <div
          v-for="(skill, i) in filteredSkills"
          :key="skill.provider + ':' + skill.name"
          :class="['skill-item', i === slashSelectedIndex ? 'skill-item--active' : '']"
          @mousedown.prevent="selectSkill(skill)"
        >
          <span class="skill-item-name">/{{ skill.name }}</span>
          <span class="skill-item-source">{{ skill.source }}</span>
          <span class="skill-item-desc">{{ skill.description }}</span>
        </div>
      </div>
```

改成：

```html
      <div v-if="filteredSkills.length" class="skill-dropdown">
        <div
          v-for="(skill, i) in filteredSkills"
          :key="skill.name"
          :class="['skill-item', i === slashSelectedIndex ? 'skill-item--active' : '']"
          @mousedown.prevent="selectSkill(skill)"
        >
          <span class="skill-item-name">/{{ skill.name }}</span>
          <span v-if="skill.description" class="skill-item-desc">{{ skill.description }}</span>
        </div>
      </div>
```

**2i. 工具栏加快捷操作按钮**——在 `.chat-toolbar` 内（约第 474-481 行），紧跟权限模式 `ThemedSelect` 之后、`chat-ctx-usage` 之前插入：

```html
          <ThemedSelect
            v-if="displayPermissionModes.length"
            :model-value="selectedPermissionMode"
            :options="permissionModeSelectOptions"
            title="权限模式"
            @update:model-value="handlePermissionModeChange"
          />
          <div v-if="quickActions.length" class="chat-quick-actions">
            <button
              v-for="qa in quickActions"
              :key="qa.id"
              class="chat-quick-action-btn"
              :title="qa.prompt"
              @click="handleQuickAction(qa)"
            >{{ qa.label }}</button>
          </div>
```

**2j. CSS**——删除现在没有字段来源的 `.skill-item-source` 规则（约第 805-812 行）：

```css
.skill-item-source {
  font-size: 10px;
  color: var(--aide-text-muted);
  flex-shrink: 0;
  background: var(--aide-bg-deep);
  padding: 1px 4px;
  border-radius: 3px;
}
```

直接删掉这个规则块。然后在 `.skill-item-desc` 规则之后加快捷操作按钮的样式：

```css
.chat-quick-actions {
  display: flex;
  gap: 4px;
}

.chat-quick-action-btn {
  background: transparent;
  color: var(--aide-text-secondary);
  border: 1px solid var(--aide-border);
  border-radius: var(--aide-radius-sm);
  font-size: 12px;
  padding: 2px 8px;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}

.chat-quick-action-btn:hover {
  background: var(--aide-surface-default);
  border-color: var(--aide-surface-hover);
  color: var(--aide-text-primary);
}
```

- [ ] **Step 3: 修改 `App.vue` 透传新 prop**

在 `src/App.vue` 里找到 `useChatSession` 解构（约第 109 行）：

```typescript
const { pendingPermission, respondPermission, messages, isBusy, models, currentModel, totalCostUsd, contextUsage, rateLimit, tasks, permissionModes, currentPermissionMode, queuedPrompts, sendMessage, interrupt, stopSession, onSessionCreated, setModel, setPermissionMode, removeQueued } = useChatSession(chatSessionIdRef);
```

改成（在 `currentPermissionMode` 后加 `slashCommands`）：

```typescript
const { pendingPermission, respondPermission, messages, isBusy, models, currentModel, totalCostUsd, contextUsage, rateLimit, tasks, permissionModes, currentPermissionMode, slashCommands, queuedPrompts, sendMessage, interrupt, stopSession, onSessionCreated, setModel, setPermissionMode, removeQueued } = useChatSession(chatSessionIdRef);
```

找到 `<ChatPanel>` 标签（约第 514-539 行），在 `:permission-modes="permissionModes"` 之后加一行：

```html
          :permission-modes="permissionModes"
          :current-permission-mode="currentPermissionMode"
          :slash-commands="slashCommands"
          :queued-prompts="queuedPrompts"
```

- [ ] **Step 4: 运行类型检查确认无回归**

Run: `npx vue-tsc --noEmit`
Expected: 无输出。如果报错，逐条对照上面的 diff 检查是否有遗漏的引用（尤其 `SkillMeta`/`skillList` 是否还有残留引用）。

- [ ] **Step 5: 运行完整单测套件确认无回归**

Run: `pnpm test`
Expected: 全部 PASS（包括 Task 1-4 新增的用例和现有的所有用例）。

- [ ] **Step 6: 提交**

```bash
git add src/components/ChatPanel.vue src/App.vue
git commit -m "feat(chat): wire useSlashCommands/useQuickActions into ChatPanel, retire local skill splicing"
```

---

### Task 6: 人工验证（真实跑一次 sidecar）

自动化测试摸不到真实 Claude 子进程，这一步是手工过一遍，确认端到端行为符合预期。不产出代码改动。

- [ ] **Step 1: 本地起 dev 环境**

Run: `pnpm tauri dev`（或项目根目录的 `dev.ps1`）

- [ ] **Step 2: 验证会话未开始时的下拉框（本地兜底）**

新建一个空白会话，在输入框敲 `/`，确认下拉框出现、显示的是本地 `.claude/skills` 扫描到的条目（带描述）。这一步验证的是 `useSlashCommands` 的"会话未开始"分支。

- [ ] **Step 3: 验证发送第一条消息后下拉框切换为 SDK 权威清单**

发送任意一条消息（比如 "你好"），等会话建立。再次在输入框敲 `/`，确认下拉框内容变化——现在应该是纯命令名（无描述文字），且应该能看到内置命令（如 `clear`、`compact`）跟自定义 skills 混在一起。这一步验证的是 `slash_commands_available` 事件被正确消费、`dropdownOptions` 完成了单向切换。

- [ ] **Step 4: 验证工具栏快捷按钮**

点击工具栏的"压缩上下文"按钮，确认发出了一条 `/compact` 消息且 Claude 正常响应（如果历史不足两轮，应该看到 SDK 返回的提示文字而不是报错）。再点击"清空上下文"按钮，确认发出 `/clear` 并且对话上下文被重置（之后的消息不再带前面的历史）。

- [ ] **Step 5: 验证手打内置命令仍然可用**

手打 `/context` 回车（不通过下拉框选择），确认 SDK 正常响应上下文用量信息，不是被原样当成普通文本回复。

- [ ] **Step 6: 记录结果**

如果全部符合预期，在这次改动的 PR/commit 描述里注明"已手工验证 Task 6 的 5 个步骤"；如果某一步不符合预期，回到对应任务排查（大概率是 mapper.ts 的字段名/SDK 版本问题，不是前端逻辑问题——先用 `console.log` 在 sidecar 里打印原始 `system/init` 消息确认 SDK 实际字段名和内容）。

---

## Self-Review Notes

- **Spec 覆盖检查**：spec 的"变更一～五"分别对应 Task 1（sidecar 事件）、Task 2（前端类型+store）、Task 3（useSlashCommands）、Task 4（useQuickActions）、Task 5（ChatPanel 接线）；"错误处理"表格的每一行都在 Task 1/3 的测试用例里有对应断言（`Array.isArray` 判断、本地兜底、workspacePath 变化不回退）；"测试"章节列的 5 类测试，前 4 类分别对应 Task 1/2/3/4 的测试文件，第 5 类（人工验证）对应 Task 6。"不在本次范围内"的四项均未在任何任务里出现，确认没有范围蔓延。
- **占位符扫描**：全文没有 "TBD"/"实现细节待定" 类占位符；Task 5 的 diff 全部给出了完整代码而非"参照上文"式描述。
- **类型一致性核查**：`SlashCommandOption`（Task 3 定义 `{name, description?}`）在 Task 5 的模板改动（2h）里字段用法一致（`skill.name`/`skill.description`，没有再引用不存在的 `.source`/`.provider`）；`QuickAction`（Task 4 定义 `{id, label, prompt}`）在 Task 5 的 2g/2i 步骤里字段用法一致。`useSlashCommands`/`useQuickActions` 的导出函数名和参数类型在 Task 3/4 定义、Task 5 消费两处逐字核对一致。
