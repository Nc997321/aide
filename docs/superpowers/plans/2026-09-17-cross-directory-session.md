# 单会话跨目录工作（@目录即授权）实现计划

> **给执行者**：动手前先读「关键事实」（F1–F9）与文末「复核修订记录」「spike 实测」。**F6 会改变你对"何时生效"的预期**（query 全会话只 spawn 一次）。
> 状态：**方案已核对（2026-09-17 复核修订）；spike S1/S2 已实测通过**（脚本 `agent-sidecar/smoke-attach-dirs.ts`，可复跑），S4 余下部分转 Rust 单测。尚未动手写产品代码。
> 实现阶段 REQUIRED：按「分阶段落地」执行；每阶段完成后按提交前验证预算跑触碰的套件。

**Goal:** 一个会话挂多个目录——前端仓 + 后端仓一起改。用户在输入框打 `@C:\path\to\backend`（或文件树「添加到对话」），该目录获得访问权，且它的记忆（CLAUDE.md + auto memory）一并进上下文。用户原话："给你指定目录后，你就有目录的权限了"。

**背景（为什么要做）:** 改完后端 API 要顺手改前端调用方时，今天只能开两个会话来回切，或在一个会话里让 agent 去够另一个仓——够不着：既没有访问权，也没有那个仓的记忆（对方工作区的 CLAUDE.md / auto memory 都不在本会话上下文里）。

**Tech Stack:** TypeScript（@aide/sdk + sidecar）、Rust（Tauri v2）。无新依赖。

**Spec:** 无独立 spec——本文即方案（决策 D1–D9 + 事实 F1–F9 + 落地改动清单 A–E + spike/验收/测试）。

## 已拍板的决策（D1–D8 已对账，不再改动；D9 复核新增，待确认）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 形态：单会话挂多个目录 | 不是多会话协作——用户要的是"一个会话里前后端一起改" |
| D2 | 入口：@引用目录（复用既有 mention 芯片机制） | 表达直接："给你指定目录 = 你有权限"；复用现成芯片/卡片链路，不新造 UI |
| D3 | 附加目录默认可写、不弹确认 | 与默认 `auto` 模式的既有行为一致 |
| D4 | 范围：只能 @ **已注册工作区**（`registeredWorkspaces` 内，或其子目录） | 授权落在 Aide 已知信任边界内；防"随手 @ 了 C:\Windows" |
| D5 | 时效：粘性——本会话内长期有效 | 前后端来回改不该反复 @ |
| D6 | UI 范围：只要 agent 能达。**不改**文件树 / 编辑器 / git 面板 / LSP / 文件监听 | 见「明确不做」 |
| D7 | 记忆：复用 Aide 的记忆系统（对方仓的 CLAUDE.md + auto memory） | 不另造一套 |
| D8 | **@ 即算信任**：附加仓的 CLAUDE.md / 记忆直接注入，不走 `is_path_trusted` 门 | 用户显式 @ = 显式意图；代价已知并接受（代价清单见下） |
| D9 | 账本恢复语义：每次 send 带**「客户端已知全量」**（sidecar 侧并集合并，幂等）。**2026-09-17 已定** | 见 F7：worker 账本随进程消失、sidecar 无快照通道；「本条新增」语义下"杀 sidecar 后恢复"无路径可走。**已接受的代价**：一个还没发过消息的端（PWA 刚连 / WebView 刚重载）chip 条为空，而 agent 仍有权限——**A 下无法区分"确实没有"与"本端还不知道"**，所以对外不承诺"chip 条空 = 没授权"。**落盘的备选（`<sid>.json`，走 sessionMeta 范式）已弃**：多一条落盘链、与"授权不落盘"的基调相冲，换来的只是那一个窗口期 |

**D4 的实际价值要说准**：在默认 `auto` 模式 + `allowDangerouslySkipPermissions` 下，cwd 外的文件**今天就是可达的**（F1），D4 拦的不是"给不给文件权限"，而是**"谁的指令文本/声明类配置被自动注入进上下文"**（D8 的信任后果）。按错误的心智模型改这块会改坏。

**D8 的代价清单**：未信任仓的指令文本进上下文（D8 本意）。
~~对方仓的声明类配置也会并入~~ —— 2026-09-17 实测**否掉**（F4）：`settingSources: []` 下 add-dir 目录的设置不生效。这条**多写了，撤掉**；但要记住它挂着 `settingSources: []` 这个前提。

## 关键事实（决定设计落点）

**F1. 权限层不是障碍——真正的问题在别处。** `src-tauri/src/policy/evaluate.rs:461-491` 的权限快照纯由用户存过的规则解析而来，**没有合成任何 cwd 边界规则**（`PermissionPolicySnapshot` 只有 `{ revision, rules }`）；sidecar 的 policy hook（`engine/policy/sessionHook.ts:105-191`）无匹配时返回 `{}`；`queryOptions.ts:56` `allowDangerouslySkipPermissions: true` + 默认 `auto` 模式（`engine/permissionModes.ts:10-15`）⇒ cwd 外的 Read/Edit/Write 今天就是静默放行（`manual` 模式才弹）。**不要往权限层加"目录边界"**——那是往不拥有该职责的层塞规则。
> 口径修正（2026-09-17 已实测补齐）：这条只证明 **Aide 自己不弹**；CLI 侧已由 S1/S2 实测——**auto 档下 `canUseTool` 从不被调用**（cwd 外读写无条件放行，F1 现在有实测支撑而非推理链）；**manual 档下 cwd 外读会走 `canUseTool`**（= 会弹窗），加 `additionalDirectories` 后不再走。

**F2. 目录识别早就有了，@目录今天是个哑弹。** `useInlineMention.ts:112` 已在调 `api.pathTypes()` 拿 `"file" | "dir" | "none"`，并把 `isDir` 存进 chip（`:124,143`）。哑弹的原因是发送时 `resolveFileMentions` 拿目录去 `readFileContent`，读失败被 `fileMentions.ts:90-93` 的 `catch { continue }` 吞掉。**`list_directory`（`api.ts:263`）与 `path_types`（`filesystem.rs:738`）都已在 api 门面 ⇒ 零新增 IPC 命令。**

**F3. 记忆按工作区 key 严格隔离。** auto memory 在 `~/.aide/claude/projects/<key>/memory/MEMORY.md`，由 CLI 按**会话 cwd** 加载；`instructions.ts:43-53` 只读两个文件（全局 `~/.aide/claude/CLAUDE.md` + `{cwd}/CLAUDE.md`）。附加仓的记忆必须由 Aide 自己注入。`memoryDirs(configDir, cwd)`（`extensions/builtinHooks/memoryEvents.ts:30`）已能解析任一 cwd 的 memory 目录——**复用，勿再抄一份**（落位见 D 段）。

**F4. SDK 原生通道的语义（复核修正）。** `Options.additionalDirectories`（`sdk.d.ts:1401`）→ CLI `--add-dir`。两条实测结论：
- ✅ CLAUDE.md 不会自动加载：CLI 里加载附加目录 CLAUDE.md 的代码被 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` 门控（二进制字符串：`if(Oe(a.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD)){for(let ke of Xm()){...Rm(ke,"CLAUDE.md")...}}`）。**不设它就不加载**——所以 Aide 自己注入不会双份。
- ⚠️ **"不加载对方仓配置"成立，但前提是 `settingSources: []`（2026-09-17 实测钉住）**：CLI 里确实存在 `an --add-dir directory's settings` 这个设置来源（旁证还有 `Plugin ... from --add-dir ... overridden by`、`'s headersHelper (an --add-dir declaration may not run commands)` 这些硬化痕迹），但在 Aide 的 `settingSources: []` 下它**不生效**——S1 探针：B 仓 `.claude/settings.json` 声明的 MCP server **没有**出现在 `init.mcp_servers`，而同一次 run 里由 options 提供的阳性对照 `s1-control` 出现了。⇒ 将来谁动 `settingSources`，add-dir 目录立刻变成配置来源。

**F5. 会话中扩根有现成范式。** `engine/effortSwitch.ts` 是模板：窄结构接口（`EffortSettable`）+ query 未起就落账、query 在跑走 `applyFlagSettings` + 成败都有回声 + 无变化 no-op（`:49`）。**照抄这个形状**（参数按铁律拆分，见 C 段）。

**F6.（复核新增，最重要）query 全会话只 spawn 一次 —— "下次 spawn 生效" ≈ "本会话不生效"。**
`startLoop` 全仓**只有一个调用点**：`session-worker.ts:639`，在 `if (!this.currentQuery)` 分支里；`currentQuery` 只在循环结束（`:798/:813/:845/:1094`）才归 null。跨轮复用同一条 query。两条后果：
- **中途 @ 目录只有一条路**：`applyFlagSettings`（R1）。方案原写的"账本兜底（下次 spawn 落地）"**不是兜底**——健康会话里下次 spawn 可能永不到来。R1 是**单点**，不是"有退路的风险"。
- **D 段（记忆注入）原写的"下一次 spawn 才并入 system prompt"实际是"本会话几乎不会并入"**。D7 是用户目标的一半，不能靠软提示兜底（参见"光注册工具模型会无视"的既有教训）⇒ 记忆注入必须**当轮可达**（走授权消息的目录段），systemPrompt 那条降级为持久化路径（见 D 段）。

**F7.（复核新增）迟到客户端拿不到账本——没有任何现成通道。**
sidecar 无 snapshot/重发机制：`SidecarCommand` 无 attach/subscribe 命令，`models_available`/`effort_changed` 都是"变化时才发"；Rust 侧唯一的分发是 `app.emit("chat-event", event)`（`runtime/mod.rs:423-424`）与 relay 原样透传。既有先例是另一条路：`session_effort`/`session_model` 读的是 **Rust 侧 `<sid>.json` 持久化**（写入口唯一：`sessionMeta.ts:49`），不是事件回灌。⇒ 事件-only 的账本意味着"PWA 后连 / 桌面 WebView 重载 → chip 条为空，而 agent 仍有权限"的**隐藏状态**。D9 就是为这条开的。

**F8.（复核新增）Rust 侧已有"双边 canonicalize 的路径包含判定"，直接复用。**
`policy::matchers::path_within_folder`（`matchers.rs:373`）：target 与 folder 各自 `make_absolute` → 词法归一 → `canonicalize_with_tail`（解析符号链接、容忍不存在的尾段）→ 组件级包含；任何错误返回 `false`。而注册表里的路径**只做了 trim + 去尾分隔符**（`registry.rs:47-49`），**不 canonicalize**（大小写 / 8.3 短名 / UNC 形态都不统一）。⇒ 手搓 `strip_prefix(canonicalize(输入), 注册表原样)` 是**单边** canonicalize，形态不一致就静默误拒；复用 F8 的函数则两边过同一把尺子。

**F9.（复核新增）headless 没有 Rust 层，D4 在 headless 下不成立。**
`additional_dirs` 一旦进 `headless-schema.ts`，headless 引擎（`src/headless-server.ts`，无 Tauri/注册表）就会接受**任意**目录。引擎侧做不了注册表判定（它不认识工作区）。⇒ 必须显式声明：**D4 的"只能是已注册工作区"是桌面/Rust 路径的保证；headless 下由宿主的网关负责授权**（与 CLAUDE.md 的"机制/策略边界：引擎提供机制，不认识租户"一致）。这句话要写进 headless 契约文档，否则将来读者会把它当成全平台保证。

## 设计总览

```
【产出】ChatInputBox + fileMentions.ts
  @目录 → pathTypes 判为 dir → chip(isDir) → 发送时展开 → resolveFileMentions 目录分支
       → resolved(isDir) + additionalDirs（= 本条 @ 的 ∪ 客户端已知账本，见 D9）
        │  invoke("send_message", { attach_dirs })
【传输】packages/aide-sdk/src/api.ts（门面）+ useChatSession
        │  attach_dirs: Option<Vec<String>>
【判定】src-tauri/src/commands/workspace/attach.rs（新，Rust 权威）
  拒非绝对路径 → 过滤本目录 + 去重 → policy::matchers::path_within_folder 判包含（F8）
  → 剔除会话主根子树 → cmd["additional_dirs"] + cmd["attach_rejected"]
        │  stdin JSON 帧
【生效】sidecar session-worker: 粘性账本 additionalDirs（唯一主人）
  ├─ query 未起（含首条消息）→ spawn 时 Options.additionalDirectories
  └─ query 在跑 → query.applyFlagSettings({ permissions: { additionalDirectories } }）
        │  ChatEvent { type:"workspace_attached", dirs, rejected?, error? }（全量账本，幂等）
【注入】当轮：授权消息的目录段带本仓 CLAUDE.md / MEMORY.md 摘要（F6：当轮必达）
        持久：instructions.ts 附加根 CLAUDE.md + MEMORY.md → systemPrompt.append（下次 spawn/新会话）
【渲染】display mention 块加 isDir（两份定义同形 + 构造点透传）+ 输入区粘性 chip 条
```

**为什么各自落在这层：**

- **能力载体用 SDK 原生 `additionalDirectories`，不用 Aide 权限层**：权限层不拥有"目录边界"职责（F1）。
- **范围判定放 Rust**：PWA/鸿蒙与桌面共用同一 sidecar 会话，授权请求可能来自任何客户端，前端校验只能算 UX；Rust 是唯一能读 `registeredWorkspaces` 的层（**注意 F9：headless 无此层**）。远程路径已核对：`remote/rpc/handlers.rs` 的 send 是**同一个** `commands::chat::send_message`（位置参数直调），所以远程来的 `attach_dirs` 走一模一样的裁定，不存在旁路。
- **粘性账本放 sidecar worker**：授权的真实生效者是 sidecar（它决定 spawn 与 applyFlagSettings）；粘性要跨多条 send、跨 `handleSend`/排队/插队三条入队路径，只有 worker 实例态能保证共用一份账本。Rust 不存（会话销毁语义归 sidecar），前端不存（远程端无法知道别的客户端授过权）。
- **可见性走事件广播 + 客户端回灌**：多端一致性红线——"别的客户端怎么知道？"答：sidecar 广播全量账本；迟到端由客户端在下次 send 时回灌已知全量（D9）。
- **记忆注入放 `loadAideInstructions`**：它是 `systemPrompt.append` 的唯一产地（`queryContext.ts:69`），是唯一确定生效的 **spawn 期**通道；当轮可达另走消息级目录段（F6）。

## 改动清单

### A. 引用解析加目录分支

**`packages/aide-sdk/src/utils/fileMentions.ts`**

- `resolveFileMentions(text, readFile)` 第二参数**对象化**为注入能力面（沿用 `MapperDeps` 对象化先例）：

  ```ts
  export interface MentionIo {
    readFile: (path: string) => Promise<string>;
    /** 缺省 = 维持旧行为（目录引用静默忽略）——老调用点/远端安全降级。 */
    listDir?: (path: string) => Promise<unknown>;
    /** 本会话已知账本（useSessionAttachedWorkspaces）：命中则降档，见下。缺省 = 全按首次。 */
    attachedDirs?: string[];
  }
  ```

- 循环内 `readFile` 失败的 `catch` 改为二次判别：`listDir` 成功 = 目录 → `isDir: true`、忽略 `range`（行号对目录无意义）、`content` 按**两档**生成（F6 + token 成本）：
  - **首次 @（不在 `attachedDirs`）**：宣告 + 一级条目列表（封顶 200 条；顺序先生成条目、再走 `MAX_MENTION_CHARS` 截断，两个上限的先后写进注释）+ **本仓指令摘要**（`<dir>/CLAUDE.md` 与 `memoryDirs` 下的 `MEMORY.md`，过 D 段同一预算）——这是 D7 当轮可达的唯一通道。
  - **已在账本内（重发芯片）**：只发一行 `已授权目录：<path>`，不重发清单与指令（省 token、不重复注入）。
  - `listDir` 也失败 = 路径不存在 → **维持原样静默忽略**。
- `ResolvedMention` 加 `isDir?: boolean`。
- 新导出：`normalizeMentionPath(p)`（剥尾部分隔符）、`attachedDirsFrom(resolution, sessionRoot)`（筛 `isDir` → 归一 → 去重 → 剔除 sessionRoot 子树）。
- 目录段标记 `--- 引用目录：<path> ---` / `--- 目录结束：<path> ---`，**`splitMentionSections` 同 commit 联动**（该文件 `:122-132` 明写"标记格式只有这一处真相源"）：
  - 正则放宽为 `--- 引用(?:文件|目录)：(.+) ---` / `--- (?:文件|目录)结束：\1 ---`——用**非捕获组**保持 `\1` 反向引用位置不变，旧格式（纯"文件"）回看兼容不变。
  - **解析出的 section 要按标记种类置 `isDir`**（否则重开历史时目录段会渲染成文件卡）。
- 调用点影响面（已核对）：生产代码只有 `ChatInputBox.vue:832` 一处；测试 11 处（`fileMentions.test.ts`）。**sidecar 完全不用这个模块**（零 import），所以目录解析无需在 sidecar 镜像一份。

**`src/components/ChatPanel/ChatInputBox.vue`**（`:832` 调用点）：传 `{ readFile: api.readFileContent, listDir: api.listDirectory, attachedDirs: useSessionAttachedWorkspaces().attachedOf(sid) }`；`SendOptions` 加 `additionalDirs`——按 D9 取**并集**：`attachedDirsFrom(...)` ∪ 账本（`attachedDirsFrom` 负责剔主根/去重）。

**`src/composables/useInlineMention.ts`**：芯片入账前经 `normalizeMentionPath`，避免 `@C:\a\ ` 与 `@C:\a ` 生成两个 chip（现状：chip key 是 `formatMentionPath(path, range)`，尾部反斜杠会原样进 key）。

### B. 授权流：前端 → Rust 判定 → sidecar

**`packages/aide-sdk/src/api.ts`**：`SendMessageParams` 加 `additionalDirs?: string[] | null`（语义：**客户端已知全量**，见 D9；与 `workspaceRoot`（会话主根）语义分开并加注释）。

**`packages/aide-sdk/src/composables/useChatSession.ts`**：`SendOptions`（`:60-78`）与 `QueuedSend`（`:80-93`）各加 `additionalDirs`；`sendMessage`（声明 `:260`）与 `sendQueued`（声明 `:178`）带上。

**`src-tauri/src/commands/workspace/attach.rs`**（新增；落位正确——`registry.rs` 就是"纯函数 + `#[cfg(test)]`，mod.rs 只放命令编排"的先例）

```rust
/// 裁定结果：过闸的目录 + 被拒的目录（拒绝要回给前端——不静默，见下）。
pub struct AttachResolution {
    pub accepted: Vec<String>,
    pub rejected: Vec<String>,
}

/// 裁定入口：逐条过闸（fail-closed），合法条目照常下发；全部非法 = accepted 空 +
/// rejected 全量——不阻塞发送。
pub fn resolve_attach_dirs(raw: &[String], session_cwd: &str) -> AttachResolution;
fn within_registered_workspace(path: &Path, registry: &[RegisteredWorkspace]) -> bool;
```

- **拒非绝对路径**（`Path::is_absolute()`）：`C:repo` 这类 drive-relative 会被 canonicalize 按**进程 cwd** 解析，方向不可控；相对路径同理。
- **包含性复用 `crate::policy::matchers::path_within_folder(candidate, ws.path, None)`**（F8）——双边 canonicalize + 符号链接安全 + 出错即 false + 已有单测。**不要**手搓 `strip_prefix`。
- 剔除会话主根子树 = **无声跳过**（不是 reject）。
- 复用 `registry::normalize_registration_path`（剥尾分隔符）、`registry::registered`（容错解析）；注册表读取直接内联即可（先例：`is_path_trusted` 注释明写"读 state.json 是轻量 IO，调用方已在 spawn_blocking 或命令体里"）。
- `workspace/mod.rs` 挂 `pub mod attach;`。**不计算也不必携带 `trusted`**——信任字段无用途，连字段一起不要（避免影子参数）。

**`src-tauri/src/commands/chat.rs`**（`send_message:204`，现有 13 个输入）：
- 命令签名加 wire 参数 `attach_dirs: Option<Vec<String>>`（置于 `State` 参数之前；远程 handler 是位置参数直调，`Option<Vec<String>>` 与相邻 `Option<String>` 类型不同，错位会编译失败）。
- **装配走既有内部 `SendOptions` 结构体**（`build_send_command(..., opts: SendOptions<'_>)`，`images`/`display` 同款），别再让位置参数长。
- 裁定后：`cmd["additional_dirs"]`、`cmd["attach_rejected"]`（空/全空则不落字段）。

**`src-tauri/src/remote/rpc/handlers.rs`**（`SendMessageArgs:36`）：加 `attach_dirs` 透传。**REGISTRY 不动**（`send_message` 已白名单）。

**五项对账**：① 无新命令，`lib.rs` 不动；② 无新 wire 命令单测，补 `build_send_command`/`send_message` 字段单测（`chat.rs` 测试区已有 `build_send_command_*` / `send_message_cmd_*` 先例）；③ sidecar `types.ts` 联合成员同形（见 C）；④ `headless-schema.ts` 加成员 + **写明 F9（headless 无注册表判定）**；⑤ REGISTRY 已含 `send_message`，仅 handlers DTO 透传。

### C. sidecar：账本 + spawn + 活体扩根

**`agent-sidecar/src/headless-schema.ts`**（`sendCommand:122`）：`additional_dirs: z.array(z.string().min(1)).optional()` + 一条注释指向 F9。

**`agent-sidecar/src/engine/types.ts`**：`SidecarCommand` send 变体（`:407` 起）加 `additional_dirs?: string[]`；`ChatEvent` 加

```ts
| { type: "workspace_attached"; dirs: string[]; rejected?: string[]; error?: string }
```

**`agent-sidecar/src/engine/attachDirs.ts`**（新增，**落 `engine/` 根**——与 `effortSwitch.ts`/`modelSwitch.ts` 同族；`session-worker/` 是"worker 私有拆分"，不放这里）

```ts
export interface FlagSettingsQuery {
  applyFlagSettings(settings: { permissions?: { additionalDirectories?: string[] } }): Promise<void>;
}

/** 纯函数：并集去重（Windows 不区分大小写，保留先到的原值），返回是否变化。 */
export function decideAttach(current: string[], incoming: string[]): { dirs: string[]; changed: boolean };

/** 落地：未起 query 只落账；在场走 applyFlagSettings，成败都 commit + emit 全量。 */
export function applyAttachExtension(
  query: FlagSettingsQuery | null,
  decision: { dirs: string[]; changed: boolean },
  io: { emit: (e: ChatEvent) => void; commit: (dirs: string[]) => void },
): void;
```

- **形状沿用 effortSwitch（窄接口 + 无变化 no-op + 成败都有回声），但按参数铁律把"判定"与"落地"分开**——`applyEffortSwitch` 是 5 字段的单参数对象，照抄即照抄超限；拆成 2 输入 + 3 输入，纯函数那半可直接单测。差异写进注释。
- **no-op 的唯一例外**：`changed === false && rejected 为空` 才 no-op；**有 rejected 必须 emit**（否则拒绝静默，违背"绝不静默"）。
- `query` 未起 → 只 `commit + emit`（首条消息的目录由 spawn 落地，见 F6）；在场 → `applyFlagSettings` 成功/失败**都 commit + emit 全量**（失败带 `error`；账本不回滚——目录已粘性成立，新会话/query 重起时落地）。
- **`permissions` 这一格归本模块独占**：`applyFlagSettings` 的连续调用是**顶层 key 浅合并**（`sdk.d.ts:2601-2603`）——第二次传 `{permissions:{...}}` 会整体替换上一次的 permissions 对象。今天没有别的写入者（只有 `effortLevel`/`outputStyle` 标量），这是隐式不变量，写进注释。

**`agent-sidecar/src/engine/session-worker.ts`**

- 新字段 `private additionalDirs: string[] = []`（粘性账本唯一主人，worker 销毁即清 = 会话内粘性）。
- 接线点在 **`handleSend` 入口的 `applySendRuntimeConfig`（`:575`）**——它在 `!this.currentQuery` 分支（`:620`）与续发/插队分支**之前**，也在 `startLoop`（`:639`）与 `buildSpawnQueryOptions`（`:735`）之前，首条消息据此带上目录 spawn。
- 插队（`jump_queue`）的目录在**入队那条 send 的入口**就已落账，`promoteJumpQueue`（`:365-377`）不必再携带——**这是有意为之，不要"修"**。
- `startLoop` 签名不动；`buildSpawnQueryOptions` 的 parts 在 `:745` 一带直接读 `this.additionalDirs`（与 `:750-751` 读 `this.currentEffort`/`this.currentModel` 同款）。

**`agent-sidecar/src/engine/session-worker/queryOptions.ts`**：`workspace` 组（`:27-35`）加 `additionalDirs?: string[]`，展开 `...(p.workspace.additionalDirs?.length ? { additionalDirectories: p.workspace.additionalDirs } : {})`。

**活体扩根（按 F6 + S1 实测重写）**：中途 @ 目录**只有 `applyFlagSettings` 一条路**，它失败 = **本会话内不生效**（要新会话或 query 结束重来）——不存在"下次 spawn 兜底"。**这条路 2026-09-17 实测已通**（manual 档：无 flag 时读 cwd 外每次都要授权、加 flag 后不再要；会话 id 不变、无 error、75–95ms）。据此：
- 维持"主用 `applyFlagSettings`"；**不需要** abort 重建 spawn，**也不需要** `policy.addSessionRules`；
- spawn 期的 `additionalDirectories` 仍要带（首条消息就 @ 的目录 + 新会话/query 重启后的落地）；
- **不要**用 `interrupt()` 当兜底（它只终结当前轮，iterator 不死，选项不会重建）。

### D. 记忆注入

**`agent-sidecar/src/engine/memoryDirs.ts`**（新增——把纯路径函数从 extensions 迁到 engine 侧）
- `memoryDirs(configDir, cwd)` / `pathToKey(cwd)` 从 `extensions/builtinHooks/memoryEvents.ts:25,30` 原样搬来；`memoryEvents.ts` 改为 re-export（真相源仍是一份）。
- 理由：`engine/instructions.ts` 要用它，而该文件目前**零 extensions 依赖**；搬到 engine 侧既复用又不再拉一条 engine→extensions 的边。已核对：这两个函数目前**只在 `memoryEvents.ts` 内部被用**（外加其测试），迁移零外部影响。

**`agent-sidecar/src/engine/instructions.ts`**

```ts
export interface InstructionSources {
  cwd: string;
  configDir: string;
  /** 主根是否信任（附加根按 D8 不走这道门）。 */
  trusted: boolean;
  /** 附加根（来自会话账本）。 */
  attached: string[];
}
export async function loadAideInstructions(p: InstructionSources): Promise<string>;
```

- **参数对象化**：已核对调用点**只有** `queryContext.ts:69` 一处，零成本；避免"第 4 个位置参数 + 调用点裸 bool"（参数铁律：相邻同型 string 已有 cwd/configDir 一对）。
- 逐附加根追加 `join(att, "CLAUDE.md")`——**D8：不设信任门**；每段加来源头防规则互套：`--- 附加工作区指令：<path> ---` + `（以下规则来自另一个仓库，仅当操作该仓库的文件时适用）`。
- auto memory：`memoryDirs(claudeConfigDir, att)`（engine 侧那份）→ 读 `MEMORY.md`，截前 200 行 / 25KiB（镜像 CLI 规则；Rust 镜像上限在 `commands/memory_observatory/mod.rs:19-20`）。
- 上限：逐文件 256KiB 原样生效；新增 `MAX_ATTACHED_FILES = 8` 与总预算 512KiB（超限截断 + 一行诊断，风格对齐 `:25`）。**同一套预算也用在 A 段的消息级注入上。**
- **不设** `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`——F4 已证 CLI 在该 env 未设时不会加载附加目录 CLAUDE.md，所以"不设 + 我们自己读"不会双份。

**`queryContext.ts`**：`QueryContextDeps` 加 `attachedDirs?: string[]` 并透传；`startLoop` 传 `this.additionalDirs`；systemPrompt 装配点在 `:69`（`loadAideInstructions` 的唯一调用点）。

**生效窗口（按 F6 重写，这是本方案最容易误读的地方）**：`prepareQueryContext` 只在 spawn 时执行，而 **query 全会话只 spawn 一次** ⇒ systemPrompt 里的附加指令**只在首条消息带目录（或新会话 / query 重启）时生效**。中途 @ 的目录，其指令文本靠 **A 段的消息级目录段**当轮送达；systemPrompt 那条是给后续 spawn / 新会话的持久化路径。代价：首条消息带目录时同一份指令会在"消息段 + systemPrompt"出现两次（一次性，可接受，记入已知代价）。

### E. 可见性（粘性状态）

- **display 双定义同形**（红线）：`agent-sidecar/src/engine/types.ts:86` 与 `packages/aide-sdk/src/types/chat.ts:357` 的 mention 成员同步加 `isDir?: boolean`，各补一句"两份必须同形（漂移静默失效）"。`headless-schema.ts:47-48` displayBlock 是 `z.looseObject` 宽松透传，无需改。旧端忽略未知字段，仍渲染成合成 Read 卡（`events.ts:176-187`）。
- **构造点也要透传**（复核补）：display 块是在 `useChatSession.ts:164-169` 从 `mentions.resolved` map 出来的——那里不加 `isDir`，本端自己的卡片就丢了目录标识。只改 `blocksFromDisplay` 不够。
- **`packages/aide-sdk/src/composables/useSessionAttachedWorkspaces.ts`**（新增，与 `useSessionWorkspaces` 同构；已核对不是重复概念——后者严格单根、无数组）：`attachedOf(sid)` / `setAll(sid, dirs)`（事件全量回灌）/ `migrate(temp→real)`（挂进 `finalizeSession` 链：`state.ts:539` 旁边）/ `removeWorkspace`（挂进 `disposeSession`：`state.ts:450` 旁）/ `clearAll`（挂进 `resetAllState`：`state.ts:572` 旁）。
- **`useChatSession/events.ts`**：`blocksFromDisplay` mention 分支透传 `isDir`；`handleChatEvent` 加 `case "workspace_attached"`（switch 无 default/穷尽检查，加成员不破坏任何东西）。
- **桌面最小 UI**：**`ChatInputBox.vue`** 输入区上方（与 `.jump-strip:932` / `.mention-strip:965` / `.image-attachment-strip:994` 同族，token 走 `:1423-1444` 已有那套）一条只读 chip 条：显示账本 + 被拒目录的一行提示（`rejected`，如"未注册，已忽略"）。不做移除按钮——要解除就开新会话。
- **迟到端的已知代价（F7 + D9=A，已接受）**：账本只由事件回灌 + 客户端自己重报维护，所以**还没发过消息的端**（PWA 刚连 / WebView 刚重载）chip 条是空的，而 agent 仍有权限。自愈点是该端的**第一条消息**：它带上已知全量（此刻可能是空集，无害）→ sidecar 回灌全量账本 → chip 条补齐。**不要**在这上面加"未知"占位态——A 下无法区分"确实没有"与"本端还不知道"，画一个假的区分比不画更误导。
- **不用 display 块当粘性状态源**：display 是 per-message 渲染描述，重开历史虽可见但不构成"当前授权"账本；且 PWA/鸿蒙发的消息没有 display，靠它推账本会端间漂移。

## 明确不做（附加根下这些仍只服务主根）

git 面板（30+ 命令绑活动工作区，仅 `git/status.rs:29`、`git/operations.rs:50`、`git/diffpair.rs:426` 支持 cwd 覆写）、文件监听（`filewatch.rs:131-146` 单 ActiveWatch）、LSP（`lsp/mod.rs:89-96` 信任门 + per-root server）、codegraph（`codegraphTools.ts:141-158` 单 cwd 闭包，第二仓查询降级 "index not built for this project"）、策略广播路由（`chat.rs:314` 单根 route）、文件树/编辑器、**automation 的 send 路径**（Rust 直接拼帧 `scheduler.rs:340-383`，不经 `send_message`，永远不带目录）、**PWA/鸿蒙的 chip 条渲染**（见验收 #8）。

## 风险与 spike（动手前先跑）

| # | 风险 | 缓解 |
|---|---|---|
| R1 | ~~单点~~ **已实测通过（2026-09-17）**：`applyFlagSettings({permissions:{additionalDirectories}})` 对**跑到一半**的 query 扩根确实生效，且对"与 cwd 无子树关系的兄弟目录"同样生效（CLI 里那处 `is not a subdirectory of cwd or of a launch-time --add-dir root` 判定**没有**挡这条路） | 见「spike 实测」S1。**仍是中途生效的唯一路径**（F6），所以 spawn 期带参这条路也要留着 |
| R2 | ~~manual 模式下是否弹窗~~ **已实测通过（2026-09-17）**：manual 档下 cwd 外读**会**触发 `canUseTool`（= 会弹窗），加 `additionalDirectories` 后**不再触发**；auto 档（app 默认）`canUseTool` **从不被调用** | 见「spike 实测」S2。⇒ **原计划的 `policy.addSessionRules` 缓解路径取消**（目录边界由 add-dir 自己解决）。**未测**：manual 档下的**写**——编辑在 manual 档本来就逐条问（模式语义），与目录无关 |
| R3 | ~~CLI 是否已为 add-dir 自动加载对方仓的 MEMORY.md~~ **已排除** | 二进制证据：CLI 加载附加目录 CLAUDE.md 受 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` 门控（F4），不设即不加载。**无需 spike**，顺带看 `context_usage.breakdown.memoryFiles` 确认即可 |
| R4 | 路径形态：`\\?\`、正反斜杠、大小写、8.3 短名、UNC、`C:repo` 这类 drive-relative | 原生绝对路径（普通 Windows 形态）**已实测可用**（S1 全程用该形态）；`\\?\` 按设计在 Rust 侧剥掉（`dunce::simplified`），余下形态（大小写/8.3/UNC/drive-relative）**留 Rust 单测覆盖**（阶段 2 `workspace/attach.rs`），不单开 spike |
| R5 | 未芯片化的 `@目录` 字面量：现在**也会被 `listDir` 展开成清单**进 prompt（解析按文本，不认芯片）——它与授权是两条路，闸门只在授权 | 接受：Rust 裁定是唯一授权入口；把未芯片化文本也拉进授权等于开任意路径后门。但**措辞要改**：不是"留在 prompt 里未展开"，而是"清单进了 prompt、权限没给" |
| R5b | **Bash 旁路（2026-09-17 转录实证）**：`additionalDirectories` 只约束 CLI 的**文件工具**（Read/Edit/Write）与手动档的弹窗判定，**管不住 Bash**——安全命令白名单（`auto-safe-*`，信任工作区时写入策略）不区分目录，`ls/cat/find/test -f` 在手动档也自动放行。实测：一个**没有任何授权**的会话，Read 撞到"文件不存在"后改走 Bash，把 cwd 外目录翻了个遍、全程无弹窗 | 接受并**在文档里说清边界**：本方案的"授权"= CLI 文件工具层的授权，不等于"够不着"。要让 Bash 也守边界得在 Aide 策略层按路径规则做（另一件事，且会让"顺手看一眼别的仓"变得难用）。**别在任何面向用户的文案里承诺"没授权就够不着"** |
| R6 | 授权后 `register_session_route` 仍只挂主根（`chat.rs:314`） | 本次授权不落盘成规则，无实际影响；记入"不做清单" |
| R7 | 迟到端账本（F7）：PWA 后连 / 桌面重载 → chip 条空但权限在 | D9=A 已定，接受该窗口期（自愈点 = 该端第一条消息的回声）。**不画"未知"占位态**（A 下无法区分，见 E 段） |
| R8 | headless 无 Rust 裁定（F9），`additional_dirs` 会接受任意目录 | 在 headless 契约文档写明"授权由网关负责"；引擎不做注册表判定 |

**spike 清单（2026-09-17 已跑，结果见文末「spike 实测」）**：
- **S1 活体扩根 —— 通过**（脚本 `agent-sidecar/smoke-attach-dirs.ts`，可复跑）。"必须先过、不过就改设计"的约束解除。
- **S2 弹窗行为 —— 通过**。`policy.addSessionRules` 缓解路径取消。
- **S4 路径形态 —— 部分覆盖**：原生绝对路径可用；余下形态转 Rust 单测。
- ~~S3 记忆归属~~ 已由 F4 排除。

## 验收（端到端）

1. 打开已注册工作区 A 的会话，输入 `@<仓B根>` + 空格 → 出现目录芯片。
2. 发"看看 B 仓的 xxx 接口，把 A 仓调用方一起改掉" → 气泡出现目录引用卡（带目录标识）+ 输入区粘性 chip 条。
3. 模型能读并**编辑成功** B 仓文件；A 仓文件同样可编辑。（口径：`auto` 模式下这条**今天已成立**——真正的新增是 `manual` 模式下的正确性（见 #7）与记忆注入）
4. `@C:\Windows`（未注册）→ 无授权效果、Rust 有 reject 日志，**且界面上有一行可见回声**（"未注册，已忽略"）。
5. 再发 3 条（含忙碌排队插队一次）→ 授权仍有效；`workspace_attached` 只在账本变化时广播全量；**重发同目录芯片不再重注清单/指令**。
6. **恢复（D9=A）**：杀 sidecar（或会话重开）→ 本端下一条 send 自动带上已知全量 → 授权恢复（chip 条与读写都回来）。注：**重载 WebView 后、发第一条消息之前** chip 条会是空的——这是已接受的代价，不是 bug。
7. `manual` 模式 + 对附加目录写文件 → 按 S2 结论验证。
8. remote-pwa 连同一会话 → **事件层**能收到 `workspace_attached`（可在 SDK/SDK 单测断言）；**PWA 端 chip 条渲染是额外工作量**，本方案不排（要做就放阶段 4，同时补鸿蒙镜像）。
9. **记忆当轮可达**：中途 @ 仓 B 后，同一条消息里就能看到 B 仓 CLAUDE.md 的规则生效（不必等新会话）——这是 F6 逼出来的验收项。

## 测试清单

- **sidecar vitest**：`engine/attachDirs.test.ts`（`decideAttach` 去重含大小写/正反斜杠/尾分隔符；无新增 no-op；**有 rejected 不 no-op**；query=null 只落账；成功传**全量**；失败 commit 不回滚 + error）；`engine/memoryDirs.test.ts`（迁出后行为不变，阶段 3）；`instructions.test.ts` 扩（对象化入参、附加根注入带来源头、超限诊断、总预算、MEMORY.md 路径解析，阶段 3）；`queryOptions.test.ts` 扩（**附加目录非空落 `additionalDirectories`、空/缺省不落字段**）；`headless-server.test.ts` 扩（`additional_dirs` 形状：字符串数组透传、非法/空串/缺席逐臂）。
- **Rust `cargo test --lib`**：`workspace/attach.rs`（注册表根/子目录命中、**大小写不一致仍命中**、**非绝对路径拒**、未注册拒、不存在拒、文件拒、尾反斜杠归一、主根子树剔除、去重、rejected 全量上报）；`chat.rs` 扩（`cmd["additional_dirs"]`/`cmd["attach_rejected"]` 形状、空/全空不落字段、无参数时字段缺席）；`remote/rpc/handlers.rs` 扩（透传）。过滤跑，禁全量双跑。
  - ⚠️ **夹具注意**：Rust 单测同进程并行，临时目录必须**每个用例一个**（`<pid>-<seq>`）。共用目录时各自的 `remove_dir_all` 会把别人正在用的路径删掉——症状是"随机几个用例失败"，2026-09-17 实际踩过。
- **前端 vitest**：`fileMentions.test.ts` 扩（目录分支、两档 content（首次/已知）、标记拆回含旧格式回归、`listDir` 缺省旧行为、尾反斜杠归一、`attachedDirsFrom` 过滤主根子树）；`useInlineMention.test.ts` 扩；`useSessionAttachedWorkspaces.test.ts` 新（setAll/migrate/remove/clear + rejected/error 回声）；`useChatSession.test.ts` 扩（display 构造带 `isDir`）。
  - ⚠️ **`ChatInputBox.test.ts` 不存在**（复核时的假设有误）：组件层没有独立测试文件。目录 → `additionalDirs` 的并集逻辑目前只由 `attachedDirsFrom` 单测 + vue-tsc 兜住，未做组件级断言——要么补一个挂载测试，要么接受这个缺口（见「阶段 2 落地」）。

## 分阶段落地

1. **spike S1/S2/S4**（半天，先证核心命题；S1 不过就改设计，不硬推）
2. **授权链路 A+B+C + 最小回声**（workspace_attached 事件 + 桌面 chip 条 + 拒绝提示）——此时已可用，agent 能读写第二个仓，且用户看得见结果。**回声必须在这一阶段**：拒绝静默 = 用户无法区分"授权成功"与"被丢弃"，与 C 段"绝不静默"的原则相冲。
3. **记忆注入 D**（消息级当轮可达 + systemPrompt 持久路径）
4. **多端与卡片细节**（PWA/鸿蒙渲染 + 迟到端策略按 D9 收口）

## 复核修订记录（2026-09-17）

来源：对方案逐条回源码/二进制取证（Rust / sidecar / 前端 SDK 三条独立核对 + vendored CLI `claude.exe` 0.3.252 字符串取证）。

**改掉的设计（附证据）**

| 修订 | 原方案 | 现方案 | 证据 |
|---|---|---|---|
| 时效真相 | "下次 spawn 兜底，不存在死状态" | 中途授权只有 `applyFlagSettings` 一条路；失败 = 本会话不生效 | `startLoop` 唯一调用点 `session-worker.ts:639`；`currentQuery` 仅循环结束归 null |
| 记忆时效 | 附加根 CLAUDE.md"下次 spawn 进 system prompt" | 当轮走消息级目录段；systemPrompt 降级为持久路径 | 同上（F6） |
| 账本恢复 | "本条新增"语义 | D9：客户端已知全量（并集幂等） | sidecar 无 snapshot/重发；`session_effort` 先例是 `<sid>.json` |
| F4 措辞 | "只给文件访问权、不加载对方仓配置" | ~~降级为"说满了"~~ → **实测后维持原文**（前提是 `settingSources: []`） | 来源确实存在（`an --add-dir directory's settings`），但 S1 探针证明它在 `settingSources: []` 下不生效：marker 未出现在 `init.mcp_servers`，阳性对照 `s1-control` 出现 |
| 包含性判定 | 手搓 `strip_prefix` + 单边 canonicalize | 复用 `policy::matchers::path_within_folder`（双边）+ 拒非绝对路径 | `registry.rs:47-49`（不 canonicalize）、`matchers.rs:373/490` |
| 拒绝回声 | 只写日志 | `attach_rejected` → `workspace_attached.rejected` → UI | 与 C 段"成败都有回声"自洽 |
| 落位 1 | `engine/session-worker/attachDirs.ts`（号称"与 effortSwitch 同构"） | `engine/attachDirs.ts` | effortSwitch/modelSwitch 在 `engine/` 根；`session-worker/` 是 worker 私有拆分 |
| 落位 2 | chip 条挂 `ChatPanel.vue` | 挂 `ChatInputBox.vue`（与 jump/mention/image 三条带同族） | ChatPanel 只渲染 `<ChatInputBox>`（`:627-655`） |
| 落位 3 | `instructions.ts` 直接引 `extensions/…/memoryEvents.ts` 的 `memoryDirs` | 先把 `memoryDirs`/`pathToKey` 迁到 `engine/memoryDirs.ts`，extensions re-export | `instructions.ts` 现零 extensions 依赖；两函数目前无外部消费者 |
| 参数铁律 1 | `applyAttachExtension({query,current,incoming,emit,commit})`（5 字段，照抄模板） | 拆 `decideAttach`（2）+ `applyAttachExtension`（3） | 模板 `applyEffortSwitch` 同为 5 字段超限 |
| 参数铁律 2 | `loadAideInstructions(cwd, configDir, trusted, attached)` 4 位置参 | 对象化 `InstructionSources` | 调用点唯一 `queryContext.ts:69`，零成本 |
| 参数铁律 3 | `send_message` 加第 14 个位置参数 | wire 参数照加，装配走既有内部 `SendOptions` | `chat.rs:271-288` 已有该结构体 |
| 多端 | 只同步 sidecar/SDK 两份 display 定义 | 补：**构造点** `useChatSession.ts:164-169` 透传 `isDir`；**ohos 镜像** `ChatTranscript.ets:35` 的 `splitMentionSections` 同步 | 三端同步红线 |
| 验收 #8 | 要求 PWA 显示 chip 条 | 降级为事件层断言；PWA 渲染列为额外工作量 | remote-pwa 无 mention 解析、无 chip 条 |
| 成本 | 未提 | 重发芯片不重注清单/指令（两档 content） | 每轮重注 200 条清单的 token 账 |

**核对为真的关键点（可放心照做）**：`handleSend:575` 接线点与 `startLoop:639`/`buildSpawnQueryOptions:735` 的先后关系；`queryOptions.ts:56/58`；`registry::normalize_registration_path`/`registered` 的形态；**远程路径与桌面走同一个 `commands::chat::send_message`**（无旁路）；Rust 侧无需为新事件加 case（`scheduler.rs:761` 有 `_ => {}`）；`useSessionAttachedWorkspaces` 的三个挂点（`state.ts:539/450/572`）；`resolveFileMentions` 生产调用点唯一（`ChatInputBox.vue:832`）；sidecar 不引用 `@aide/sdk`（解析无需镜像）；`sdk.d.ts:1401/2616/5682`。

**顺手修（与本方案同 commit 或单独）**：`packages/aide-sdk/src/types/chat.ts:333` 的注释指向不存在的 `agent-sidecar/src/types.ts`（真实是 `engine/types.ts`）。

**文档事实性小错（已在本版改正）**：`lsp/jdk.rs:82` 不存在（dunce 先例真实位置：`lsp/mod.rs:876`、`lsp/manager.rs:452`、`lsp/profiles/java.rs:189`、`runtime/mod.rs` 多处）；`memory_observatory/mod.rs:18` 是文档注释（常量在 `:19-20`）；`memoryEvents.ts:31` → `:30`；`useChatSession.ts` 的 `sendMessage` 声明在 `:260`（`:298` 是内部 `QueuedSend` 字面量）、`sendQueued` 在 `:178`（`:194` 是 invoke 行）。

## spike 实测（2026-09-17）

脚本 `agent-sidecar/smoke-attach-dirs.ts`（`npx tsx smoke-attach-dirs.ts [main|manual|manual2|manual3|auto2|spawn]`，可复跑；夹具 = 两个互不包含的临时目录，B 是 cwd 的**兄弟**，不是子目录）。选项形状复刻 app：`settingSources: []` + `allowDangerouslySkipPermissions: true` + `permissionMode: "auto"|"manual"` + `canUseTool`（只记日志并放行）+ `CLAUDE_CONFIG_DIR=~/.aide/claude`。

| 臂 | 档位 | 关键手法 | 结果 |
|---|---|---|---|
| `spawn` | auto | launch 带 `additionalDirectories: [B]` | init 里 **B 仓 settings 的 marker 未出现**，阳性对照 `s1-control` 出现 ⇒ F4 成立（前提下文）；失败/连不上的 MCP server 不挂会话 |
| `main` | auto | 先读 A、读 B，再 flag，再读+**写** | 基线读 B **成功**（无 flag 也通）⇒ F1 在 CLI 层坐实；`out.txt` 真的落盘 = `OK-FROM-SPIKE`；可写 |
| `manual` | manual | 读 A、读 B → **flag** → 读 b2 | flag 前：**只有 B 触发 `canUseTool`**（A 从不触发）；flag 后：**0 次** |
| `manual3` | manual | 读 A → **flag** → **首次**读 B | `canUseTool` **0 次**（flag 先于任何 B 接触，没有"已授予"可借用）⇒ **R1 通过** |
| `manual2` | manual | 同 `manual` 但**不调 flag** | `canUseTool` **2/2**（b.txt 与 b2.txt 各一次）⇒ 排除"turn 1 的 allow 已授予整个目录"这条混淆 |
| `auto2` | auto | 两轮、**不调 flag** | `init` 也是 **2 次** ⇒ 第二次 init 是**每轮都有**，与 `applyFlagSettings` 无关 |

**结论**
1. **R1 通过**：`applyFlagSettings({permissions:{additionalDirectories}})` 对在跑的 query 实时生效；会话 id 不变、无 error、75–95ms；对"与 cwd 无子树关系的目录"同样生效 ⇒ CLI 那处 `is not a subdirectory of cwd or of a launch-time --add-dir root` 判定**没有**挡 add-dir 这条路。
2. **R2 通过**：manual 档下"cwd 外访问要不要授权"这件事确实由 add-dir 决定（`canUseTool` 从 1 次变 0 次、或从 0 次开始就是 0 次）⇒ **不需要 `policy.addSessionRules`**。
3. **F4 维持原文**：`settingSources: []` 下 add-dir 目录不是配置来源（探针有阳性对照）。**安全性挂在这个开关上**。
4. **新观察**：`system:init` **每轮都发一次**（`auto2` 无 flag 也是 2 次）。⇒ sidecar/前端的 init 处理必须幂等（前端 `finalizedSids` 守卫即为此），且它**不是** `applyFlagSettings` 引入的新行为。
5. **未覆盖**：manual 档下的**写**（编辑在 manual 档本来就逐条问，属模式语义）；`\\?\`/UNC/大小写/8.3/drive-relative 形态（转 Rust 单测）；迟到端账本（F7，属 D9 决策）。

## 阶段 2 落地（2026-09-17）

按「分阶段落地」第 2 阶段实施完毕。**自动化验证全绿；真实会话端到端未跑**（见文末「未验」）。

**落的文件**

| 层 | 文件 | 内容 |
|---|---|---|
| SDK | `packages/aide-sdk/src/utils/fileMentions.ts` | `MentionIo` 对象化、目录分支、两档 content、`normalizeMentionPath`/`attachedDirsFrom`、`(文件\|目录)` 标记联动 |
| SDK | `api.ts` / `composables/useChatSession.ts` | `additionalDirs`（已知全量）贯通 `SendOptions`/`QueuedSend`/IPC；display **构造点**带 `isDir` |
| SDK | `composables/useSessionAttachedWorkspaces.ts`（新） | 账本镜像 + rejected/error 回声；挂 `finalizeSession`/`disposeSession`/`resetAllState` 三处 |
| SDK | `composables/useChatSession/events.ts` | `workspace_attached` case（全量覆盖 + 回声透传） |
| 桌面 | `ChatPanel/ChatInputBox.vue` | 调用点传 io；`additionalDirs` 并集；粘性 chip 条 + 拒绝/失败回声条（token 全走主题） |
| 桌面 | `composables/useInlineMention.ts` | 入芯片前归一（防尾分隔符造出两个芯片） |
| Rust | `commands/workspace/attach.rs`（新） | 裁定：纯核心 `resolve_with_registry` + IO 外壳；包含性复用 `policy::matchers::path_within_folder` |
| Rust | `commands/chat.rs` / `remote/rpc/handlers.rs` / `commands/workspace/mod.rs` | wire 参数 + 装配（走既有内部 `SendOptions` 的 `attach` 字段）+ 远程透传 |
| sidecar | `engine/attachDirs.ts`（新） | `decideAttach`（纯，2 输入）/ `applyAttachExtension`（3 输入） |
| sidecar | `engine/session-worker.ts` / `session-worker/queryOptions.ts` / `engine/types.ts` / `headless-schema.ts` | 账本字段、`applySendRuntimeConfig` 接线、spawn 落 `additionalDirectories`、事件与命令形状 |

**与方案的偏差（实施中发现，都是有意为之）**

1. **wire 名统一成 `additional_dirs` / `additionalDirs`**（方案 B 段写的是 `attach_dirs`）：SDK 门面是 `invoke("send_message", { ...params })` 直接透传，Rust 侧若叫 `attach_dirs` 就得在门面里做一次改名——同一个概念两个名字不如一路同名。`attach` 只留在 Rust 的模块名/类型名（`attach.rs` / `AttachResolution` / `SendOptions.attach`）与 sidecar 的回声字段 `attach_rejected` 上（后者没有 SDK 侧对应物）。
2. **消息级指令摘要只带 `CLAUDE.md`**，未带 `MEMORY.md`：`memoryDirs()` 要复刻 `pathToKey`，而它此刻还在 sidecar 的 extensions 里（阶段 3 才迁 engine）。SDK 侧不该抄一份——MEMORY.md 的"当轮可达"随阶段 3 一起解决。
3. **`ChatInputBox.test.ts` 不存在**（复核时的假设有误）：目录 → `additionalDirs` 的并集逻辑只由 `attachedDirsFrom` 单测 + vue-tsc 兜住，**没有组件级断言**。要么补一个挂载测试，要么认下这个缺口。（组件层真正的风险是多端渲染，属阶段 4。）
4. 两档 content 的"已知"判据用的是**客户端账本镜像**，不是 sidecar 的权威账本：判断错了只是多注一次或漏注一次清单，不影响授权（授权只认 Rust 裁定 + worker 账本）。
5. Rust 单测夹具必须**每个用例一个临时目录**（见测试清单的 ⚠️）——第一版用 `process::id()` 命名，同进程并行跑时互相 `remove_dir_all`，3 个用例随机失败。

**验证（已跑）**

| 套件 | 结果 |
|---|---|
| `cargo test --lib attach`（含 `workspace/attach.rs` 7 例） | 9 passed / 0 failed |
| `cargo test --lib build_send_command` | 13 passed / 0 failed |
| sidecar `vitest run`（全量） | **72 文件 / 1070 用例全绿** |
| sidecar `tsc --noEmit` | exit 0 |
| 根 `vitest run` | 227 文件 / 2785 用例，2784 过；**唯一失败与本方案无关**：`ChatMessage.renderScale.test.ts` 的渲染规模守卫 5s 超时——`git stash -u` 基线全量复跑**同样失败**（2754/2755，差 30 例正是本次新增），单跑该文件 2/2 通过 ⇒ 既有脆点（满载下 5s 预算不够），非本次引入 |
| 仓库守卫 | `check:sync-io` / `check:overlay-layers` / `check:tauri-imports` 三条全过 |
| `vue-tsc --noEmit` | exit 0 |
| sidecar `build` + `build:bin` | exit 0（`dist/runtime.js` 8.4mb + `dist/aide-agent.exe`） |

**未验（阶段 2 的验收项还没做）**：真实会话端到端 #1–#5、#9（要起 dev 或发布版跑真会话）；PWA/鸿蒙侧（阶段 4）。

**手工测试补充（2026-09-17）**：首轮手工测试撞到两个**测试设定**问题（不是缺陷）：① 验证"对方仓 CLAUDE.md 当轮可达"的标记被写进了**会话自己**的 `aide/CLAUDE.md`（B 仓没有这个文件），于是它在每个 aide 会话里都出现——判据应当是**解码转录看 prompt 里有没有 `--- 引用目录 ---` 段**，而不是看模型回答里有没有标记；② 手动档弹窗用例的目标文件**不存在**，CLI 先报"file does not exist"、根本走不到权限判定，模型随后改走 Bash（见 R5b）。用例写法已据此修正（目标文件必须存在、用 Read/Edit 而非 Bash）。
