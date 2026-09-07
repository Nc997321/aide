# 工作区显式注册（registry）实现计划

> 实现阶段 REQUIRED：每个 Task 完成后跑 `cargo test --lib`；全部完成后派发 `code-architect:rust-reviewer` 独立送审（写码者不自评），覆盖率对账表以实测证据定稿。

**Goal:** 工作区列表从「扫 `~/.aide/claude/projects/` 推导」改为「显式注册表」（state.json `registeredWorkspaces`），用户动作登记产生、`list_workspaces` 只读注册表。内部目录在结构上不可能再混进侧栏，`try_decode` 猜错产生的假 warning 消失，孤儿条目语义清晰。

**背景（事故链，2026-09-07）:**
automation 任务转录落全局 `~/.aide/claude/projects/` → `list_workspaces()` 全量扫描 → 侧栏多出 `automations-aut-xxx` 伪工作区。已做止血（7adda12 / 3750904 / e9255cb）：写侧隔离到 `~/.aide/scopes/<kind>/<id>/claude` + 读侧多根对称查找——**绕开了猜机制的误伤面，但机制本身没变**：任何以 cwd 身份往全局 projects 落转录的内部流程仍会污染侧栏；`try_decode`（workspace/mod.rs:1026）对 SDK 的 `.`→`-` 编码反向解码不了 → 猜不准就标「路径不存在」warning 三角；删除项目后的孤儿条目依赖目录存在性。

**Architecture:** 纯核心 + 薄外壳。注册表数据模型与解析/登记/派生全部是纯函数（新子模块 `workspace/registry.rs`，吃 `serde_json::Value` + `&str`，IO 谓词注入）；命令层（`workspace/mod.rs`）只做「拿数据 → 调核心 → 送回结果」。注册触发点四处，全部幂等（按 key 去重）：`create_workspace`（打开目录）、`send_message` 的 cwd ensure（首聊回落 home 的隐式工作区照常出现）、启动一次性迁移、`unhide_workspace`。`WorkspaceInfo` DTO 形状不变，桌面/remote-pwa/ohos 三端零改动跟随。

**Tech Stack:** Rust（Tauri v2 命令、tokio spawn_blocking、serde_json、std::fs）。前端与远程协议零改动。

## Global Constraints

- async 命令带 `State<'_, T>` 必须返回 `Result`；重 IO 进 `spawn_blocking`（`list_workspaces` 现状保留）；async 命令不埋 `trace_command`。
- 跨平台：路径只用 `PathBuf`/字符串透传，不新引入 `\\` 字面量；本功能无 spawn，不涉 `CREATE_NO_WINDOW`。
- 纯核心纪律：`registry.rs` 的核心函数不碰 IO/时钟——`now_ms` 由外壳注入、`exists` 由闭包注入，脱离环境可单测。
- 注册表写一律走 `with_state_mut`（CONFIG_LOCK 临界区 + 原子 rename）；**每消息路径上禁止无条件写盘**——`with_state_mut` 恒 save（settings.rs:497），ensure hook 必须先只读预检命中即返回。
- 降级容忍：旧版重扫目录 → 注册表条目是超集（照常显示）；用户隐藏过的经 `hiddenWorkspaces` 兼容写不复活。

## 设计决策（已对账）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 注册表住 **state.json `registeredWorkspaces`** 数组，不另立 `~/.aide/workspaces.json` | hidden/trusted/lsp/codegraph/jdk 全部已住 state.json，同一写路径（`with_state_mut` 原子写 + `CONFIG_LOCK`）；另立文件只多一个并发面与迁移面。用户原话「比如 ~/.aide/workspaces.json」是示例，按现有状态体系归位 |
| D2 | 条目 `{ key, path, addedAt }`：**path 是身份主人**（用户给的），**key 注册时由 `path_to_key(path)` 算出后冻结** | key 是 sessions/recent/lsp/codegraph/jdk 各段共用的身份，冻结保证与磁盘转录目录的对应不随后续编码规则漂移；同一目录斜杠变体（`C:/a` vs `C:\a`）`path_to_key` 后同 key，天然去重 |
| D3 | `name` = 注册的 path，**不再解码 key**；`try_decode` 退出 list 路径 | 注册表存的就是真实路径，「猜」的 UI 态（假 missing 三角）从根上消失。`resolve_path_from_key` 仅存于迁移解码与启动恢复回退 |
| D4 | **missing 语义翻转**：注册的 path 磁盘不存在 → `missing=true` | 从「解码猜失败」（噪音）变成准确信号；PWA「目录已失效」/桌面警告三角变准；孤儿条目右键移除即从注册表摘除 |
| D5 | `hiddenWorkspaces` 降级兼容：list 不再读；remove-hide 仍写；迁移跳过 | 降回旧版（重扫目录）时用户隐藏过的不复活；`filter_hidden`/`hidden_keys` 保留服务迁移与兼容写 |
| D6 | 注册触发点 = 用户动作，不是扫描：打开目录 / send 的 cwd / 一次性迁移 / unhide | send 的 cwd 是用户动作（发消息）产生的已知事实，登记而非扫描；内部流程（automation）走 scopes 不经过此钩子，双层保险 |
| D7 | `create_workspace` 删掉 `create_dir_all(编码目录)` | 注册不伪造目录；SDK 实际写的是横杠形态目录，旧的点号目录本来就没人写；sessions 扫描对缺失目录已有容错 |
| D8 | `remove_workspace delete` 加固为 `resolve_project_dirs` 全变体删除 | 修既有缺口：原实现只删点号形态目录，SDK 写的横杠形态转录残留 |
| D9 | 自动发现丢失 → v1 接受，不做导入入口 | 升级时迁移一次性补齐全部历史；之后 aide 内会话经触发点自愈；外部手跑 claude 的会话不再自动出现（挂起项：设置面板「扫描导入」按钮） |
| D10 | 不引入工作区变更广播事件 | 现状 PWA/ohos 也是启动时拉一次 list，本改动保持 parity（挂起项：`workspaces_changed` 事件推三端） |

**明确划界（不改）:** `memory_observatory` 的 **Rust 扫描**（观测的是数据目录，scope 列表来自有记忆数据的项目；其前端 scope 标签经 `useWorkspaces` 消费工作区列表，DTO 形状不变即自动跟随）；`list_sessions` / `list_sessions_for_workspace` / `find_session_jsonl_globally`（按键/按 id 找转录，与列表来源正交）；`trustedWorkspaces` / `lsp_workspaces` / `codegraph_workspaces` / `workspace_jdks` 各段（key/path 键控，与注册正交）；remote `REGISTRY` 白名单（无新命令）。

## File Structure + 签名地图

**Rust（`src-tauri/src/commands/workspace/`）**

新子模块 `registry.rs`（纯核心 + 薄外壳；mod.rs 已 1045 行超拆分线，新功能必须下沉子模块）:

```rust
/// 注册表条目——state.json `registeredWorkspaces` 数组元素（落盘 DTO）。
/// path 是身份主人；key 在注册时算出后冻结（与磁盘转录目录对应）。
pub struct RegisteredWorkspace { pub key: String, pub path: String, pub added_at: u64 }

// ── 纯核心（吃 Value + &str，无 IO 无时钟）──
/// 容错解析：缺字段 / 非数组 / 元素坏 → 逐条跳过，整体不炸。
pub fn registered(config: &serde_json::Value) -> Vec<RegisteredWorkspace>;
/// 幂等登记：normalize 后算 key，dup key → 不动既有条目（path 主人是先登记者）返回 false。
pub fn register_in_config(config: &mut serde_json::Value, path: &str, now_ms: u64) -> bool;
/// 按 key 摘除（不存在 noop）。返回是否摘了。
pub fn unregister_in_config(config: &mut serde_json::Value, key: &str) -> bool;
/// trim + 去尾部 `\` `/`；空串返回空串（调用方拒绝）。
pub fn normalize_registration_path(path: &str) -> String;
/// 注册表 → WorkspaceInfo DTO（key/name= path、missing= exists(path)），
/// 按 name 不区分大小写排序（对齐 NTFS 枚举序，侧栏顺序不跳变）。
/// exists 谓词注入：生产传磁盘探测，测试传闭包——核心不碰 fs。
pub fn infos_from_registry(config: &serde_json::Value, path_exists: impl Fn(&str) -> bool) -> Vec<WorkspaceInfo>;

// ── 薄外壳（IO 收口，核心不知道外壳）──
/// 启动一次性迁移：扫全局 projects 目录 → hiddenWorkspaces 跳过 →
/// resolve_path_from_key 解码 → register；marker `registeredWorkspacesMigrated` 幂等。
pub fn ensure_registry_migrated() -> Result<(), String>;
/// send_message 路径的 ensure：先只读预检（免每消息写盘），miss 才 with_state_mut。
/// 失败返回 Err 由调用方 warn（不阻塞发送）。
pub fn ensure_workspace_registered(path: &std::path::Path) -> Result<(), String>;
```

改 `workspace/mod.rs`（命令外壳，只编排）:

- `list_workspaces`：`spawn_blocking` 内读 state → `infos_from_registry(cfg, |p| Path::new(p).exists())` → 返回。黑名单过滤消失（注册表即白名单）。
- `create_workspace(path)`：校验存在 → `register_in_config` → unhide 兼容 → 激活（现状逻辑）→ 返回 `WorkspaceInfo`。删 `create_dir_all`。
- `remove_workspace(key, mode)`：`hide` = `unregister_in_config` + `hide_in_config` 兼容写；`delete` = `unregister_in_config` + 变体目录删除 + `unhide_in_config` 兼容清。两者保留「清激活」逻辑。抽出 `delete_transcript_dirs(key) -> io::Result<usize>`（`resolve_project_dirs` 全变体，返回删的目录数，可 temp-dir 单测）。
- `unhide_workspace(key)`：`resolve_path_from_key` 解码 → 可解码则 `register_in_config`（顺带兼容清 hide）；解码失败保持原语义（Err 或静默——实现时按现有调用方无 UI 入口定为静默 ok + warn log）。
- `try_decode` / `resolve_path_from_key` / `filter_hidden` / `hidden_keys` / `hide_in_config` / `unhide_in_config` **保留**（迁移 + 启动恢复 + 降级兼容消费）。

改 `chat.rs`（send_message 内，`session_cwd` 之后）:

```rust
let cwd = session_cwd(&workspace_root, &workspace_state);
// 显式注册：会话落盘前 cwd 必在注册表（幂等）。失败不阻塞发送。
if let Err(e) = crate::commands::workspace::ensure_workspace_registered(&cwd) {
    tracing::warn!(?e, cwd = %cwd.display(), "send_message: register workspace failed");
}
```

改 `lib.rs`（`run()`，seed_state_from_legacy 之后、`load_workspace_state` 之前）:

- `ensure_registry_migrated()` 失败 eprintln（与相邻迁移同款，下次启动重试）。
- 活动工作区恢复（lib.rs:73-79）改为：**先查注册表 entry.key==saved_key 取 path**，查不到再回退 `resolve_path_from_key`（try_decode 家族仅剩的运行时用途）。

**前端 / 多端：零改动。** `WorkspaceInfo` 形状不变；remote `REGISTRY` 不动；remote-pwa `workspacePathOf`（w.name=真实路径，注册路径本就是真实路径，行为一致）；ohos `ChatDrawer` missing 文案变准。

**文档:** `docs/ARCHITECTURE.md` 工作区一节（提及扫描机制的表述）改为注册表机制。

---

## Task 0（前置收口）: 桌面消费端统一到 `useWorkspaces` 单例

**为什么前置:** 换数据源前先把消费收口——桌面 9 个消费点里 8 个已走 `useWorkspaces` 模块级单例（SidebarLeft / AutomationTaskEditor / MemoryObservatory / PaneGroup / App.vue / onboarding WorkspaceStep / useRunProject / useRunProcess），唯一例外 **`src/ui/WorkspacePicker.vue:53`** 自持 `list` ref 直调 `api.listWorkspaces()`（第二份列表状态，FileTree 与 hero VariantMorning 在用）。不收口不致命（它也汇到同一 IPC 命令，契约不变则透明），但数据源切换时留两份状态源违背门面红线（子系统状态收口，禁止散落），改数据源正是收口时机。

**Files:** Modify `src/ui/WorkspacePicker.vue`；其测试改 mock `useWorkspaces`。

**Steps:**

1. WorkspacePicker 删内部 `list` ref 与直调 `api.listWorkspaces()`，改消费 `useWorkspaces().workspaces`；**每次展开经 `refresh()` 重拉**（实证修正：原实现即「每次展开重拉」而非计划预写的「只拉一次缓存」——测试断言的「只拉一次」指关闭不重复调；refresh 顺带刷新共享列表，侧栏同步受益，IPC 成本与原来持平）。
2. `WorkspacePicker.test.ts`：mock 边界保持 `@aide/sdk/api`（链路变为 composable → api 壳 → 同一实例）；`openAndLoad` 改**可控解析**（fetch 挂起 → 断言加载态 → release 放行）——原「加载中…同步可见」断言依赖旧链路多一跳微任务竞速，deferred 化后契约确定。
3. `pnpm vitest run src/ui/WorkspacePicker.test.ts`（14/14）+ `pnpm vue-tsc --noEmit` 全绿。
4. Commit: `refactor(ui): WorkspacePicker 收口到 useWorkspaces 统一状态层`

**收口后的消费地图（全部汇到 `invoke("list_workspaces")` 单命令）：**
桌面 9 点全走 `useWorkspaces`；remote-pwa App.vue 直调 api（PWA 单窗薄客户端，App.vue 即其状态层，分层惯例）；ohos ChatDrawer 走筛副本 api.ets。三端无任何消费端依赖 Rust 侧实现细节（扫目录 / try_decode 都在 IPC 契约之后）。

---

## Task 1: `registry.rs` 纯核心 + 单测（TDD）

**Files:** Create `src-tauri/src/commands/workspace/registry.rs`；`workspace/mod.rs` 加 `mod registry;` 与 re-export。

**Interfaces:** 上表纯函数 5 个；消费 `path_to_key`（mod.rs 既有）。

**Steps:**

1. 写失败测试（`registry.rs` `#[cfg(test)]`，纯函数直接断言 `serde_json::Value`，无需 mock）：
   - `registered_missing_field_returns_empty` / `registered_malformed_section_returns_empty` / `registered_skips_bad_entries`（缺 path 或 key 的元素跳过）
   - `register_in_config_appends_entry` / `register_in_config_is_idempotent_by_key`（dup key → false，原条目 addedAt 不动）/ `register_normalizes_path_before_keying`（trim、去尾分隔符）/ `register_collapses_slash_variants_to_same_key`（`C:/a` 与 `C:\a` 同 key 去重）
   - `unregister_in_config_removes_by_key` / `unregister_missing_key_noop` / `unregister_malformed_section_noop`
   - `infos_derive_key_name_missing`（exists 闭包返回 false → missing=true）/ `infos_sorted_by_name_case_insensitive` / `infos_empty_registry_empty`
2. 跑测试确认编译失败（函数未定义）。
3. 最小实现（`registered` 解析 + `normalize` + `register`/`unregister` 幂等 + `infos` 派生排序）。
4. `cargo test --lib commands::workspace::registry` 全绿。
5. Commit: `feat(workspace): 注册表纯核心（解析/登记/摘除/DTO 派生）`

**对账点:** 核心函数零 IO 零时钟（`now_ms`/`exists` 注入）；非法值造不出来——key 只能由 `path_to_key` 派生，不接收外部 key 入参。

---

## Task 2: 启动迁移 + 活动工作区恢复（外壳）

**Files:** Modify `registry.rs`（`ensure_registry_migrated`）、`lib.rs`、`workspace/mod.rs`（`mod` 声明后 re-export）。

**Steps:**

1. `ensure_registry_migrated()`：marker `registeredWorkspacesMigrated` 已真 → Ok。否则扫 `claude_projects_dir()`：目录 key ∈ `hidden_keys(load_state())` → 跳过；`resolve_path_from_key(&key)` None → 跳过；Some(path) → `register_in_config(path, now)`；收尾写 marker。全程 `with_state_mut` 单临界区。
2. 测试（temp HOME 不可行则把扫描核心参数化照 `session_config_roots_in` 范式：`ensure_registry_migrated_in(aide_base, projects_dir)` 纯扫+注册，生产壳传真实路径）：
   - `migrates_decodable_dirs_skips_hidden_and_undecodable`（造 `C--aide-mig-test-x` 目录 + 解码必失败目录各一；断言前者入表、后者不入）
   - `migration_marker_is_idempotent`（二次调用不再追加）
3. `lib.rs`：`seed_state_from_legacy` 块之后插 `ensure_registry_migrated()`（失败 eprintln）；活动工作区恢复改为注册表优先、`resolve_path_from_key` 回退。
4. `cargo test --lib commands::workspace` 全绿。
5. Commit: `feat(workspace): 启动一次性迁移（扫目录播种注册表）+ 活动工作区恢复走注册表`

---

## Task 3: `list_workspaces` 改注册表源

**Files:** Modify `workspace/mod.rs`。

**Steps:**

1. 替换实现：`spawn_blocking(|| { let cfg = settings::load_state(); Ok(registry::infos_from_registry(&cfg, |p| std::path::Path::new(p).exists())) })`。黑名单过滤、`resolve_path_from_key`、目录遍历全部移除。
2. 现有测试不回归（`list_workspaces` 本体无单测——IO 壳；纯派生已被 Task 1 覆盖）。
3. `cargo test --lib commands::workspace` 全绿。
4. Commit: `feat(workspace)!: list_workspaces 改读显式注册表`

---

## Task 4: 登记/移除命令改造

**Files:** Modify `workspace/mod.rs`（`create_workspace` / `remove_workspace` / `unhide_workspace`）；`registry.rs`（`delete_transcript_dirs` 可测 helper）。

**Steps:**

1. `create_workspace`：`register_in_config`（normalize 后的 path）+ 既有 unhide 兼容 + 激活；删 `create_dir_all`。
2. `remove_workspace`：按 D5/D8 语义改；抽出 `delete_transcript_dirs(projects_dir: &Path, key: &str) -> io::Result<usize>`（`resolve_project_dirs` 全变体 `remove_dir_all`，返回删除数；生产传 `claude_projects_dir()`）。`delete` 模式 spawn_blocking 不变。
3. `unhide_workspace`：解码 → 登记。
4. 测试（temp dir）：
   - `delete_transcript_dirs_removes_all_encoding_variants`（造点号/横杠两目录，断言都删、返回 2）
   - `delete_transcript_dirs_missing_key_returns_zero`
5. `cargo test --lib commands::workspace` 全绿。
6. Commit: `feat(workspace)!: 登记语义改造（create 注册化 / remove 摘表+变体删除 / unhide 重登记）`

---

## Task 5: send_message cwd ensure hook

**Files:** Modify `chat.rs`、`registry.rs`（`ensure_workspace_registered`）。

**Steps:**

1. `ensure_workspace_registered(path: &Path)`：空路径 Err；只读预检 `registered(&load_state())` 命中 key → Ok（免每消息写盘）；miss → `with_state_mut(register_in_config(now_ms))`。
2. `chat.rs` `send_message` 内 `session_cwd` 之后接 hook（代码见上文地图）；失败 `tracing::warn` 不阻塞。
3. 测试：`ensure_workspace_registered_is_idempotent`（首次 true 登记、二次预检零写盘——断言方式：登记后改 path 字段为哨兵值再调 ensure，注册表不变）。
4. `cargo test --lib` 全绿 + `cargo build`。
5. Commit: `feat(chat): send 会话 cwd 幂等登记进工作区注册表`

---

## Task 6: 文档 + 全量回归

**Steps:**

1. `docs/ARCHITECTURE.md`：工作区发现机制表述改为「显式注册表」（含 scopes 隔离与注册表的双层防线关系）。
2. `cargo test --lib` 全绿（现有 hidden/filter 纯函数测试保留——迁移与降级兼容仍消费它们）。
3. 手动验收清单：
   - 升级场景：删 marker 重启 → 历史（含隐藏过的）工作区如常出现，隐藏过的不复活；`automations-aut-xxx` 类不可解码目录不再出现。
   - 打开目录 → 登记 + 激活；同目录二次打开幂等不重复。
   - 右键 hide → 消失；重开同目录 → 恢复。
   - delete → `resolve_project_dirs` 变体目录全部清掉。
   - 新装首聊（无活动工作区回落 home）→ home 工作区出现在侧栏（ensure hook 路径）。
   - 注册的路径改名/删除 → warning 三角（准确）；右键移除后消失。
   - remote-pwa / ohos 工作区抽屉列表正常、missing 文案准确。
   - 记忆观测台 scope 按钮不回归（划界项）。
4. Commit（若有修复）: `fix(workspace): 验收修复`

---

## 覆盖率对账表（实现时以实测替换，禁止静态填表冒充）

| 分支 | 覆盖 | 测试名 |
|---|---|---|
| registered：缺字段 / 坏段 / 坏元素跳过 | Task 1 实测 | `registered_missing_field_returns_empty` / `registered_malformed_section_returns_empty` / `registered_skips_bad_entries` |
| register：新增 / dup 幂等 / normalize / 斜杠变体塌缩 | Task 1 实测 | `register_in_config_appends_entry` / `register_in_config_is_idempotent_by_key` / `register_normalizes_path_before_keying` / `register_collapses_slash_variants_to_same_key` |
| unregister：命中 / miss noop | Task 1 实测 | `unregister_in_config_removes_by_key` / `unregister_missing_key_noop` |
| infos：missing 两态 / 排序 / 空表 | Task 1 实测 | `infos_derive_key_name_missing` / `infos_sorted_by_name_case_insensitive` / `infos_empty_registry_empty` |
| 迁移：解码登记 / hidden 跳过 / 不可解码跳过 / marker 幂等 | Task 2 实测 | `migrates_decodable_dirs_skips_hidden_and_undecodable` / `ensure_registry_migrated_marker_is_idempotent` |
| delete 变体：多形态全删 / 无目录 0 | Task 4 实测 | `delete_transcript_dirs_removes_all_encoding_variants` / `delete_transcript_dirs_missing_key_returns_zero` |
| ensure：首登 / 预检免写 / 空 path 拒 | Task 5 实测 | `ensure_workspace_registered_is_idempotent` / 同测试哨兵断言 / `ensure_workspace_registered_rejects_empty` |
| send_message 接线（warn 不阻塞） | 未实测·未验收（外壳接线，cargo test 够不到）→ 手动验收第 5 项 + code review 核对 | — |

## Self-Review

- **DTO 对账**：`WorkspaceInfo { key, name, missing }` 三端契约不动；`name` 语义从「解码结果」变「注册路径」——对注册工作区两者恒等，对不可解码目录直接不再出现（这正是目标）。
- **单一主人**：path 主人=用户注册动作；key 主人=注册时派生冻结；`missing` 是 list 时派生视图（不落盘）；`hiddenWorkspaces` 降级兼容位（list 不再读）。
- **跨端红线核对**：工作区列表非会话事件通道管辖（现状三端均为启动拉取，parity 保持）；send hook 在桌面 Rust 单点，PWA/ohos 发消息经同一 send_message 自动覆盖。
- **划界核对**：observatory / sessions 查找 / trust 等段 / REGISTRY 均未触碰。
- **已知残留债**（不在本计划）：`workspace/mod.rs` 仍超 1000 行（仅移除了将新增的部分）；外部手跑 claude 的会话不再自动出现（D9 挂起项）；工作区变更无跨端事件（D10 挂起项）。