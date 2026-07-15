# 发送按钮上下文菜单（压缩 / 清空上下文）设计

日期：2026-07-15

## 背景

工具栏现有两个独立按钮「压缩上下文」(`/compact`)、「清空上下文」(`/clear`)，点击后把斜杠命令当普通 prompt 文本发出去，在对话里渲染成一条内容为 `/compact` 的普通用户文本气泡。SDK 内部拦截为 local slash command，回 `local_command_output`（如「已清空上下文。」）。

目标：把这两个操作从「工具栏独立按钮」改成「挂在发送按钮上的向上下拉菜单」，并在对话里以**动作胶囊气泡**的形式呈现——底层仍走 `/compact`、`/clear` 专用命令，但用户侧看到的是一次有意义的操作而非随手打的斜杠命令。

## 需求（已与用户确认）

1. 发送按钮做成分裂按钮：主体「发送 ↑」点击 = 正常发消息；右侧小箭头 `▾` 点击 = **向上**弹出菜单。
2. 菜单项：「压缩上下文」「清空上下文」。
3. 选中后以**用户侧消息气泡**形式出现在对话里，气泡样式为带图标的**动作胶囊**（视觉上区别于普通发言）。
4. 底层走专用命令路径（仍发 `/compact`、`/clear`），显示与命令解耦。
5. 移除工具栏里现有的两个独立按钮，入口统一到分裂菜单。
6. 仅「清空上下文」执行前弹 `useModal.confirm` 确认（不可逆）；压缩不弹。

## 架构边界

- **IPC / sidecar / Rust 零改动**：`/compact`、`/clear` 仍按 `cmd:"send"` 普通文本发送，SDK 内部拦截。`SidecarCommand`、`ChatEvent`、`chat.rs` 不动。
- **胶囊渲染是纯前端展示 concerns**：新增的 `ActionBlock` 类型只存在于前端 `types/chat.ts`，不进 IPC 协议，符合 provider-agnostic 红线——未来其他 provider 的 sidecar 同样输出 `/compact` 文本即可，无需感知「动作」概念。

## 文件改动

### 新增 `src/components/ChatSendButton.vue`

独立分裂按钮组件，不在 `ChatPanel.vue` 内堆代码。

- 左侧主体「发送 ↑」：点击 emit `send` 事件（正常发消息）。
- 右侧 `▾`：点击 toggle 向上弹出菜单。
- 菜单项数据来自 `useQuickActions()`（`id / label / prompt / icon / confirm`）。UI 与数据分离，将来加动作只改 `useQuickActions.ts`。
- 弹出层：`Teleport to="body"` + `position:fixed`，复用 `ThemedSelect.vue` 已验证的「空间不足自动向上」定位逻辑；`z-index: 9999`。
- 关闭时机：选中某项后、点外部、按 Esc。
- `▾` 始终可用（即使输入框空也能压缩/清空）；主体「发送」的可用态沿用原发送按钮逻辑（输入空时禁用）。
- 颜色/边框/圆角/间距全部 `var(--aide-*)`，禁止硬编码 hex。
- 主体按钮 emit `send`；菜单项 emit `select(action: QuickAction)`，由 `ChatPanel.vue` 接收后走分发流程（含确认网关）。

### `src/types/chat.ts`

`ContentBlock` 联合新增：

```ts
export interface ActionBlock {
  type: "action";
  actionId: string;   // "compact" | "clear" | ...
  label: string;      // 胶囊显示文本
  icon?: string;      // 胶囊图标，可选
}
```

### `src/components/ChatMessage.vue`

在用户消息 blocks 渲染分支中，遇到 `ActionBlock` 时渲染为动作胶囊（见「胶囊样式」），不走 markdown 文本渲染。

### `src/components/ChatPanel.vue`

- 用 `<ChatSendButton>` 替换原发送按钮。
- **移除** `chat-quick-actions` 两个独立按钮及容器（约 602-611 行）。
- `handleQuickAction` 改造为接收 `ChatSendButton` 的 `select` 事件：若 `action.confirm` 为真，先 `useModal().confirm(...)`，确认后才 `emit("send", action.prompt, { action: { id, label, icon } })`；否则直接 emit。

### `src/composables/useQuickActions.ts`

```ts
export interface QuickAction {
  id: string;
  label: string;
  prompt: string;
  icon?: string;
  confirm?: boolean;
}

const actions: QuickAction[] = [
  { id: "compact", label: "压缩上下文", prompt: "/compact", icon: "✦" },
  { id: "clear",   label: "清空上下文", prompt: "/clear",   icon: "⌫", confirm: true },
];
```

### `src/composables/useChatSession.ts`

`SendOptions` 与 `QueuedSend` 各增可选字段：

```ts
action?: { id: string; label: string; icon?: string };
```

`action` 经 `SendOptions.action` 传入，`useChatSession` 入队时落到 `QueuedSend`（该结构同步增一个可选 `action` 字段）。`dispatchSend` 检测到 `item.action` 时：

- 推入 store 的用户消息 `blocks` 放一个 `ActionBlock`（`actionId=item.action.id`、`label`、`icon`），**不**放 `TextBlock(prompt)`。
- 发给 sidecar 的 `invoke("send_message", { prompt: action.prompt, ... })` 仍传原始 `/compact`|`/clear`。

显示与命令解耦：胶囊给用户看，斜杠命令给 SDK 执行。

## 数据流

1. 用户点 `▾` → `ChatSendButton` 向上弹菜单。
2. 选中「清空上下文」→ emit `select(clearAction)` → `ChatPanel.handleQuickAction` 见 `confirm:true` → `useModal.confirm("清空上下文", "将清空当前会话上下文，不可撤销。是否继续？")`。
   - 选「压缩上下文」无 confirm，直接下一步。
3. 确认后 `emit("send", action.prompt, { action: { id, label, icon } })`。
4. `useChatSession` 入队 → `dispatchSend`：
   - store.messages.push 一条 `role:"user"`、blocks=`[ActionBlock]` 的消息（胶囊气泡）。
   - `invoke("send_message", { prompt:"/clear"|"/compact", ... })`。
5. Rust `send_message` → sidecar `cmd:"send"` → SDK 拦截为 local slash command → `local_command_output` → `text_delta`（「已清空上下文。」）→ `message_stop`，作为助手侧文本回合正常渲染。

## 胶囊样式

- 形态：胶囊（`border-radius: 999px`），带图标 + 标签，如 `✦ 压缩上下文`。
- 配色：`background: color-mix`/半透明 accent 底 + `border:1px solid var(--aide-accent)` + `color: var(--aide-accent)`，区别于普通用户气泡（实心 accent 底白字）。具体 token 在实现时按 `--aide-accent`/`--aide-accent-*` 派生，不硬编码。
- 右对齐于用户消息列（与普通用户气泡一致 `msg-row--user`）。

## 边界与错误处理

- **会话未创建 / pending session**：与正常发消息同一入口，沿用 `useChatSession` 现有 pending session 逻辑，无需特判。
- **进程不在（stopped）**：`/compact`、`/clear` 仍走 `send_message`，由现有 sidecar 存活/重启逻辑处理；进程不在时按现有错误事件呈现。
- **确认弹窗取消**：不发消息、不入队、不推气泡，无副作用。
- **并发 / 生成中（running）**：与正常发消息一致，受现有排队 / jumpQueue 语义约束；菜单项点击走同一 dispatch 路径。

## 持久化

`ActionBlock` 作为 blocks 数组元素随会话经 `useConversationChanges.captureChanges` → `save_session_changes` 序列化落盘；`load_messages` 读回时仍是合法 `ContentBlock`，胶囊重载后照常渲染。实现时需验证 `ActionBlock` 的 JSON 往返（类型判别字段 `type:"action"` 完整保留）。

## 测试

- `useQuickActions`：actions 列表含 compact/clear，clear 带 `confirm:true`。
- `ChatSendButton`：主体点击 emit `send`；`▾` toggle 菜单；选中 emit `select`；外部点击/Esc/选中后关闭；菜单向上定位。
- `ChatPanel.handleQuickAction`：confirm 动作先弹窗，取消则不 emit；非 confirm 直接 emit；emit 的 payload 带 `action` 且 `prompt` 为原始斜杠命令。
- `useChatSession.dispatchSend`：带 `action` 时推 `ActionBlock` 气泡且 `send_message` 的 prompt 仍为 `/compact`|`/clear`。
- `ChatMessage`：`ActionBlock` 渲染为胶囊，非 markdown 文本。
- 持久化往返：保存含 `ActionBlock` 的会话 → 重载 → 胶囊仍渲染。

## 不做（YAGNI）

- 不造通用 `PopoverMenu` 组件（当前只有一个消费者）。
- 不新增 sidecar 命令 / IPC 字段。
- 不给 `/compact` 加确认（可逆）。
- 不改动助手侧 `local_command_output` 的渲染。