# 变更「改前」的来源端口 + 基线源（设计）

日期：2026-09-28
状态：**待评审**
起因：用户实测报告——面板「全部文件」里点任何文件，diff 窗口显示 `⋮ N unchanged lines ⋮`（两侧逐字节相同），而面板记着该文件 +29 −30。
相关：`docs/superpowers/specs/2026-09-24-turn-change-card-design.md`（结算卡，本轮刚落地，其展开清单走同一条 diff 通路）

---

## 1. 根因（已定案，非猜测）

「累计视图」比的是 **当前 HEAD → 工作区**：

| 事实 | 位置 |
|---|---|
| 树上的行被主动掏空片段，强制走累计 | `src/components/ChangeLogPanel.vue:78-80`（`openDiffFromTree` → `asTouchedFile`） |
| `useDiffWindow` 再按 `segments.length === 0` 嗅探一次 | `src/composables/useDiffWindow.ts:31-34` |
| 累计视图 = `HEAD:<path>` ↔ 工作区文件 | `src-tauri/src/commands/git/diffpair.rs:371-385` |

于是：**agent 在轮末提交之后，工作区 == HEAD，每一行都"无差异"。**

而这个 `HEAD` 在语义上**谁都不是**：

- 对「全部文件」这棵树（跨轮视图），"改前"应该是**会话首提交**；
- 对「轮次」那一侧，应该是**本轮开轮时的提交**；
- 今天两者都用"此刻的 HEAD"——一个会随提交漂移的参照，所以它不是"基线"，是"漂移点"。

轮次那一侧还叠了一层：轮记录里只有 `.jsonl` 字节锚点（`rewindTo`），**没有任何"改前"的内容引用**；内存里的片段在落盘时被剥掉（`stripRuntimeFields`，`useConversationChanges.ts:86-92`），重启后轮也只能退回同一个漂移的 HEAD。

**这不是"少一个功能"，是三处结构问题**（见 §3），所以按端口而非补丁来做。

---

## 2. 目标与成功判据

| # | 判据 |
|---|---|
| 1 | 一轮改完文件、agent 提交后**不重启**：轮次行给本轮精确片段（现状已成立）；「全部文件」行给**会话以来**的变化（新） |
| 2 | **重启 app 之后**：轮次行仍能给出该轮的改动（用轮首基线）；「全部文件」行仍给会话以来的变化（会话首基线） |
| 3 | 基线缺失/失效 → **退回今天的 HEAD 累计**：窗口照开、内容不出错、标注写明为什么降级 |
| 4 | 新增一个内容来源，只需**加一个适配器文件 + 装配处一行**，不改消费者 |

---

## 3. 现状的三处结构问题

| 问题 | 位置 | 为什么是补丁式的土壤 |
|---|---|---|
| **选源写在两处** | `ChangeLogPanel.vue:78-80` 掏空片段伪造口径；`useDiffWindow.ts:31-34` 嗅探空数组 | 同一件事两个决定点；加第三个来源要同时改两处 |
| **哨兵当开关** | `TouchedFile.segments: []` 既表示"无片段"也表示"请走 git"（类型注释自陈，`packages/aide-sdk/src/types.ts:263-270`） | 签名不表达意图；调用点看不见口径 |
| **源隔着语言边界，且参数靠约定** | git 源是 Tauri 命令（`diffpair.rs:418`），参数 `staged: Option<bool>` + `commit_hash: Option<String>` 靠约定不共存 | 换源要动 JS + Rust；再加 `base_rev: Option<String>` 就是**两个相邻可选字符串**（违反参数铁律），必须先收口 |

---

## 4. 设计

### 4.1 端口（领域侧只认它）

文件布局照 `api.ts + api/*` 的既有范式：**组织文件在上层、子实现同名子目录**。

```
src/composables/diffSource.ts        端口类型 + 有序链 + 口径语义（唯一选择处）
src/composables/diffSource/segments.ts   适配器：本轮内存片段
src/composables/diffSource/git.ts        适配器：git —— 参数是"跟哪个提交比"，含兜底
```

```ts
/** 看哪个口径的"改前"——由**消费者声明**，不靠数据形状推断。 */
export type DiffScope = "round" | "session";

export interface DiffRequest {
  row: TouchedFile;          // 路径/状态；row.segments 只在 round 口径且内存里还在时有效
  scope: DiffScope;
  workspaceRoot?: string;    // 会话所属工作区根（git cwd）
  baseRev?: string;          // 该口径的基线提交；缺失 = 无基线（走兜底）
}

export interface DiffContentSource {
  id: "segments" | "git";    // 将来可加 "segments-persisted" 等
  available(req: DiffRequest): boolean;   // 纯判定，不取数
  build(req: DiffRequest): Promise<WindowDiff>;
}

/** 唯一选择处。加来源 = 加一个适配器 + 这里一行。 */
const CHAIN: DiffContentSource[] = [segmentsSource, gitSource];
```

- `segmentsSource.available` = `req.scope === "round" && req.row.segments.length > 0`。
  **口径来自声明**：树上那些行不再被掏空片段来"假装"累计，它们声明 `scope: "session"`。
- `gitSource` 覆盖两种情形（同一个机制，只差"跟哪个提交比"）：
  - 有 `baseRev` → `Since(rev)`：`<rev>:path` ↔ 工作区；
  - 无 `baseRev` → `Unstaged`：今天的 `HEAD` ↔ 工作区（**兜底，行为不变**）。
  - `baseRev` 取不到（rebase / GC 之后那个提交不可达）→ 自动重试 `Unstaged`，并在标注里写明降级（§4.5）。

公开入口形状（消费者只碰它）：

```ts
// useDiffWindow
openDiff(row: TouchedFile, opts: { scope: DiffScope; workspaceRoot?: string; baseRev?: string }): Promise<void>
```
`scope` 必填——**口径是调用点的显式声明**，这是本设计要买的东西。

### 4.2 谁声明什么口径

| 消费者 | scope | baseRev |
|---|---|---|
| 变更面板「全部文件」树 | `session` | `sessionBaseRev(rounds)` = 第一个带 `baseRev` 的轮的那个值（会话起点） |
| 变更面板轮次行 | `round` | 该轮记录的 `baseRev` |
| 结算卡展开后的文件行 | `round` | 该轮记录的 `baseRev` |

`sessionBaseRev(rounds)` 是端口模块里的纯函数（含单测）。

### 4.3 基线从哪来（落盘）

- 类型加一个字段：`ChangeRound.baseRev?: string`（`packages/aide-sdk/src/types.ts`）+ Rust `ChangeRoundData.base_rev: Option<String>`（`#[serde(default)]`，`commands/mod.rs:158-167`）。落盘仍走既有的 `save`/`append`，`stripRuntimeFields` **不动它**（它不是运行时态）。
- **语义**：该轮的"改前"= **开轮那一刻**该会话工作区仓库的 HEAD 提交。
- **时机**：`startRound`（状态 → running）时取一次 `git rev-parse HEAD`，**与 `.jsonl` 字节锚点同批**。选开轮而不是"首次文件事件"的理由：**不依赖 fs 事件链的时序**——事件订阅失败时（`attachLiveRefresh` 已有该降级）首次触碰会晚到提交之后，基线就取成了提交后的 sha；开轮时刻一定在 agent 第一次编辑之前。
- **成本**：实测 `git rev-parse HEAD` ≈ **101 ms/次**（本机，温启动；代码注释里"每 spawn ~1s"是冷启动的悲观值），放在 `pendingOp` 后台链上，不阻塞发消息。纯聊天轮也会付这 101ms——**换的是"绝不依赖事件时序"**，值得。
- **失败**：取不到（非 git 仓库 / 命令失败）→ 不写该字段 → 链自然降级。非 git 工作区可缓存"无仓库"结论，避免每轮白掏一次 spawn。

### 4.4 Rust 侧

1. **参数收口**（消掉"两个相邻可选字符串"）：

```rust
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiffMode {
    Unstaged,                 // HEAD → 工作区（今天默认）
    Staged,                   // HEAD → 索引
    Commit { hash: String },  // h^ → h
    Since { rev: String },    // rev → 工作区（新）
}
pub async fn git_diff_pair(ws: State<'_, WorkspaceState>, path: String, mode: DiffMode, cwd: Option<String>) -> Result<DiffPair, String>
```
2. **新增取基线命令**：`git_head_rev(cwd: Option<String>) -> Result<Option<String>, String>`（`git rev-parse HEAD`；非 git 仓库返回 `None` 而不是错误）。`async` + `spawn_blocking`、复用 `git_run`（**已带 `CREATE_NO_WINDOW`**，见 `commands/git/runtime.rs`）。
3. **不做**：`git_diff_pair` 的既有三种模式语义一字不改（收口只是形状）。
4. **协议**：`git_diff_pair` / `session_changes` / `git_revert` 均**不在远程 REGISTRY**（已核 `src-tauri/src/remote/rpc.rs` 无匹配）⇒ 本笔不动协议、不动 REGISTRY。

### 4.5 标注文案（note 与标签）

`oldLabel → newLabel` 由 Rust 侧给：`Since(rev)` → `<短号> → 工作区`（今天 `HEAD → 工作区` 的形制）。

`oldLabel → newLabel` 由 Rust 侧给：`Since(rev)` → `<短号> → 工作区`（今天 `HEAD → 工作区` 的形制）。**短号只在 Rust 侧截一次**（沿用 `commit_hash` 模式里 `&h[..7]` 的做法）；TS 侧的 note 直接引用 `pair.oldLabel` 里的短号，不另做一次截断。

`WindowDiff.note` 五种落点，**如实说明来源**：

| 落点 | note |
|---|---|
| 片段 | 无（今天如此） |
| `Since(rev)` · round | `自开轮时的 <短号> 到工作区（本轮视图）` |
| `Since(rev)` · session | `自会话起点的 <短号> 到工作区（会话视图）` |
| `Since(rev)` 取不到 | `基线 <短号> 已不在仓库中，退回 HEAD 累计` |
| 兜底 `Unstaged` | `累计视图：显示该文件相对 HEAD 的全部差异（非本轮片段）`（**今天的句子保留**） |

### 4.6 依赖方向（可 grep 验收）

- `api.gitDiffPair` / `api.gitHeadRev` 的引用**只允许出现在 `diffSource/git.ts`**；`useDiffWindow` / 面板 / 卡片只认端口。
- 验收：`grep -rn "gitDiffPair\|gitHeadRev" src packages --include=*.ts --include=*.vue | grep -v diffSource/git.ts | grep -v "\.test\.ts"` 只应命中 **api 门面自身**与 Git 面板的两个调用点（`GitPanel.vue:196` / `GitCompare.vue:113`）。后两者**不受端口约束**（它们是另一条既有通路：Git 面板直接看仓库），但本笔的 `DiffMode` 收口会改到它们的**调用写法**（语义不变）。

---

## 5. 边界与不做的事

| 项 | 决定 | 理由 |
|---|---|---|
| 持久化片段（`touches` 落盘） | **不做** | 体积（每片段存旧/新全文）；基线 sha 已解决主诉 |
| 逐文件基线（每文件一个 sha） | **不做** | 实现重一截；轮首粒度已够（用户已确认口径） |
| 跨目录会话的文件（@授权别的项目） | **基线不生效**，退化为 HEAD 累计 | sha 属于会话仓库、文件在另一个仓，取不到是必然；与今天表现一致，不倒退 |
| 老会话（无 `baseRev` 的历史轮） | 不追溯 | 基线无法事后得知；退化为今天的行为 |
| `DiffViewer` / 文件查看器渲染 | 不动 | 只换 `WindowDiff` 的来源与标注 |
| sidecar / 协议 / REGISTRY / 落盘格式的既有字段 | 不动（只**加**一个可选字段） | §4.4.4 |
| 「全部文件」树的聚合口径（跨轮合并） | 不动 | 本笔只改它的"改前"，不改它的"合并" |

---

## 6. 测试与验收（全部可自测，不需要用户）

| 要证明的事 | 手段 |
|---|---|
| **报告场景**：改文件 → 提交 → 回看仍看得见 | Rust 单测，真 git 临时仓（复用 `diffpair.rs` 的 `setup_repo` 底座）：`commit v1` → 记 sha → 改文件 → `commit v2` → 断言 `Since(sha_v1)` 的 old = v1 内容、new = 工作区内容 |
| 降级：rev 不可达 | 同底座：给一个不存在的 rev → 断言退回 `Unstaged` 且 note 写明 |
| 降级：无基线（老会话） | 断言走 `Unstaged`，note 保留今天的句子 |
| 口径选对 | 端口/链单测（`scope` 与 `baseRev` 的组合矩阵）+ 组件测试（树行传 `session`、轮行与卡片传 `round`，断言解析出的 rev 分别是会话起点/本轮） |
| 选源不再靠嗅探 | 单测：`scope: "session"` 且 `row.segments` 非空时**仍**走 git（口径优先于数据形状） |
| 落盘兼容 | Rust serde round-trip（有/无 `base_rev`）；TS 侧 `baseRev` 透传与不被 `stripRuntimeFields` 剥掉 |
| 取基线时机 | 单测：`startRound` 取一次并写入轮记录；取失败不写字段；已缓存"非 git 仓库"时不重复 spawn |
| 行为不变（重构安全性） | 既有 `useDiffWindow.test.ts`（6 例，两条路径的载荷与标注语义保留）+ 面板/卡片既有用例 |
| 视觉 | 真组件截图夹具（`docs/prototypes/_harness/`，vite + 内嵌浏览器自测），核对新标注文案 |
| 真机（可选，30 秒） | 用户在报告场景里点一次「全部文件」→ 看到 diff 有内容 |

---

## 7. 已知代价与风险（每条都写明"失败往哪退"）

1. 每轮一次 ~101 ms 的 git spawn（后台链，纯聊天轮也付）→ 换来不依赖事件时序。
2. **开轮前就脏的工作区**会被算进该轮 diff（那些改动在 HEAD 里还没有）→ 标注写明"自开轮时的 `<短号>`"，不隐瞒。
3. 老会话 / 跨目录 / rev 失效 → **一律退回今天的 HEAD 累计**，绝不出现错的内容。
4. 本笔新增的三样（基线字段、取 sha、新来源）**全部是可退化路径**：任何一环失败，行为等于今天。

---

## 8. 落地切分（供 writing-plans 参考，不预设笔数）

1. Rust：`DiffMode` 收口 + `git_head_rev` + 真仓用例（含 §6 的报告场景与两条降级）
2. 类型与落盘：`ChangeRound.baseRev` / Rust `base_rev` + 兼容用例
3. TS 端口：`diffSource.ts` + 两个适配器 + 链与口径的单测；`useDiffWindow.openDiff` 改签名
4. 消费者与取基线：`startRound` 取 sha；面板树行改传 `scope: "session"`、轮行与卡片传 `round`；组件测试
5. 夹具截图 + spec 状态回写
