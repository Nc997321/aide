# Slash Commands 对接 SDK 设计

> 把 Claude Agent SDK 的 slash commands 机制真正接入 Aide，退役现有"本地拼装"的仿制实现。

## 背景

`docs/superpowers/specs/2026-07-02-plugin-skill-support-design.md` 落地的 `/` 补全，是 Aide 早期为"技能自动补全"单独造的一套轻量实现：Rust `SkillRegistry` 扫描 `.claude/skills/*/SKILL.md`，前端命中后**自己读文件原文拼进 prompt**。这套实现和 Claude Agent SDK 真正的 slash commands 机制（`system/init` 消息里的 `slash_commands` 权威清单 + SDK 原生的 frontmatter 剥离/`$ARGUMENTS` 占位符替换/`allowed-tools` 限制/`!`bash`` 执行块）是两套独立系统，只是恰好都用 `/` 前缀，容易被误认为是一回事。

现状差距：

1. `agent-sidecar/src/mapper.ts` 收到 `system/init` 时只取了 `session_id`，SDK 回传的 `slash_commands` 字段被直接丢弃，前端拿不到"当前会话实际支持哪些命令"的权威信息。
2. `.claude/skills` 之外的命令——内置命令（`/compact`/`/clear`/`/context`/`/usage`）、旧版 `.claude/commands/*.md`——不会出现在下拉框里；用户手打这些命令时，虽然大概率能靠原样透传被 SDK 识别，但从未有人验证过，UI 上也没有任何反馈或入口。
3. 命中本地 skill 后，`ChatPanel.vue` 把 **整个 SKILL.md 原文（含 YAML frontmatter）** 读出来拼进 prompt，用户参数只是简单拼在 `---` 分隔符后面——frontmatter 里的控制信息（`allowed-tools`、`model` 等）被当作自然语言一起发给了模型，且不支持 `$ARGUMENTS`/`$0`/`$1` 占位符替换、不支持 `!`bash`` 执行块。

目标：让 slash commands 的发现和执行都以 SDK 为权威来源，本地拼装逻辑彻底退役；同时兼顾"会话还没开始时下拉框不能是空的"这个现实约束。

---

## 架构总览

```
新建空白会话（sidecar 还没起）
        ↓
useSlashCommands.ts 监听 workspacePath → api.scanPluginSkills()（沿用现有 Rust 扫描）
        ↓
下拉框显示本地扫描的富清单（name + description + source）── 仅限"会话未开始"阶段
        ↓
用户发出第一条消息（手打 / 下拉选中 / 点工具栏快捷按钮）
        ↓
Rust 起 sidecar → SDK 回 system/init（含 slash_commands: string[]）
        ↓
agent-sidecar/src/mapper.ts：emit session_init（不变）+ 新增 emit slash_commands_available
        ↓
src-tauri/src/sidecar.rs 无差别透传（已是通用 JSON passthrough，无需改动）
        ↓
useChatSession.ts 存入 store.slashCommands，作为 prop 传给 ChatPanel
        ↓
useSlashCommands.ts 切换数据源为 SDK 权威清单（纯命令名，不再有描述）── 单向切换，不回退
        ↓
发送路径：不管来源是手打/下拉选中/快捷按钮，一律 emit("send", 原始文本, {...})
        ↓
sidecar 原样透传给 SDK；frontmatter 剥离/占位符替换/allowed-tools/!bash 执行块由 SDK 原生处理
```

---

## 变更一：Sidecar 事件（Claude 专属逻辑，仅限 `agent-sidecar/`）

### `agent-sidecar/src/types.ts`

`ChatEvent` 新增一个变体，跟 `models_available`/`permission_modes_available` 同构（独立事件，而非塞进 `session_init`，保持 `session_init` 只管会话身份的单一职责）：

```typescript
| { type: "slash_commands_available"; commands: string[] }
```

### `agent-sidecar/src/mapper.ts`

```typescript
if (msg.type === "system" && msg.subtype === "init") {
  emit({ type: "session_init", session_id: msg.session_id });
  if (Array.isArray(msg.slash_commands)) {
    emit({ type: "slash_commands_available", commands: msg.slash_commands });
  }
  return;
}
```

**关键点**：用 `Array.isArray` 判断，不是简单真值判断——`undefined`（旧版 CLI/字段不存在）和 `[]`（SDK 明确返回空清单）是两种不同语义，前者不发事件（前端保持本地兜底），后者发空数组（前端如实显示空）。

---

## 变更二：Rust 层

**无需改动。** `src-tauri/src/sidecar.rs` 现有实现（约第 110-128 行）已经是通用 JSON 透传：只对 `type == "heartbeat"` 吞掉、对 `type == "session_init"` 特殊注入 `sdk_session_id`，其余类型（包括新增的 `slash_commands_available`）原样 `app.emit("chat-event", event)` 转发到前端，天然兼容新事件类型。

---

## 变更三：前端类型与事件消费

### `src/types/chat.ts`

镜像同一个 `ChatEvent` 变体（项目里 sidecar 类型和前端类型镜像的既有约定）：

```typescript
| { type: "slash_commands_available"; commands: string[] }
```

### `src/composables/useChatSession.ts`

每会话 store 新增字段 `slashCommands: string[] | null`（初始 `null`），`handleChatEvent` 新增分支：

```typescript
case "slash_commands_available": {
  store.slashCommands = e["commands"] as string[];
  break;
}
```

跟 `store.models`/`store.currentModel` 同一套"存入 store、作为 prop 传给 ChatPanel"模式。

---

## 变更四：新增 `useSlashCommands.ts`（独立模块）

职责单一：命令发现与数据源切换，不涉及发送逻辑。

```typescript
// src/composables/useSlashCommands.ts

/** useSlashCommands 对外暴露的下拉选项形状——纯 UI 派生数据，不进入
 *  核心 ChatEvent 协议，所以就近定义在这里，不放进 types/chat.ts。 */
export interface SlashCommandOption {
  name: string;
  description?: string;
}

export function useSlashCommands(
  workspacePath: Ref<string | undefined>,
  sdkCommands: ComputedRef<string[] | null>,
) {
  const localSkills = ref<SkillMeta[]>([]); // 会话未开始时的本地兜底（含描述）

  watch(workspacePath, async (ws) => {
    try {
      localSkills.value = await api.scanPluginSkills(ws ?? "");
    } catch {
      localSkills.value = [];
    }
  }, { immediate: true });

  /** 会话未开始（sdkCommands 为 null）→ 本地富清单；
   *  一旦本次会话收到过 SDK 权威清单 → 单向切换为纯命令名，不回退。 */
  const dropdownOptions = computed<SlashCommandOption[]>(() =>
    sdkCommands.value === null
      ? localSkills.value.map((s) => ({ name: s.name, description: s.description }))
      : sdkCommands.value.map((name) => ({ name })),
  );

  return { dropdownOptions };
}
```

### `src/components/ChatPanel.vue`

- 删除现有 `skillList`/`filteredSkills` 状态定义中直接依赖 `scanPluginSkills` 的部分，改为调用 `useSlashCommands(workspacePath, computed(() => props.slashCommands ?? null))`，`filteredSkills` 改为对 `dropdownOptions` 做过滤。
- 删除 `handleSend` 里的 `slashMatch` + `api.readFileContent` 拼接逻辑（约第 357-369 行）。发送前 `finalPrompt` 恒等于用户原始输入文本（`@path` 文件引用展开逻辑不变，那是独立机制，跟 slash command 无关）。
- `selectSkill` 保留"选中后把 `/name ` 填入输入框"的交互，只是不再读文件内容。

---

## 变更五：新增 `useQuickActions.ts`（工具栏快捷操作，扩展点）

独立注册表模块，仿照 `src/composables/useSearchProviders.ts`（标题栏搜索源注册表）的模式：

```typescript
// src/composables/useQuickActions.ts
export interface QuickAction {
  id: string;
  label: string;
  prompt: string;
}

const defaultActions: QuickAction[] = [
  { id: "compact", label: "压缩上下文", prompt: "/compact" },
  { id: "clear", label: "清空上下文", prompt: "/clear" },
];

/** 当前仅返回默认注册表；预留 register/unregister 扩展点，
 *  未来"自定义工具栏"功能落地时在此加注册函数，ChatPanel 不用改。 */
export function useQuickActions() {
  const actions = ref<QuickAction[]>(defaultActions);
  return { actions };
}
```

`ChatPanel.vue` 工具栏渲染 `useQuickActions().actions`，每个按钮点击直接 `emit("send", action.prompt, {...})`——跟手打消息走同一条发送路径（遵守忙碌排队，无需特殊分支）。点击行为是直接发送，不做二次确认（`/compact`/`/clear` 都不破坏磁盘上的历史数据）。

---

## 错误处理

| 场景 | 处理 |
|------|------|
| SDK 不支持该字段（旧版 CLI，或 provider 没有这个概念） | mapper 不发 `slash_commands_available`；`store.slashCommands` 保持 `null`，下拉框永远停留在本地兜底清单，优雅降级 |
| SDK 明确返回空数组 | mapper 正常发 `commands: []`；下拉框如实显示空（区别于上一行，靠 `Array.isArray` 严格区分） |
| sidecar 进程中途重启（现有错误恢复循环） | 重连后自然重新收到 `system/init`，事件重新广播，无需特殊处理 |
| 快捷按钮点击时会话忙碌 | 走现有 `isBusy` 排队机制，跟手打消息一致 |
| `/compact` 历史不足两轮 | SDK 自身返回 `success` 结果和提示文字，非错误，按普通助手消息展示 |
| 用户手打的 `/xxx` 不在任何下拉清单里 | 原样发送，交给 SDK 自行判断是否识别（本次改动后不再有"命中本地清单就读文件注入"的分支，无论命中与否都是原样发送） |

---

## 测试

- `agent-sidecar`（`mapper.ts`）：
  - `system/init` 且 `slash_commands` 是数组 → 断言同时发出 `session_init` 和 `slash_commands_available`，内容一致。
  - `system/init` 但字段缺失/非数组 → 断言只发 `session_init`。
- 前端（`useSlashCommands.ts`）：
  - 初始（`sdkCommands` 为 `null`）→ `dropdownOptions` 来自本地扫描，含 description。
  - `sdkCommands` 变为非 null 后 → 切换为纯命令名，且此后 `workspacePath` 再变化也不回退。
- 前端（`useQuickActions.ts`）：默认注册表包含 `compact`/`clear`，形状稳定。
- `ChatPanel.vue`：断言发送前不再触发 `api.readFileContent`，`finalPrompt` 恒等于用户原始输入。
- 人工验证（不在自动化测试范围）：真实跑一次 sidecar，确认点击工具栏按钮和手打 `/compact`/`/clear` 都被 SDK 正确执行。

---

## 涉及文件汇总

| 文件 | 类型 | 说明 |
|------|------|------|
| `agent-sidecar/src/types.ts` | 修改 | `ChatEvent` 加 `slash_commands_available` 变体 |
| `agent-sidecar/src/mapper.ts` | 修改 | `system/init` 分支多发一条新事件 |
| `src/types/chat.ts` | 修改 | 镜像 `ChatEvent` 变体 |
| `src/composables/useChatSession.ts` | 修改 | `store.slashCommands` 字段 + 新 `case` 分支 |
| `src/composables/useSlashCommands.ts` | 新增 | 命令发现与数据源切换 |
| `src/composables/useQuickActions.ts` | 新增 | 工具栏快捷操作注册表（扩展点） |
| `src/components/ChatPanel.vue` | 修改 | 删除本地拼装逻辑，接入两个新 composable，工具栏加快捷按钮 |

---

## 不在本次范围内

- 自定义工具栏 UI（增删排序快捷操作的设置界面）——`useQuickActions.ts` 只留扩展点，不实现
- 旧版 `.claude/commands/*.md` 的本地扫描支持（如果 SDK 权威清单本身包含这些命令，本次改动后能自动被发现；如果需要在"会话未开始"阶段也展示，属于后续需求）
- 其他 provider 的 slash commands 支持（`commands: string[]` 留空数组即可安全降级，具体接入待未来真正接入非 Claude provider 时再做）
- `/` 命令的键盘快捷键帮助浮层
