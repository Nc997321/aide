# 设计文档：CodeGraph — 对话式代码理解（第一阶段：增强代码跳转）

日期：2026-07-10
状态：设计已批准，尚未进入实施计划
上承讨论：[2026-07-07-lsp-alternative-conversational-code-understanding.md](../../discussions/2026-07-07-lsp-alternative-conversational-code-understanding.md)

## 目标

为 Aide 构建代码理解基础设施（CodeGraph），取代现有的纯文本 grep 级别符号跳转（`useGotoDefinition`）。第一阶段聚焦**增强代码跳转**——用户在编辑器中选中符号时，获得结构层精确跳转（tree-sitter 解析的定义/引用/调用链）和语义层兜底（Qdrant Edge 向量搜索 Top-K），两者均标注来源置信度。

这是 Aide 对话式代码理解功能的第一步，后续阶段将在此基础设施上叠加对话式流程可视化和 FileViewer 关系侧栏。

## 技术选型

| 层 | 技术 | 形态 | 理由 |
|---|------|------|------|
| 向量存储 | Qdrant Edge ([crates.io](https://crates.io/crates/qdrant-edge)) | Rust crate 内嵌，纯磁盘 mmap | 零外部进程、零常驻内存负担、对标 SQLite 资源模型 |
| 向量生成 | fastembed-rs | Rust crate 内嵌 ONNX 推理 | Qdrant 官方维护，~23MB 模型文件，首次自动下载 |
| 结构层 | tree-sitter | Rust crate 内嵌语法解析 | 零外部依赖，语法级精度对 Controller/Service/Mapper 调用链足够 |
| 嵌入模型 | `all-MiniLM-L6-v2`（默认，384 维） | ONNX 格式，随应用分发或首次下载 | 轻量通用，索引构建几秒到十几秒，不拖慢启动 |

全本地、零安装——用户打开 Aide 即用，没有 LSP 那样的常驻进程和几百 MB 内存开销。

### 初始语言支持

第一阶段 tree-sitter 解析器覆盖：Java、TypeScript/JavaScript、Python。其他语言文件结构层静默跳过（全走语义层），后续按需添加解析器。

## 目标场景

业务/中台/CRUD 形状的软件：Controller/Service/Mapper 分层、ORM/MyBatis 实体关联。操作系统级/系统编程代码明确不追求覆盖。

## 架构

### Rust 模块结构

新增独立模块 `src-tauri/src/codegraph/`，与现有 `commands/` 平级。纯 Rust 自包含，不依赖 sidecar，对外暴露 Tauri async commands。遵循项目模块组织规则：独立能力模块单文件在顶层，主控+子实现模式拆为主控文件 + 同名子目录。

```
src-tauri/src/codegraph/
├── mod.rs              # 模块入口：init / build_index / query_goto / close
├── types.rs            # SymbolDef / CallEdge / IndexedPoint / QueryResult / Confidence
├── shard.rs            # Qdrant Edge Shard 生命周期
├── embed.rs            # fastembed-rs 模型加载 + 文本→向量
├── parser.rs           # tree-sitter 语言解析器管理
├── indexer.rs          # 索引主控：全量/增量编排
├── indexer/
│   ├── walk.rs         #   文件树遍历（ignore 规则过滤）
│   ├── extract.rs      #   调 parser 提取符号 + 调用边
│   └── store.rs        #   调 embed 向量化 → shard upsert
├── query.rs            # 查询主控：结构层→语义层→合并
└── query/
    ├── structure.rs    #   tree-sitter 精确查找
    └── semantic.rs     #   Qdrant 向量搜索
```

### 依赖关系

```
query.rs ──→ query/structure.rs ──→ parser.rs
         └─→ query/semantic.rs ──→ shard.rs + embed.rs

indexer.rs ──→ indexer/walk.rs
           ├─→ indexer/extract.rs ──→ parser.rs
           └─→ indexer/store.rs ──→ embed.rs + shard.rs
```

### 核心类型

```rust
pub enum SymbolKind { Function, Method, Class, Field, Interface, Enum, Variable }

pub enum Confidence { Structure, Semantic }

pub struct SymbolDef {
    pub name: String,
    pub kind: SymbolKind,
    pub file: String,             // 项目相对路径
    pub line: usize,              // 1-based
    pub column: usize,
    pub parent: Option<String>,   // 所属类名
}

pub struct CallEdge {
    pub caller: String,
    pub callee: String,
    pub file: String,
    pub line: usize,
}

pub struct IndexedPoint {
    pub symbol: SymbolDef,
    pub source: Confidence,
    pub code_snippet: String,     // embedding 用的源文本
}

pub struct QueryResult {
    pub symbol: SymbolDef,
    pub confidence: Confidence,
    pub score: Option<f32>,       // 仅 Semantic 层有
}
```

## 数据流

### 索引侧（后台静默，不阻塞 UI）

```
项目打开 → indexer → walk 遍历文件树（ignore 过滤）
  → extract：parser 按语言解析 → 提取 SymbolDef[] + CallEdge[]
  → store：对每个 SymbolDef 的 code_snippet 调 embed 推理 → 向量
  → shard.upsert_points() 写磁盘

文件保存 → indexer 增量：
  → shard.delete_by_file(file)
  → extract + embed 单文件
  → shard.upsert_points()
```

### 查询侧（前端 invoke 同步等待，走 async command + spawn_blocking）

```
codegraph_goto_definition({ word, file, line, project_root })
  → query.rs:
    1. structure.rs：tree-sitter 在当前文件 AST 定位 word → 找定义/引用/调用边
    2. 结构层有结果 → 直接返回（Confidence::Structure，score = None）
    3. 结构层无结果 → semantic.rs：embed(word + 上下文) → shard.search(Top-K=10)
       → 返回 Confidence::Semantic + score
    4. 合并两层结果，按 confidence 优先 → score 降序排列
```

## Tauri Commands

三个新 async command，全走 `spawn_blocking`：

| Command | 输入 | 输出 | 说明 |
|---------|------|------|------|
| `codegraph_build_index` | `{ project_root: String }` | `{ total_symbols: usize, elapsed_ms: u64 }` | 全量构建，后台 block 直到完成 |
| `codegraph_goto_definition` | `{ word: String, file: String, line: usize, project_root: String }` | `Vec<QueryResult>` | 增强跳转核心命令 |
| `codegraph_close` | `{ project_root: String }` | `()` | 项目关闭：optimize + flush + drop shard |

## 前端集成

### 升级 useGotoDefinition

`search()` 改为调 `codegraph_goto_definition`：
- 索引未就绪或命令返回错误 → fallback 到现有 `grepSymbol`（保持兼容）
- 结果去重：结构层结果和语义层结果可能重复，按 `(file, line, name)` 去重，保留高置信度来源

### 触发方式

- **内联跳转**：FileViewer CodeEditor 中 Cmd/Ctrl+Click 可跳转符号 → 调 goto → 单结果直跳、多结果弹浮窗
- **浮窗搜索**：选中符号 → 快捷键或右键菜单触发 → 弹出浮窗显示全量结果列表

### 结果呈现

浮窗列表中每个结果标注来源：
- `[精确]` 绿色标签 — tree-sitter 结构层匹配
- `[语义·{score}%]` 黄色标签 — Qdrant 向量匹配
- 点击结果打开对应文件并滚动到行

### SearchProvider 接入

新增 `codegraph` SearchProvider（`useSearchProviders` 注册表），标题栏搜索框可搜符号。

## Shard 生命周期与磁盘格式

### 存储位置

```
<project_root>/.aide/index/
├── qdrant/               # Qdrant Edge Shard 数据（mmap 文件）
├── meta.json             # { version, model_name, last_indexed_at, total_symbols }
└── tree-sitter/          # 项目语言的语法 .so/.dll（按需内嵌）
```

`.aide/` 应加入项目 `.gitignore`。

### 生命周期

```
项目打开 → 检查 .aide/index/qdrant/ 是否存在
  ├─ 存在 → shard.load() → 检查 meta.json 的 model_name / last_indexed_at
  │           若模型变更或项目文件 mtime 晚于 last_indexed_at → 触发 rebuild
  └─ 不存在 → shard.create() → 后台 spawn_blocking 触发全量 build_index
项目关闭 → shard.optimize() → shard.close()（drop 自动 flush）
```

### Qdrant Edge 配置

- 向量维度：384（由 `all-MiniLM-L6-v2` 决定）
- 距离：Cosine
- `on_disk_payload(true)` + `on_disk(true)` — 全磁盘 mmap
- WAL `segment_capacity`: 4 MB（默认 32 MB 过大）
- `deleted_threshold`: 0.2，`default_segment_number`: 2

## 错误处理与降级

| 场景 | 行为 |
|------|------|
| 索引未就绪 | 查询退化为 `grepSymbol` |
| tree-sitter 不支持当前语言 | 跳过结构层，全走语义层 |
| fastembed 模型未下载 | 首次启动自动下载 (~23MB)，下载期间查询退化为 grep |
| Shard 损坏 | 删除 `.aide/index/qdrant/` 重建，不碰项目代码 |
| 索引构建失败 | 错误记 Tracing 日志，不影响聊天/编辑 |
| embed 推理超时 | 单次超时 5s，超时时该符号跳过，不阻塞整批 |
| `.aide/` 目录无写权限 | 索引构建静默跳过，所有查询退化为 grep |

## 与 PLANS.md 的关系

本设计覆盖 PLANS.md "独立中型项目 → 对话式代码理解"的第 1 层（结构层精确符号搜索）和第 2 层的语义向量部分。与 PLANS.md 中暂写方向的关键差异：

| 维度 | PLANS.md 暂写方向 | 本设计 |
|------|-------------------|--------|
| 结构层索引方式 | SCIP indexer（`scip-java` CLI 外部进程） | tree-sitter（Rust 内嵌） |
| 语义层 | LLM + 向量检索（技术未定） | fastembed-rs + Qdrant Edge |
| 部署依赖 | 用户需装对应语言 SCIP indexer | 零外部依赖，全内嵌 |
| 向量 DB | 未定 | Qdrant Edge（Rust crate，本地磁盘） |

## 验收标准

1. **索引构建**：中型业务项目（~5000 符号）首次全量索引 < 30s，增量保存 < 2s
2. **精确跳转**：同文件内方法调用 Cmd+Click → 直接跳到定义位置（结构层命中）
3. **跨文件跳转**：Controller → Service → Mapper 调用链，两步内到达目标
4. **语义兜底**：动态拼接的方法名/反射调用，结构层无结果时返回语义匹配 Top-K
5. **零安装**：用户打开项目即用，不需要装 Docker/Ollama/SCIP/JDK 等任何外部依赖
6. **错误不扩散**：索引模块任何失败不影响编辑器/聊天/Git 等现有功能
7. **资源可控**：空闲时内存增量 < 50MB（模型 ~23MB + OS 页面缓存），查询后释放

## 待后续阶段

- 对话式业务流程可视化（标注为"语义匹配"的消息块类型、2D 力导向调用链图）
- FileViewer 关系侧栏（点符号看定义/调用者/被调用者）
- 语义层 source 标注 UI 的精细呈现（"结构引用" vs "语义相似" 的视觉区分）
- 面板式探索（非对话驱动的独立浏览面板）
- 实体关系图谱的专用提取器（ORM 注解/DL 外键等）
