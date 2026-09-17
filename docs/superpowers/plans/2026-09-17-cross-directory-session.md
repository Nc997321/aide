# 单会话跨目录工作（@目录即授权）实现计划

> 状态：**方案待核对，尚未动手**。核对通过后按「分阶段落地」执行；纯文档提交，零测试。
> 实现阶段 REQUIRED：spike S1–S4 先跑（失败就改方案，不硬推）；每阶段完成后按提交前验证预算跑触碰的套件。

**Goal:** 一个会话挂多个目录——前端仓 + 后端仓一起改。用户在输入框打 `@C:\path\to\backend`（或文件树「添加到对话」），该目录获得访问权，且它的记忆（CLAUDE.md + auto memory）一并进上下文。用户原话："给你指定目录后，你就有目录的权限了"。

**背景（为什么要做）:** 改完后端 API 要顺手改前端调用方时，今天只能开两个会话来回切，或在一个会话里让 agent 去够另一个仓——够不着：既没有访问权，也没有那个仓的记忆（对方工作区的 CLAUDE.md / auto memory 都不在本会话上下文里）。

**Tech Stack:** TypeScript（@aide/sdk + sidecar）、Rust（Tauri v2）。无新依赖。

## 已拍板的决策（已对账，不再改动）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 形态：单会话挂多个目录 | 不是多会话协作——用户要的是"一个会话里前后端一起改" |
| D2 | 入口：@引用目录（复用既有 mention 芯片机制） | 表达直接："给你指定目录 = 你有权限"；复用现成芯片/卡片链路，不新造 UI |
| D3 | 附加目录默认可写、不弹确认 | 与默认 `auto` 模式的既有行为一致 |
| D4 | 范围：只能 @ **已注册工作区**（`registeredWorkspaces` 内，或其子目录） | 授权落在 Aide 已知信任边界内；防"随手 @ 了 C:\Windows" |
| D5 | 时效：粘性——本会话内长期有效 | 前后端来回改不该反复 @ |
| D6 | UI 范围：只要 agent 能达。**不改**文件树 / 编辑器 / git 面板 / LSP / 文件监听 | 见「明确不做」 |
| D7 | 记忆：复用 Aide 的记忆系统（对方仓的 CLAUDE.md + auto memory） | 不另造一套 |
| D8 | **@ 即算信任**：附加仓的 CLAUDE.md / 记忆直接注入，不走 `is_path_trusted` 门 | 用户显式 @ = 显式意图；代价（未信任仓的指令文本进上下文）已知并接受 |

## 关键事实（三条独立调查结论，决定了设计落点）

**F1. 权限层不是障碍——真正的问题在别处。** `src-tauri/src/policy/evaluate.rs:461-491` 的权限快照纯由用户存过的规则解析而来，**没有合成任何 cwd 边界规则**；sidecar 的 policy hook（`engine/policy/sessionHook.ts:105-191`）无匹配时返回 `{}`；`queryOptions.ts:56` `allowDangerouslySkipPermissions: true` + 默认 `auto` 模式（`engine/permissionModes.ts:10-15`）⇒ cwd 外的 Read/Edit/Write 今天就是静默放行（`manual` 模式才弹）。**不要往权限层加"目录边界"**——那是往不拥有该职责的层塞规则。

**F2. 目录识别早就有了，@目录今天是个哑弹。** `useInlineMention.ts:112` 已在调 `api.pathTypes()` 拿 `"file" | "dir" | "none"`，并把 `isDir` 存进 chip（`:124,143`）。哑弹的原因是发送时 `resolveFileMentions` 拿目录去 `readFileContent`，读失败被 `fileMentions.ts:91` 的 `catch { continue }` 吞掉。**`list_directory`(`api.ts:263`) 与 `path_types`(`filesystem.rs:739`) 都已在 api 门面 ⇒ 零新增 IPC 命令。**

**F3. 记忆按工作区 key 严格隔离。** auto memory 在 `~/.aide/claude/projects/<key>/memory/MEMORY.md`，由 CLI 按**会话 cwd** 加载；`instructions.ts:43-53` 只读两个文件（全局 `~/.aide/claude/CLAUDE.md` + `{cwd}/CLAUDE.md`）。附加仓的记忆必须由 Aide 自己注入。`memoryDirs(configDir, cwd)`（`extensions/builtinHooks/memoryEvents.ts:31`）已能解析任一 cwd 的 memory 目录——**复用，勿再抄一份**。

**F4. SDK 原生通道正好是我们要的语义。** `Options.additionalDirectories`（`sdk.d.ts:1401`）→ CLI `--add-dir`。在 Aide 的 `settingSources: []`（`queryOptions.ts:58`）下，它天然退化成"只给文件访问权，不加载对方仓的 skills/commands/subagents/CLAUDE.md"——授权与上下文注入被干净地分成两件事，各自显式可控。

**F5. 会话中扩根有现成范式。** `engine/effortSwitch.ts` 是模板：窄结构接口 + query 未起就落账、query 在跑走 `applyFlagSettings` + 成败都有回声。**照抄这个形状**，不新造机制。

## 设计总览

```
【产出】ChatInputBox + fileMentions.ts
  @目录 → pathTypes 判为 dir → chip(isDir) → 发送时展开 → resolveFileMentions 目录分支
       → resolved(isDir) + additionalDirs(string[])
        │  invoke("send_message", { attach_dirs })
【传输】packages/aide-sdk/src/api.ts（门面）+ useChatSession
        │  attach_dirs: Option<Vec<String>>
【判定】src-tauri/src/commands/workspace/attach.rs（新，Rust 权威）
  normalize → canonicalize(dunce 剥 \\?\) → 存在性/目录性 → 注册表包含性(strip_prefix)
  → 剔除会话主根子树 → 去重 → cmd["additional_dirs"]
        │  stdin JSON 帧
【生效】sidecar session-worker: 粘性账本 additionalDirs（唯一主人）
  ├─ query 未起 → spawn 时 Options.additionalDirectories
  └─ query 在跑 → query.applyFlagSettings({ permissions: { additionalDirectories } })
        │  ChatEvent { type:"workspace_attached", dirs }（全量账本，幂等）
【注入】instructions.ts: 附加根 CLAUDE.md + MEMORY.md → systemPrompt.append
【渲染】display mention 块加 isDir（两份定义同形）+ 输入区粘性 chip 条
```

**为什么各自落在这层：**

- **能力载体用 SDK 原生 `additionalDirectories`，不用 Aide 权限层**：权限层不拥有"目录边界"职责（F1）；且 F4 让它天然只给文件访问权。
- **范围判定放 Rust**：PWA/鸿蒙与桌面共用同一 sidecar 会话，授权请求可能来自任何客户端，前端校验只能算 UX；Rust 是唯一能读 `registeredWorkspaces` 的层。
- **粘性账本放 sidecar worker**：授权的真实生效者是 sidecar（它决定 spawn 与 applyFlagSettings）；粘性要跨多条 send、跨 `handleSend`/排队/插队三条入队路径，只有 worker 实例态能保证共用一份账本。Rust 不存（会话销毁语义归 sidecar），前端不存（远程端无法知道别的客户端授过权）。
- **可见性走事件广播**：多端一致性红线——"别的客户端怎么知道？"答：sidecar 广播全量账本。
- **记忆注入放 `loadAideInstructions`**：它是 `systemPrompt.append` 的唯一产地（`queryContext.ts:66-73`），是唯一确定生效的通道。

## 改动清单

### A. 引用解析加目录分支

**`packages/aide-sdk/src/utils/fileMentions.ts`**

- `resolveFileMentions(text, readFile)` 第二参数**对象化**为注入能力面（沿用 `MapperDeps` 对象化先例）：

  ```ts
  export interface MentionIo {
    readFile: (path: string) => Promise<string>;
    /** 缺省 = 维持旧行为（目录引用静默忽略）——老调用点/远端安全降级。 */
    listDir?: (path: string) => Promise<unknown>;
  }
  ```

- 循环内 `readFile` 失败的 `catch` 改为二次判别：`listDir` 成功 = 目录 → `isDir: true`、忽略 `range`（行号对目录无意义）、`content` = 固定宣告 + 一级条目列表（封顶 200 条，复用 `MAX_MENTION_CHARS` 截断）；`listDir` 也失败 = 路径不存在，**维持原样静默忽略**。
- `ResolvedMention` 加 `isDir?: boolean`。
- 新导出：`normalizeMentionPath(p)`（剥尾部分隔符）、`attachedDirsFrom(resolution, sessionRoot)`（筛 `isDir` → 归一 → 去重 → 剔除 sessionRoot 子树）。
- 目录段标记 `--- 引用目录：<path> ---` / `--- 目录结束：<path> ---`，**`splitMentionSections` 同 commit 联动**（该文件 :126-128 明写"标记格式只有这一处真相源"）；正则放宽为 `(文件|目录)` 交替并保留旧转录回看兼容。

**`src/components/ChatPanel/ChatInputBox.vue`**（`:832` 调用点）：传 `{ readFile: api.readFileContent, listDir: api.listDirectory }`；`SendOptions` 加 `additionalDirs: attachedDirsFrom(...)`。

**`src/composables/useInlineMention.ts`**：芯片入账前经 `normalizeMentionPath`，避免 `@C:\a\ ` 与 `@C:\a ` 生成两个 chip。

### B. 授权流：前端 → Rust 判定 → sidecar

**`packages/aide-sdk/src/api.ts`**：`SendMessageParams` 加 `additionalDirs?: string[] | null`（语义：**本条新增**，非全量账本）。

**`packages/aide-sdk/src/composables/useChatSession.ts`**：`SendOptions` / `QueuedSend` 各加 `additionalDirs`；`sendMessage`(:298) 与 `sendQueued`(:194) 带上；与既有 `workspaceRoot`（会话主根）语义分开并加注释。

**`src-tauri/src/commands/workspace/attach.rs`**（新增，内聚下沉同名子模块）

```rust
/// 裁定入口：任何一条不过即丢弃该目录（fail-closed），合法条目照常下发；
/// 全部非法返回空 vec——不阻塞发送。
pub fn resolve_attach_dirs(raw: &[String], session_cwd: &str) -> Vec<String>;
fn within_registered_workspace(path: &Path, registry: &[RegisteredWorkspace]) -> bool;
```

复用：`registry::normalize_registration_path`（剥尾分隔符）、`registry::registered`（容错解析）。Windows 上 canonicalize 产 `\\?\` verbatim，必须 `dunce::simplified`（仓库已两次踩坑：`jdk.rs:82`、`lsp/mod.rs:875`）。包含性用 `Path::strip_prefix`（组件级，杜绝 `C:\ab` 伪命中 `C:\a`）。`workspace/mod.rs` 挂 `pub mod attach;`。

D8 的后果：**不计算也不必携带 `trusted`**——信任字段无用途，连字段一起不要（避免影子参数）。

**`src-tauri/src/commands/chat.rs`**（`send_message:204`）：加 `attach_dirs: Option<Vec<String>>`（置于 `State` 参数之前），`build_send_command` 后装配 `cmd["additional_dirs"]`（空/全非法则不落字段）。

**`src-tauri/src/remote/rpc/handlers.rs`**（`SendMessageArgs:36`）：加 `attach_dirs` 透传。**REGISTRY 不动**（`send_message` 已白名单，`rpc.rs:46`）。

**五项对账**：① 无新命令，`lib.rs` 不动；② 无新 wire 命令单测，补 `build_send_command`/`send_message` 字段单测（`chat.rs` 测试区已有 `send_message_cmd_*` 先例）；③ sidecar `types.ts` 联合成员同形（见 C）；④ `headless-schema.ts` 加成员；⑤ REGISTRY 已含 `send_message`，仅 handlers DTO 透传。

### C. sidecar：账本 + spawn + 活体扩根

**`agent-sidecar/src/headless-schema.ts`**（`sendCommand:122`）：`additional_dirs: z.array(z.string().min(1)).optional()`。

**`agent-sidecar/src/engine/types.ts`**：`SidecarCommand` send 变体加 `additional_dirs?: string[]`；`ChatEvent` 加

```ts
| { type: "workspace_attached"; dirs: string[]; error?: string }
```

**`agent-sidecar/src/engine/session-worker/attachDirs.ts`**（新增，与 `effortSwitch.ts` 同构）

```ts
export interface FlagSettingsQuery {
  applyFlagSettings(settings: { permissions?: { additionalDirectories?: string[] } }): Promise<void>;
}
export function mergeAttachedDirs(current: string[], incoming: string[]): string[];
export function applyAttachExtension(p: {
  query: FlagSettingsQuery | null; current: string[]; incoming: string[]; emit; commit;
}): void;
```

- 去重按归一路径（Windows 比较用不区分大小写，保留原值）；无新增 = no-op（不坐实、不广播，对齐 `effortSwitch.ts:49`）。
- `query` 未起 → 只 `commit + emit`（下次 spawn 落地）；在场 → `applyFlagSettings` 成功/失败**都 commit + emit 全量**（失败带 `error`，账本不回滚——目录已粘性成立，下次 spawn 必然落地）。语义对齐 `applyEffortSwitch` 的"成败都有回声，绝不静默"。

**`agent-sidecar/src/engine/session-worker.ts`**

- 新字段 `private additionalDirs: string[] = []`（粘性账本唯一主人，worker 销毁即清 = 会话内粘性）。
- `handleSend`（`:573`）在**首条与续发两条分支的共同路径**上接线（位置须覆盖 `!this.currentQuery` 与续发/插队，如 `applySendRuntimeConfig` 附近）。
- `startLoop` 签名不动，`buildSpawnQueryOptions` 的 parts 直接读 `this.additionalDirs`。

**`agent-sidecar/src/engine/session-worker/queryOptions.ts`**：`workspace` 组加 `additionalDirs?: string[]`，展开 `...(p.workspace.additionalDirs?.length ? { additionalDirectories: p.workspace.additionalDirs } : {})`。

**活体扩根取舍**：主用 `applyFlagSettings`（当前轮内生效、不中断流式），账本兜底（即使无效也只是"延迟到下次 spawn"，不存在"授了权永远不生效"的死状态）。**不做** abort 重建 spawn（成本高、为大概率用不上的兜底买单）；**不要**用 `interrupt()` 当兜底（它只终结当前轮，iterator 不死，选项不会重建）。

### D. 记忆注入

**`agent-sidecar/src/engine/instructions.ts`**

```ts
export async function loadAideInstructions(
  cwd: string, claudeConfigDir: string, trusted = true, attached: string[] = [],
): Promise<string>;
```

- 逐附加根追加 `join(att, "CLAUDE.md")`——**D8：不设信任门**。
- 每段加来源头，防模型把两个仓的规则互相套用：
  `--- 附加工作区指令：<path> ---` + `（以下规则来自另一个仓库，仅当操作该仓库的文件时适用）`
- auto memory：`memoryDirs(claudeConfigDir, att)`（**复用** `memoryEvents.ts:31`）→ 读 `MEMORY.md`，截前 200 行 / 25KiB（镜像 CLI 规则，Rust 镜像上限在 `commands/memory_observatory/mod.rs:18`）。
- 上限：逐文件 256KiB 原样生效；新增 `MAX_ATTACHED_FILES = 8` 与总预算 512KiB（超限截断 + 一行诊断，风格对齐 `:25`）。
- **不设** `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`——Aide 自己读，避免双份。

**`queryContext.ts`**：`QueryContextDeps` 加 `attachedDirs?: string[]` 并透传；`startLoop` 传 `this.additionalDirs`。

**已接受的生效窗口**：`prepareQueryContext` 只在每次 spawn 执行（`session-worker.ts:702`），所以附加根的 CLAUDE.md 下一次 spawn 才并入 system prompt；目录段注入文本里写明"可直接 Read `<path>/CLAUDE.md`"作为兜底。

### E. 可见性（粘性状态）

- **display 双定义同形**（红线）：`agent-sidecar/src/engine/types.ts:86` 与 `packages/aide-sdk/src/types/chat.ts:357` 的 mention 成员同步加 `isDir?: boolean`，各补一句"两份必须同形（漂移静默失效）"。`headless-schema.ts:48` displayBlock 是宽松透传，无需改。旧端忽略未知字段，仍渲染成合成 Read 卡（`events.ts:176-187`）。
- **`packages/aide-sdk/src/composables/useSessionAttachedWorkspaces.ts`**（新增，与 `useSessionWorkspaces` 同构）：`attachedOf(sid)` / `setAll(sid, dirs)`（事件全量回灌）/ `migrate(temp→real)`（挂进 `finalizeSession` 链）/ `removeWorkspace` / `clearAll`（挂进 `__resetForTest` 复位链）。
- **`useChatSession/events.ts`**：`blocksFromDisplay` mention 分支透传 `isDir`；`handleChatEvent` 加 `case "workspace_attached"`。
- **桌面最小 UI**：`ChatPanel.vue` 输入区上方一条只读 chip 条（样式走主题 token，不新造）。不做移除按钮——要解除就开新会话（如需解除再议）。
- **不用 display 块当粘性状态源**：display 是 per-message 渲染描述，重开历史虽可见但不构成"当前授权"账本；且 PWA/鸿蒙发的消息没有 display，靠它推账本会端间漂移。

## 明确不做（附加根下这些仍只服务主根）

git 面板（30+ 命令绑活动工作区，仅 `git/status.rs:29`、`git/operations.rs:50`、`git/diffpair.rs:426` 支持 cwd 覆写）、文件监听（`filewatch.rs:131-192` 单 ActiveWatch）、LSP（`lsp/mod.rs:89-96` 信任门 + per-root server）、codegraph（`codegraphTools.ts:141-158` 单 cwd 闭包，第二仓查询降级 "index not built for this project"）、策略广播路由（`chat.rs:314` 单根 route）、文件树/编辑器。

## 风险与 spike（动手前先跑）

| # | 风险 | 缓解 |
|---|---|---|
| R1 | **`applyFlagSettings` 对存量 query 扩根是否真生效**（类型通道成立 `sdk.d.ts:2616/5682`，仓库无先例） | spike S1；失败则账本兜底（下次 spawn 生效），必要时再补 abort 重建 |
| R2 | **`manual` 模式下是否弹窗**（`auto` 默认不弹已由 F1 事实链支持；CLI 自身对 cwd 外写工具的行为未经实测） | spike S2。若弹：sidecar 授权时 `policy.addSessionRules`（`sessionHook.ts:66`，会话级规则随 worker 销毁，粘性语义天然一致，path/folder 形态见 `policy/types.ts:22-33`）；**不要**走 `deriveRememberRule` 持久化链——粘性授权不该落盘 |
| R3 | CLI 是否已为 add-dir 自动加载对方仓的 MEMORY.md（若加载则我们再注入 = 双份） | spike S3 看 `context_usage.breakdown.memoryFiles`（`engine/types.ts:100`）；MEMORY.md 注入先由常量控制 |
| R4 | 路径形态（`\\?\`、正反斜杠、大小写、UNC） | Rust 侧 `dunce::simplified` 统一输出原生绝对路径；spike S4 覆盖 |
| R5 | 未芯片化的 `@目录` 字面量留在 prompt 里但未授权，模型可能自己去读（默认配置下放行） | 接受：Rust 裁定是唯一授权入口；把未芯片化文本也拉进授权等于开任意路径后门 |
| R6 | 授权后 `register_session_route` 仍只挂主根（`chat.rs:314`） | 本次授权不落盘成规则，无实际影响；记入"不做清单" |

**spike 清单**：S1 活体扩根（会话 id 未变 + 无 applyFlagSettings error + 能读仓 B）／S2 弹窗行为（切 manual 写仓 B）／S3 记忆归属／S4 路径形态。

## 验收（端到端）

1. 打开已注册工作区 A 的会话，输入 `@<仓B根>` + 空格 → 出现目录芯片。
2. 发"看看 B 仓的 xxx 接口，把 A 仓调用方一起改掉" → 气泡出现目录引用卡 + 输入区粘性 chip 条。
3. 模型能读并**编辑成功** B 仓文件；A 仓文件同样可编辑。
4. `@C:\Windows`（未注册）→ 无授权效果、Rust 有 reject 日志。
5. 再发 3 条（含忙碌排队插队一次）→ 授权仍有效；`workspace_attached` 只在账本变化时广播全量。
6. 杀 sidecar 进程触发错误重连 → 下一轮 spawn 带全量 `additionalDirectories`，授权恢复。
7. manual 模式 + 对附加目录写文件 → 按 S2 结论验证。
8. remote-pwa 连同一会话 → 能看到同一 chip 条；PWA 发带 `additionalDirs` 的消息 → 桌面端 chip 条同步。

## 测试清单

- **sidecar vitest**：`attachDirs.test.ts`（merge 去重含大小写/正反斜杠/尾分隔符；无新增 no-op；query=null 只落账；成功传**全量**；失败 commit 不回滚 + error）；`instructions.test.ts` 扩（附加根注入带来源头、超限诊断、总预算、MEMORY.md 路径解析）；`queryContext.test.ts` 扩（透传）；`headless-server.test.ts` 扩（`additional_dirs` 形状）；`session-worker` 用例（两轮各带不同目录 → 第三次 spawn 含两者）。
- **Rust `cargo test --lib`**：`workspace/attach.rs`（注册表根/子目录命中、未注册拒、不存在拒、文件拒、尾反斜杠归一、主根子树剔除、去重）；`chat.rs` 扩（`cmd["additional_dirs"]` 形状、空/全非法不落字段、无参数时字段缺席）；`remote/rpc/handlers.rs` 扩（透传）。过滤跑，禁全量双跑。
- **前端 vitest**：`fileMentions.test.ts` 扩（目录分支、标记拆回含旧格式回归、`listDir` 缺省旧行为、尾反斜杠归一、`attachedDirsFrom` 过滤主根子树）；`useInlineMention.test.ts` 扩；`useSessionAttachedWorkspaces.test.ts` 新；`ChatInputBox.test.ts` 扩（目录 → `additionalDirs`；纯文件 → 空）；`useChatSession.test.ts` 扩。

## 分阶段落地

1. **spike S1–S4**（半天，先证核心命题，失败就改方案而不是硬推）
2. 授权链路（A+B+C）——此时已可用，agent 能读写第二个仓
3. 记忆注入（D）——对方的 CLAUDE.md / 记忆进上下文
4. 事件账本与可见性（E）
