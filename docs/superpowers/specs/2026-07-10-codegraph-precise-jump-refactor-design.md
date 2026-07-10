# 设计文档：CodeGraph 精确跳转重构（C1+C2+M1+M2+M3）

日期：2026-07-10
状态：设计已批准，待写实施计划
上承：[2026-07-10-codegraph-design.md](2026-07-10-codegraph-design.md)（第一阶段原始设计）
起因：第一阶段实现审查暴露的两条严重问题（C1/C2）+ 三条生命周期缺失（M1/M2/M3）。

## 背景：本次要解决的问题

第一阶段 CodeGraph 落地后审查发现，它没有兑现"精确跳转"承诺，且违反项目并发红线：

| 编号 | 问题 | 根因 |
|------|------|------|
| **C1** | 结构层根本不能跨文件跳转 | `structure_lookup` 只 re-parse 当前一个文件；索引写进了向量库，查询侧却完全不读向量库，也没有任何"按符号名精确查"的通道 |
| **C2** | 所有 codegraph async 命令无 `spawn_blocking`，全程持一把 std `Mutex` | build（数十秒 parse+ONNX）在 tokio 线程同步跑并握全局锁，query/搜索框每次都阻塞排队，违反 CLAUDE.md 头号红线 |
| **M1** | 增量索引 / shard 持久化加载全是死代码 | `index_file`/`reindex_file`/`CodeShard::load`/`delete_by_file` 无命令暴露；每次打开全量重建，无 meta.json |
| **M2** | 切项目后新项目不建索引、且 goto 查到旧项目 shard | `indexBuildTriggered` 模块级 bool 永不复位；state 里是上一个项目的 shard |
| **M3** | `codegraph_close` 从未被调用 | optimize+flush 永不执行，关闭生命周期没接线 |

顺带修正若干中/次要问题（Mo1–Mo5，见 §5）。

## 核心决策（已与用户对齐）

1. **结构层跨文件检索机制**：混合方案——内存符号表负责精确查找，Qdrant shard 负责语义向量 + 磁盘持久化；打开项目时从 shard payload 重建内存表（免全量 re-parse）。
2. **并发与锁模型**：`RwLock` + 后台构建双缓冲——内存表读写分离，build 在 `spawn_blocking` 里离线构建新快照，最后一次写锁原子替换，build 期间 query 读旧快照零阻塞。
3. **范围**：全包 C1+C2+M1+M2+M3。

## 架构

### § 1. 状态结构

`CodeGraphState` 从"一把大锁包一切"改成读写分离 + 双缓冲。注册为 `Arc<CodeGraphState>`（满足 CLAUDE.md 的 `State<T>` 不能跨 `spawn_blocking`、须 Arc clone owned 进闭包的约束）。

```rust
pub struct CodeGraphState {
    inner: RwLock<Option<ProjectIndex>>,   // 双缓冲原子替换的目标
    embedder: Mutex<Option<Embedder>>,     // 懒加载一次，跨 build/query 共享
    parser_manager: ParserManager,         // 无状态，只读共享
}

struct ProjectIndex {                      // 一个项目的完整索引快照
    project_root: PathBuf,
    symbols: SymbolTable,                  // C1 核心：内存精确查找
    shard: Arc<CodeShard>,                 // 语义向量 + 磁盘持久化
    indexed_at: SystemTime,
}

struct SymbolTable {
    by_name: HashMap<String, Vec<SymbolDef>>,   // name → 全项目所有同名定义
}
```

`by_name` 是 C1 的答案：结构层查找 = 内存里按 `word` 精确匹配全项目定义，跨文件、微秒级、零 IO、不碰向量库。单项目状态（非按 project_root 分片），切项目靠 swap 替换。

### § 2. 三条数据流

**构建（`codegraph_build_index`，spawn_blocking）**
clone `Arc<State>` → 在 blocking 任务里离线走完 walk + parse + extract + embed + 建新 shard + 建新 `SymbolTable`，全程不持锁 → 最后拿一次写锁，把新 `ProjectIndex` 整个 swap 进去。build 期间 query 读旧快照，零阻塞。

**查询（`codegraph_goto_definition`，spawn_blocking）**
1. 短暂读锁 → `symbols.by_name.get(word)` 精确命中 → 返回 `Structure` 结果（跨文件生效）；命中结果按"距光标行近"排序（有 source line 时），self-reference 由前端过滤。
2. 无命中且有 embedder → clone 出 `Arc<shard>` + embedder handle，**释放读锁**，再 embed + 向量搜索返回 `Semantic`。

此改动顺带修好 Mo1 与搜索框/`searchAllReferences` 的 `file=""` 问题：内存表只靠 `word` 就能精确查，标题栏"符号"搜索和"查所有引用"从此有真正的结构层精确结果，不再退化成纯语义。

**增量（`codegraph_reindex_file`，M1，spawn_blocking）**
`useFileViewer.save()`（`useFileViewer.ts:199`）写盘成功后 fire-and-forget 调新命令 → spawn_blocking 里 `delete_by_file` + 重析单文件 + embed → 短写锁：更新 shard + 就地改 `SymbolTable`（删旧文件条目、加新条目）。单文件目标 <2s。仅当存在活跃 `ProjectIndex` 且 file 属于该 project_root 时执行。

### § 3. 生命周期与持久化（M1/M2/M3）

**磁盘布局**
```
<project_root>/.aide/index/
├── qdrant/        # Qdrant Edge shard（mmap，语义向量）
├── symbols.json   # 序列化的 SymbolTable（内存精确查找的持久化）
└── meta.json      # { version, model_name, indexed_at(epoch), symbol_count }
```

**打开/加载（M1）**：打开项目时，若 `qdrant/` + `symbols.json` 存在 + `meta.model_name` 匹配当前模型 + 无源文件 mtime 晚于 `indexed_at` → `CodeShard::load` + 从 `symbols.json` 反序列化回灌 `SymbolTable`（免全量 re-parse）；否则全量 rebuild。选用独立 `symbols.json` 而非 scroll shard payload：`SymbolTable` 本就全 serde 可序列化，落盘/加载各约 10 行、零 qdrant 分页耦合。代价是 `symbols.json` 与 shard 需在同一事务点一起写/删（build/reindex/close 三处保持一致）。

**切项目（M2）**：`detectProjectRoot` 的模块级 `bool` 守卫改成记 `lastIndexedRoot: string`，root 变化即对新 root 触发 build（build 内部 swap 自然替换旧 shard，修好"查错 shard"）。

**关闭（M3）**：workspace 关闭/切换时前端调 `codegraph_close`（现从未被调用）→ `optimize` + flush + 落 `meta.json`。

### § 4. 正确性修正（在动过的代码里顺手改）

| 项 | 问题 | 修法 |
|----|------|------|
| 点 ID | `NEXT_ID` 进程静态计数器，增量/重载会撞 ID | 换确定性哈希 `hash(file:line:col:name) → u64`，upsert 幂等、增量重入不撞 |
| Mo1 语义查询文本 | `"{word} in file {file} at line {line}"` 污染 embedding | 直接 embed `word` 本身 |
| Mo3 局部变量噪声 | `variable_declarator` 无差别入库 | 只在 `parent_class.is_some()`（类字段）时入库，跳过函数内 `const/let` 局部变量 |
| Mo5 call 取名 | `foo.bar()` 取成 `foo.bar` | 取成员表达式最后一个标识符 `bar` |
| Mo2 假注释 | store.rs 注释"5s timeout"实际不存在 | 删注释，不做真超时（embed 已在 spawn_blocking 隔离，YAGNI） |
| Mo4 gitignore | `.aide/`、`.fastembed_cache/` 未忽略 | 加入 `.gitignore` |
| 调试日志 | `useFileViewer.ts` 残留 `console.log("[codegraph]...")` | 删除 |
| 死代码 | `upsert_symbols`（零向量路径） | 删除（`upsert_with_vectors` 是唯一写路径） |

### § 5. 保留默认（用户已认可，记录以备回溯）

1. 局部变量默认**不入库**（§4 Mo3）——不支持"跳到某个函数内局部变量定义"，换取低噪声。
2. embed 不做真 5s 超时——靠 `spawn_blocking` 隔离而非超时。
3. `SymbolTable` 常驻内存（几千符号约几 MB）。

## 错误处理与降级

沿用第一阶段的降级链，并强化：

| 场景 | 行为 |
|------|------|
| 无活跃 ProjectIndex / 索引未就绪 | goto 返回空 → 前端退化为 `grepSymbol` |
| tree-sitter 不支持当前语言 | 结构层跳过，全走语义层 |
| embedder 不可用（模型缺失/加载失败） | 语义层禁用，结构层（内存表）照常工作 |
| shard 损坏 / load 失败 | 删 `.aide/index/qdrant/` 触发全量 rebuild，不碰项目代码 |
| build/reindex 失败 | 记 tracing 日志，不影响聊天/编辑；旧快照保持可用（双缓冲的额外好处） |
| `.aide/` 无写权限 | 索引静默跳过，所有查询退化为 grep |

## 测试

- **Rust `#[cfg(test)]` 单测**（按仓库 quirks 用 `cargo test --lib` 绕杀软锁）：
  - `SymbolTable` 跨文件精确查找（同名符号跨多文件全返回、排序正确）；
  - `extract` 提取正确性（类/方法/字段/枚举/接口，局部变量被跳过）；
  - 点 ID 确定性（同符号两次哈希相等，不同符号不撞）；
  - 语义降级路径（无 embedder 时结构层仍工作、goto 不 panic）。
- **前端**（沿用 `useFileViewer.test.ts` 模式）：save → reindex 触发；project 切换重建（root 变化重新 build）。

## 验收标准（对齐原设计并强化）

1. **跨文件精确跳转**：Controller 里点 Service 方法 → 直接跳到它在另一文件的定义（结构层内存表命中，`Confidence::Structure`）。
2. **符号搜索精确**：标题栏"符号"搜索输入符号名 → 返回结构层精确结果（不再纯语义）。
3. **build 不阻塞**：全量索引期间，goto / 搜索框 / 窗口交互不卡（双缓冲读旧快照）。
4. **增量 <2s**：保存单文件后，该文件的符号变更在 2s 内反映到跳转结果。
5. **切项目正确**：切换 workspace 后 goto 命中新项目符号，不返回旧项目文件。
6. **持久化复用**：二次打开同项目且无文件变更 → 走 load，不全量重建。
7. **错误不扩散**：索引任何失败不影响编辑器/聊天/Git。

## 不在本轮范围

- 增量的 Claude 侧触发（Claude 通过 sidecar 改文件不走前端 save，本轮只挂前端 `save()`；Claude 编辑后的索引更新留待后续）。
- 调用链/引用图谱可视化、FileViewer 关系侧栏（原设计"待后续阶段"部分）。
- 多语言扩展（Vue 等待 tree-sitter 0.24 兼容 grammar）。
