# /btw 支线子对话 — 设计规格

> 状态:草案待评审
> 日期:2026-07-15
> 原型:`_design_preview/btw-side-conversation.html`
> 关联架构:[docs/ARCHITECTURE.md](../../ARCHITECTURE.md)

## 1. 目标与一句话定义

主对话正在思考/执行时,用户想"顺便问一下"一个支线问题——它需要能看懂主对话在做什么,但不污染主对话上下文、不阻塞主对话、跑完只把结论以一条小批注回插主对话,且消耗极少 token。

**一句话**:用户在主对话发送按钮下拉里切到"顺便问一下",输入支线问题并发送;系统从主对话当前状态 **fork** 一个独立 sidecar 进程跑这个支线,来回不回写主对话、不进主对话 SDK 上下文;跑完以一条**页边批注**(默认折叠、前端可见、不进 resume 上下文)插入主对话末尾;支线阅后即弃(不落盘、不能重开)。

## 2. 需求决策(已与用户确认)

| 维度 | 决策 |
|---|---|
| 上下文来源 | **fork 主对话当前快照**(SDK `forkSession: true`)。支线能看懂主对话在做什么。 |
| 结论呈现 | **独立抽屉面板 + 页边批注回插主对话**。批注前端可见、**不计入主对话 SDK resume 上下文**。 |
| 生命周期 | **阅后即弃**:跑完/关闭/切主会话/停止 → kill 进程、丢 store、不落盘、不能重开。 |
| 能力 | **默认轻量**(禁工具、只读权限);启动时可在抽屉切"完整"(继承主对话工具集/权限模式)。能力仅启动时生效,已开跑不改。 |
| 并发 | v1 **同一时间一个 btw**:新开会关掉旧的(kill 进程)。 |
| 触发方式 | **发送按钮分裂项下拉切换**,不手输 `/btw` 前缀。btw 是**一次性**:发送后自动切回主对话输入(视觉突出)。 |
| Provider | 仅支持 Claude Agent SDK(经 `pathToClaudeCodeExecutable` spawn 的原生 CLI 二进制)。Claude 专属逻辑只落在 `agent-sidecar/`,前端/Rust 仍走 `ChatEvent`/`SidecarCommand` 协议。 |

## 3. 架构红线对齐

- **跨平台**:新 sidecar spawn 沿用 `CREATE_NO_WINDOW (0x08000000)`(Windows)与 `dunce::simplified()` 剥 `\\?\` 前缀(传给 node 的资源路径),与现有 `sidecar.rs` 一致。
- **多 provider 抽象**:用户已明确后续只支持 Claude Agent SDK,不再为 OpenAI/Gemini 维持 agnostic 协议。但**仍保持"Claude 专属只在 sidecar、前端/Rust 走统一协议"的分层**——`forkSession` 是 Claude SDK 能力,由 sidecar 解释;Rust/前端只发一个语义中性的 `start_btw` 指令(带 `fork_from`),不感知 forkSession 细节。这样新 provider 接入时只需在各自 sidecar 实现"如何 fork"。
- **同步命令禁重 IO/CPU**:`start_btw_session` spawn 子进程,**必须 async**(spawn + stdin 写都是 IO,绝不能放主线程)。命令体第一行可埋 `diagnostics::trace_command`(但 async 命令的 guard 在 dispatch 后即 drop,按 CLAUDE.md 约定 async 命令不埋 trace,这里 spawn 走 `spawn_blocking` 之外,实际进程 spawn 在 sidecar 管理器内)。
- **事件出口过 delta 合并层**:btw sidecar 的 stdout 事件**必须**经 `deltaCoalescer`,禁止绕过直写 stdout。
- **主题**:抽屉、批注块、横幅、下拉菜单全部用 `--aide-*` token,禁止硬编码颜色。

## 4. 端到端数据流

```
用户在发送按钮下拉切"顺便问一下" → 输入框进入 btw 模式(横幅 + 高亮 + 按钮=↳顺便问)
用户打字、回车
  ↓
前端 useChatSession.sendMessage 检测 mode==='btw' → 走 btw 旁路(不进主 store.queued):
  1. 生成 btw 临时 session id = crypto.randomUUID(),记入 pendingSids(沿用延迟创建语义,不落盘)
  2. 调 Tauri 命令 start_btw_session({ fork_from: <主 sid>, prompt, cwd, lightweight, permission_mode? })
  3. 发送后立即 setBtwMode(false):横幅收起、输入框 accent 闪烁回弹、提示"已切回主对话输入"
  ↓
Rust start_btw_session(async):
  1. SidecarManager::spawn(btw_id) 新进程,env 与主 sidecar 一致(AIDE_ENABLED_PLUGINS_FILE / AIDE_CLAUDE_EXE 等)
  2. 首条 send 命令带:session_id=<主 sid>, forkSession=true(触发 sidecar 已有 shouldForkNextConnect/pendingFork 机制)
     - lightweight=true 时额外带 allowed_tools=[]、permission_mode='default'(只读)
     - lightweight=false 时带主对话当前的 permission_mode(继承)、不传 allowed_tools 限制
  ↓
agent-sidecar 收到首条 send:
  1. startLoop 时因 forkSession=true → query({ resume: <主 sid>, forkSession: true, ... })
  2. SDK 从主会话当前持久化状态 fork 出新 session,带主上下文副本开跑;主会话 JSONL 不被改动
  3. session_init 事件带回新的 fork session id
  ↓
Rust reader task:btw 进程的 ChatEvent 注入 bt w_id 后 emit("chat-event", event)(与主对话同一事件出口、同一 delta 层)
  ↓
前端 handleChatEvent:按 session_id 路由到独立的 btw SessionStore(由 useBtwSession 管理),渲染到抽屉
  ↓
btw message_stop:
  1. 取 btw 最终 assistant 文本 → 组装成 ActionBlock(actionId='btw', label=问题摘要, icon='↳') + 折叠体(结论文本 + "不进上下文"提示)
  2. 插入主对话 store.messages 末尾(前端可见)
  3. 抽屉底部显示"已作为批注插入主对话" + 关闭按钮;抽屉内容保留可读
  ↓
清理(任一触发):用户点关闭 / 切换主会话 / 点停止
  → SidecarManager::kill(btw_id)、丢 btw store、抽屉关闭
  → fork session JSONL:btw 启动时 persistSession=false,不落盘,无孤儿文件
  → 已回插主对话的批注不丢
```

**不阻塞**:btw 是独立进程 + 独立 store;主对话照常跑/排队。btw 消息走旁路 dispatch,**不进主 `store.queued`**。

**隔离**:fork 的上下文副本与主隔离,来回不回写主对话;结论只以 ActionBlock 形式前端可见、不进主 SDK 上下文。

## 5. 组件拆解

### 5.1 `agent-sidecar/`(Claude 专属)

**`src/index.ts`**
- 首条 send 带 `forkSession: true` + `session_id`(resume)的路径**已存在**(`shouldForkNextConnect`/`pendingFork`)。无需改动主流程,只需让新 `start_btw` 命令正确设置这两者。
- `persistSession: false`:btw 会话的 `query()` options 需设 `persistSession: false`,避免 fork session 落盘。在 sidecar 启动参数中带一个 `btw: true` 标记,sidecar 据此在 `query()` options 设 `persistSession: false`(并跳过 `renameSession`/落盘相关路径)。

**`src/types.ts`** — sidecar 命令层:**复用 `send` 命令,新增可选字段**(减少协议面):
```ts
// 在现有 send 命令上加可选字段
type SendCommand = {
  cmd: "send";
  prompt: string;
  session_id?: string;
  cwd?: string;
  permission_mode?: string;
  provider_switched?: boolean;
  jump_queue?: boolean;
  // btw 扩展(新增):
  fork_from?: string;       // 命中 → resume + forkSession:true
  lightweight?: boolean;    // true → allowedTools:[] + 只读权限
  btw?: boolean;            // true → persistSession:false + 跳过落盘/rename 路径
};
```
> 不新增 `start_btw` 命令类型。sidecar 在 `startLoop` 命中 `fork_from` 时走 fork 分支(`shouldForkNextConnect`/`pendingFork` 已有),按 `lightweight`/`btw` 调整 `query()` options(`allowedTools`/`permissionMode`/`persistSession`)。

**`src/generator.ts` / 队列**:btw 进程有自己的 `MessageQueue` + 自己的 `query()` 循环(独立进程,天然隔离)。无需多路复用。

**`src/deltaCoalescer.ts`**:btw 进程 emit 链同样经 DeltaCoalescer,**禁止绕过**。

### 5.2 `src-tauri/`(Rust)

**`src/sidecar.rs` — `SidecarManager`**
- `spawn()` 已支持 spawn 新进程并注册到 `sessions` HashMap。btw 复用同一路径,session id 用前端生成的 btw 临时 id。
- 无需新方法;`send(btw_id, cmd)` 写首条 `start_btw`(或带 fork 字段的 `send`)命令即可。
- `kill(btw_id)` 已存在,清理用。
- 进程 spawn 的 env / `CREATE_NO_WINDOW` / `dunce::simplified` 沿用现有逻辑,无需改动。
- **session_init 处理**:btw fork 出来的新 session id 经 `session_init` 回来后,`rename_sidecar_session` 把注册表 key 从临时 id 改为 fork id——与主对话的 `finalizeSession` 路径一致。btw 侧也走同样的 rename(内存操作,无 IO)。

**`src/commands/chat.rs`** — 新增 async 命令:
```rust
#[tauri::command]
async fn start_btw_session(
    sidecar_mgr: State<'_, SidecarManager>,
    // provider 等 state 以 Arc clone 方式 move 进 spawn_blocking(见 CLAUDE.md async 坑点2)
    fork_from: String,
    prompt: String,
    cwd: String,
    lightweight: bool,
    permission_mode: Option<String>,
    images: Option<Vec<String>>,
) -> Result<String, String> {
    // 1. 生成/接收 btw session id(由前端生成传入,或此处生成返回)
    // 2. 若 !sidecar_mgr.has_session(fork_from) → 报错(主会话必须存活才能 fork)
    // 3. spawn btw sidecar 进程(复用 spawn,env 同主)
    // 4. 发首条带 fork 字段的 send 命令给 sidecar(见 §5.1,sidecar 命令层复用 send)
    // 5. 返回 btw session id
}
```
- **async 理由**:spawn 子进程 + stdin 写是 IO,必须 async。`State<T>` 不能跨 `spawn_blocking` → 把需要的 state 注册成 `Arc<T>`(`lib.rs` 已是 `Arc` 模式),命令内 `state.inner().clone()` 再 move 进闭包。
- **不埋 `trace_command`**:按 CLAUDE.md 约定,async 命令的 guard 在 dispatch 后即 drop,埋了也抓不到。
- 此处 `start_btw_session` 是 **Tauri 命令层**(前端↔Rust);它内部写给 sidecar 的仍是 §5.1 的 **sidecar 命令层**(复用 `send` + 字段)。两层命名独立,不冲突。
- 注册到 `lib.rs` 的 invoke_handler。

**`src/lib.rs`**:注册 `start_btw_session` 命令;无需新 managed state(复用 `SidecarManager`)。

### 5.3 `src/`(前端 Vue)

**`src/components/ChatPanel.vue` — 输入区**
- `ChatSendButton` 的 `▾` 下拉菜单(`Teleport` 菜单)新增一项 `顺便问一下`(icon `↳`),为**开关型**:点击切换 `btwMode` 状态(非粘性——发送后自动复位)。
- `btwMode` 状态提升到 `useChatSession`(或 `ChatPanel` 局部 ref + 传给 composer):控制输入框 `btw-mode` class、顶部 `btw-mode-banner`、发送主按钮文案/样式(`↳ 顺便问`)、placeholder。
- 发送后:`setBtwMode(false)` + `revert-flash` 动画 + `已切回主对话输入` toast。
- `sendMessage` 入口:当 `btwMode` 时,走 btw 旁路(调 `start_btw_session`)而非主 `dispatchSend`;**不进 `store.queued`**。

**`src/composables/useChatSession.ts`**
- `sendMessage` 新增分支:`if (btwMode) return sendBtw(...)`。
- `sendBtw`:生成 btw 临时 id → `pendingSids.add(id)` → `invoke('start_btw_session', {...})` → 立即复位 btwMode + 触发回弹视觉 → 不改主 `store.isBusy`/`sessionState`。
- `handleChatEvent`:事件按 `session_id` 路由。btw id 的事件路由到 `useBtwSession` 的 store,**不进主 store**。
- `finalizeSession`:btw 的 `session_init` 同样触发 rename(临时→fork id),但**不触发 `onSessionCreated`**(不写元数据、不进侧栏、不 `create_session`)——btw 是临时会话。

**`src/composables/useBtwSession.ts`**(新增)
- 镜像 `useChatSession` 的最小子集:一个 `btwStore`(messages、isBusy、conclusion)。
- `handleBtwEvent(event)`:处理 btw 的 `session_init`/`text_delta`/`tool_*`/`subagent_*`/`message_stop`/`error`/`session_dead`。
- `message_stop` → 提取最终 assistant 文本 → 调 `onBtwDone(question, conclusion)` 回调(由 `ChatPanel` 接收,插入主对话 ActionBlock)。
- `cleanup()`:kill 指示 + 清空 store。
- **一次一个**:`activeBtwId` 单值;新开时若已有,先 `cleanup()` 旧的。

**`src/types/chat.ts`**
- 复用 `ActionBlock`,扩展为可折叠批注(见 5.4)。

**`src/components/BtwDrawer.vue`**(新增)
- 右侧浮层抽屉(`position: absolute`,不进 grid,不挤占主对话)。
- 顶部 banner:`↳ 这条支线不进入主对话上下文` + `轻量 · 极少 token`。
- 标题区:`↳ 顺便问一下 · btw` + 副标题 + `轻量/完整` seg(仅启动前可切;开跑后禁用)+ `停止`/`关闭` 按钮。
- 消息流:btw 的流式输出。
- 完成态 foot:`已作为批注插入主对话` + `关闭`。
- 视觉:`--aide-bg-raised` + 左缘 accent 条 + `--aide-shadow-lg`,读起来是"浮层、另一层"。

### 5.4 页边批注块(回插主对话)

- 复用 `ActionBlock` 机制(前端可见、不进 SDK resume 上下文),但**扩展为可折叠**:
```ts
interface ActionBlock {
  type: "action";
  actionId: string;        // "btw"
  label: string;            // 问题摘要
  icon?: string;            // "↳"
  // 扩展(v1 新增,仅 btw 用):
  foldable?: boolean;       // true
  body?: string;            // 结论全文
  hint?: string;            // "不进上下文"
}
```
- 渲染:`ChatMessage.vue` 检测 `actionId==='btw'` 时,渲染为**页边批注**(右对齐、虚线 accent 边、默认折叠成一行小标签 `↳ btw · 问题… · 不进上下文`),展开看结论 + 提示。视觉权重远低于真实消息。
- **关键**:此 block 在主对话 `store.messages` 里存在(前端可见),但**主对话下次 `send` 时,前端构造发给 SDK 的 messages 不包含 action 块**(与现有 `/compact`/`/clear` 的 ActionBlock 处理一致——ActionBlock 本就不进 SDK resume)。

## 6. 错误处理

| 场景 | 处理 |
|---|---|
| 主会话不存在(`fork_from` 未存活) | `start_btw_session` 返回 Err;前端 toast"主对话未就绪,无法顺便问" |
| btw 进程 spawn 失败 | Rust 返回 Err;前端 toast;不插批注 |
| btw 跑中进程意外退出(`session_dead`/`error`) | 抽屉显示错误态(用 `--aide-danger`),保留已生成内容;**不插批注、不污染主对话**;提供"关闭" |
| 主对话在 btw 跑期间结束/切走 | 切主会话触发 btw cleanup(kill 进程);若 btw 已完成,批注已回插不丢;若未完成,丢弃(阅后即弃) |
| 未等到 `session_init`(进程崩溃) | 沿用 `pendingSids` 语义:不落盘、不留孤儿;cleanup 临时 id |
| fork 时机:主对话 mid-turn | fork 取主对话**当前持久化状态**,不含正在生成的部分;v1 接受此限制 |

## 7. 清理时机(明确)

btw 进程 + store 在以下任一触发时 kill/丢弃:
1. 用户点抽屉"关闭"。
2. 用户切换主会话(btw 绑定当前主会话)。
3. 用户点"停止"(跑中)。
4. btw 进程自身退出(异常/正常结束)。

**已回插主对话的批注不受清理影响**(它在主 store 里)。抽屉在 `message_stop` 后**保留可读**,直到上述清理触发——便于用户读完整结论/复制。

## 8. 视觉设计要点(见原型)

- **不污染的视觉语言**:抽屉=浮层(阴影 + 不同底色 + 左缘 accent 条 + `↳`),banner 显式写"不进入主对话上下文";回插=页边批注(虚线、小、默认折叠、视觉权重远低于消息)。
- **省 token 的视觉语言**:banner + 抽屉副标题强调"轻量 · 极少 token / 阅后即弃";默认 `轻量` 能力(禁工具);视觉权重更轻(细线、小字)。
- **模式切换的视觉突出**:btw 发送后→横幅收起→输入框 accent 闪烁回弹→"已切回主对话输入" toast。
- 全部 `--aide-*` token;三角箭头统一 14px。

## 9. 测试

- **单元**:`useBtwSession` 的事件路由(各 ChatEvent 类型)、`message_stop`→批注组装、cleanup 触发、一次一个的替换语义。
- **集成**:发 btw → 抽屉出流式 → `message_stop` → 主对话末尾出现批注(默认折叠)→ 展开看结论 → 主对话继续发消息时 SDK 收到的 messages **不含** btw 批注。
- **隔离**:btw 跑期间主对话继续排队/插队正常;btw 进程 kill 不影响主对话 sidecar。
- **不落盘**:btw 结束后磁盘无新 JSONL(`persistSession: false`);切主会话后再切回,btw 不复现。
- **跨平台**:Windows 下 spawn 不弹窗(`CREATE_NO_WINDOW`);release 资源路径 `dunce::simplified`。
- **视觉**:对照原型,抽屉/批注/横幅/下拉/回弹动画 token 一致。

## 10. 范围与取舍(v1)

- **v1 只做**:单 btw、轻量默认 + 完整可选、fork 当前持久化状态、批注回插、阅后即弃。
- **v1 不做**:多个并行 btw、btw 内再 fork、btw 持久化/重开、btw 带 `images` 的完整支持(协议预留字段,实现可后置)、fork 主对话 mid-turn 正在生成的内容。
- **不在本 spec**:把整个 app 从 Agent SDK 迁到自研 Messages API loop(那是独立大议题,见 §2 provider 决策)。

## 11. 未决/实现时确认

- `start_btw` 命令 vs 复用 `send` 加字段——实现时选"少协议面"方案(倾向复用 `send` + 可选 `fork_from`/`lightweight`/`btw`)。
- 批注块的 `ActionBlock` 扩展是否影响现有 `/compact`/`/clear` 渲染——需保证 `actionId!=='btw'` 走原药丸胶囊路径,仅 `btw` 走折叠批注。
- `permission_mode` 在 lightweight=false 时的继承来源(从主对话 store 的 `currentPermissionMode` 透传)。