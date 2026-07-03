# 任务进度展示面板 — 设计

PLANS.md 新增待办项：接住 Claude Agent SDK 的 Task 工具（`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList`），在聊天界面里做一个实时更新的任务清单，并为未来接入其他 agent provider 预留同样的展示能力。

## 背景

官方文档（`https://docs.claude.com/.../todo-tracking`）确认：TypeScript Agent SDK ≥0.3.142 起，默认用结构化的 Task 工具（`TaskCreate` 建项、`TaskUpdate` 按 `taskId` 打补丁、`TaskGet`/`TaskList` 供模型读取现状）取代旧的单一 `TodoWrite` 调用，除非显式设置 `CLAUDE_CODE_ENABLE_TASKS=0`。

核对当前项目状态：
- `agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk` 实际安装版本是 **0.3.197**，早已过了迁移阈值；代码里也没有设置 `CLAUDE_CODE_ENABLE_TASKS`。也就是说会话里跑的就是 Task 工具，不是 `TodoWrite`。
- `agent-sidecar/src/{types.ts,mapper.ts,permissions.ts}` 和 `src/components/ToolCallBlock.vue` 目前对这两种工具（无论新旧）**都没有任何特殊处理**——所有 tool_use 统一走 `ChatEvent.tool_use_start`/`tool_result`，前端渲染成通用工具卡片，用户看到的是原始 `input` JSON，看不出这是一个待办清单操作。
- SDK 另外还有一套 `SDKTaskStartedMessage`/`SDKTaskUpdatedMessage`/hooks（`TaskCreated`/`TaskCompleted`）的系统消息，命名很像但其实是**另一个功能**——后台/子代理任务追踪（状态是 `running`/`failed`/`killed`/`paused`，配合 `backgroundTasks()`/`stopTask()`），跟这里要做的待办清单（`pending`/`in_progress`/`completed`）无关，不能拿来复用。SDK 也没有暴露"读取当前任务清单"的宿主端方法（没有 `getTasks`/`listTasks` 之类的 API），唯一的观测途径就是拦截消息流里的 `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList` 工具调用，这与文档描述的监控方式一致。
- `src-tauri/src/sidecar.rs:103-113` 把 sidecar 每行 stdout 反序列化成不带类型的 `serde_json::Value`，只插入 `session_id`（和 `session_init` 时的 `sdk_session_id`），原样通过 `chat-event` 转发给前端，从不关心具体 `type`。**这个功能不需要改动 Rust 层**，只涉及 `agent-sidecar/` 和前端两层。

## 方案：agent-sidecar 内部累加 Task 工具状态 → 发一个 provider-agnostic 的全量快照事件

`TaskCreate` 的 `taskId`只在它的 `tool_result` 里才揭晓（`{task:{id,subject}}`），`TaskUpdate` 又要按这个 id 去改状态——这意味着"任务清单"是跨多次工具调用累积出来的会话级状态，不是像 `Edit` 那样能从单次 `input` 直接算出来的东西。所以不能照搬 Edit diff 那种"纯 ToolCallBlock.vue 内计算"的做法，需要一个专门维护 `Map<taskId, TaskItem>` 的累加器。

维持项目"Claude 专属逻辑只能待在 agent-sidecar"的红线：这个累加器（新文件 `agent-sidecar/src/tasks.ts`）知道 `TaskCreate`/`TaskUpdate` 这些工具名字，但对外只吐出一个通用事件：

```ts
// agent-sidecar/src/types.ts 与 src/types/chat.ts 都要加（镜像约定）
export interface TaskItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string; // 进行中时展示的动词短语，如"正在优化性能"
}
```

`ChatEvent` 新增一支：`{ type: "tasks_update"; tasks: TaskItem[] }`。每次状态有真实变化就发一次**全量快照**（不是增量 patch），这跟现有 `context_usage`/`models_available` 的约定完全一致——前端消费方式也保持一样简单：`store.tasks = e.tasks` 整体覆盖，不用维护归约逻辑。

`TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList` 这 4 个工具名从此**不再**产生通用的 `tool_use_start`/`tool_result` 事件——mapper 层直接把它们的 tool_use 和 tool_result 都路由给 `TaskTracker`，不转发给前端。这带来两个好处：前端永远不会看到 `"TaskCreate"` 这种 Anthropic 专属字符串（符合多 provider 抽象红线），也自然避免了消息流里出现一堆低信息量的原始 JSON 卡片——现在有了专门的实时面板，这些卡片除了重复信息不再有别的价值。

前端只新增一个组件 `TaskListPanel.vue`，挂在 `ChatPanel.vue` 的消息列表上方，任务清单非空时才显示。它不进消息流、不随消息滚动，始终反映"当前"状态（如果全部任务完成，清单依然展示，直到下一轮新任务把它替换/清空——不做自动淡出动画，保持 v1 简单）。

## 改动范围

### `agent-sidecar/src/types.ts`
- 新增 `TaskItem` interface（如上）。
- `ChatEvent` 联合类型新增 `| { type: "tasks_update"; tasks: TaskItem[] }`。

### `agent-sidecar/src/tasks.ts`（新建）
仿照 `permissions.ts` 的 class 风格：

```ts
const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskUpdate", "TaskGet", "TaskList"]);

export class TaskTracker {
  private tasks = new Map<string, TaskItem>();
  private pendingCreates = new Map<string, { subject: string; activeForm?: string }>();
  /** 记录这 4 个工具的 tool_use_id，好在 tool_result 阶段判断要不要吞掉这条结果。 */
  private trackedIds = new Set<string>();

  static isTaskTool(name: string): boolean {
    return TASK_TOOL_NAMES.has(name);
  }

  /** 返回 true 时 mapper 应该发一次 tasks_update 快照。方法体行为见下方"行为细节"。 */
  handleToolUse(id: string, name: string, input: unknown): boolean;

  /** tracked=false 表示这不是任务工具的结果，mapper 应照旧转发通用 tool_result；
   *  changed=true 表示状态变了，mapper 应该发一次快照。方法体行为见下方"行为细节"。 */
  handleToolResult(id: string, content: string): { tracked: boolean; changed: boolean };

  snapshot(): TaskItem[] {
    return [...this.tasks.values()];
  }
}
```

行为细节：
- `TaskCreate`：暂存到 `pendingCreates`（防御性读 `input.subject`/`input.activeForm`，缺失时留空字符串/undefined），此时还不知道 `taskId`，不产生变化。
- `TaskUpdate`：防御性读 `taskId`（`input.taskId ?? input.id ?? input.task_id`，对应文档里提到的"流式 tool_use 输入里字段名不一定规范"）。若该 id 不在 `tasks` 里（未见过的 id），静默丢弃。`status === "deleted"` 时整条删除；否则只在 `status` 是 `"pending"`/`"in_progress"`/`"completed"` 三者之一时才写入（其余未知字符串忽略，保持 `TaskItem.status` 的类型不被破坏），`subject`/`activeForm`（`activeForm`/`active_form` 都读）只在对应字段是字符串时才覆盖。
- `TaskGet`/`TaskList`：只读操作，`handleToolUse` 不产生变化；但 id 依然要记入 `trackedIds`，因为它们的 `tool_result` 也要被吞掉（否则前端会收到一张"TaskList 的原始返回内容"卡片，同样违反 provider-agnostic 红线）。
- `handleToolResult`：先 `trackedIds.delete(id)` 判断是否属于这 4 个工具；若不是，`tracked:false` 直接返回让 mapper 照常转发。若是且该 id 在 `pendingCreates` 里（即一个 `TaskCreate` 的结果），尝试 `JSON.parse(content)` 拿 `task.id`/`task.subject`，成功则写入 `tasks` map（初始 `status: "pending"`），`changed:true`；解析失败时静默丢弃（`changed:false`），不让格式意外中断主对话流。若是但不在 `pendingCreates` 里（`TaskUpdate`/`TaskGet`/`TaskList` 的结果），`tracked:true, changed:false`——纯粹吞掉。

### `agent-sidecar/src/mapper.ts`
- `mapSdkMessage` 签名新增第三个参数 `tasks: TaskTracker`。
- assistant 消息里的 `tool_use` 分支：`TaskTracker.isTaskTool(block.name)` 为真时调用 `tasks.handleToolUse(...)`，返回 `true` 就 `emit({type:"tasks_update", tasks: tasks.snapshot()})`；否则维持现有 `emit({type:"tool_use_start", ...})` 不变。
- user 消息里的 `tool_result` 分支：调用 `tasks.handleToolResult(block.tool_use_id, content)`；`changed` 为真就发快照；`tracked` 为假才照旧 `emit({type:"tool_result", ...})`。

### `agent-sidecar/src/index.ts`
- 新增 `const taskTracker = new TaskTracker();`（模块级，跟 `permMgr` 一样，一个 sidecar 进程对应一个会话，生命周期自然对齐——重连/新开会话会启动新进程，任务清单从空开始，符合"不做跨重启持久化"的范围边界）。
- `mapSdkMessage(msg, emit)` 调用处改为 `mapSdkMessage(msg, emit, taskTracker)`。

### `src/types/chat.ts`
- 镜像新增 `TaskItem` interface。

### `src/composables/useChatSession.ts`
- `SessionStore` interface 新增 `tasks: TaskItem[]`；`getStore` 初始化处新增 `tasks: []`。
- `handleChatEvent` 新增 `case "tasks_update": { store.tasks = e["tasks"] as TaskItem[]; break; }`（整体覆盖，不做增量合并，跟 `contextUsage`/`currentModel` 的处理方式一致）。
- 返回对象新增 `tasks: computed(() => current.value?.tasks ?? [])`。

### `src/components/TaskListPanel.vue`（新建）
- Props：`tasks: TaskItem[]`。
- 每项按 `status` 显示图标（`pending` 空心方块 / `in_progress` 🔧 / `completed` ✅）+ 文本（`in_progress` 且有 `activeForm` 时显示 `activeForm`，否则显示 `subject`）。
- 样式复用项目已有的 `--aide-success`/`--aide-text-muted` 等设计 token，不引入新配色体系。

### `src/components/ChatPanel.vue`
- 新增 prop `tasks: TaskItem[]`（默认 `[]`）。
- 模板里 `.chat-header` 和 `.chat-messages` 之间新增 `<TaskListPanel v-if="tasks.length" :tasks="tasks" />`。

### `src/App.vue`
- 从 `useChatSession(...)` 的返回值里多解构一个 `tasks`，传给 `<ChatPanel :tasks="tasks" ...>`（照抄 524 行 `:context-usage="contextUsage"` 的现有写法）。

## 边界情况

- **`TaskUpdate` 引用了未见过的 `taskId`**（比如对应 `TaskCreate` 的 `tool_result` 因为某种原因还没被处理）：静默丢弃这次更新，不报错、不创建"幽灵任务项"。
- **`tool_result` 的 `content` 不是合法 JSON 或缺少 `task.id`**：`handleToolResult` 捕获异常返回 `changed:false`，这次 create 静默失效（清单里不会出现这一项），不影响后续对话。
- **同一轮里连续多个 `TaskCreate`**：各自独立存在 `pendingCreates`（按各自的 `tool_use_id` 区分），互不干扰。
- **续接历史会话（resume）**：`TaskTracker` 是新 sidecar 进程里新建的，历史任务状态不会恢复，清单从空开始——这是本设计明确接受的限制（见下一节）。
- **`TaskGet`/`TaskList` 的结果**：被吞掉但不触发快照更新，因为这两个是模型的只读查询，不代表状态变化。

## 范围边界（明确不做）

- 不做任务清单跨会话 resume / 应用重启的持久化，只在当前 sidecar 进程存活期间维护内存态。
- 不处理旧版 `TodoWrite`（当前 SDK 版本已默认关闭，代码里也没有设置 `CLAUDE_CODE_ENABLE_TASKS=0` 去启用它）。
- 不在面板里做任务的增删改交互（比如手动勾选完成）——这个清单纯展示模型自己的进度，不是可编辑的待办列表。
- 不做清单自动折叠/淡出动画，全部完成后清单原样保留，直到下一轮新任务把它替换。
- 不改动 Rust 层（`sidecar.rs`/`chat.rs`）——已确认 Rust 侧完全 passthrough，不需要感知新事件类型。

## 测试

纯前端 + sidecar 展示层，手动验证：
- 触发一个需要多步骤的任务（"帮我做 A、B、C 三件事"），确认面板实时出现三项，状态从 pending → in_progress → completed 依次变化，图标和文案同步更新。
- 消息流里确认不再出现 `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList` 的原始工具卡片。
- 其他工具（`Bash`/`Read`/`Edit` 等）的卡片渲染行为不受影响（回归）。
- 中断/新建会话后旧任务清单被正确清空（对应"不持久化"的设计）。
- 构造一个格式异常场景（如果可以在测试环境下模拟 `tool_result` 解析失败）确认不会导致整个对话渲染中断。
