# codegraph `embed_complete` 可信化 + 索引状态可见 — 实现计划

- 日期：2026-08-04
- 状态：待实施
- 关联：`docs/superpowers/specs/2026-07-10-codegraph-design.md`、`docs/superpowers/plans/2026-08-03-codegraph-symbol-span-and-source.md`
- 执行：新会话。本计划自洽，含精确 file:line、当前行为、bug、修法、签名、验证。

## 1. Context（为什么改）

### 症状
语义搜索**静默失效**：`mcp__aide-codegraph__semantic_search` 与命令面板（Ctrl+P，走 `codegraph_goto_definition` 的语义兜底）返回空，且和"真没匹配"不可区分。打包重启后尤甚——用户报告"当时能用，打包重启后莫名全量重建、又搜不到了"。

### 根因 1（产出残缺 shard）—— 核心
`run_embed_loop`（`src-tauri/src/codegraph/mod.rs:1061`）把失败/跳过的 batch 也算进 `out.embedded`，完成判定不查错误，`mark_embed_complete` 直接翻 `embed_complete=true` 不校验 shard 实际向量。逐条：

- `mod.rs:1102` `indexer::store::embed_and_store(chunk, embedder, shard)` **已返回 `Result<usize>`**（实际存储数，见 `store.rs:24-41`），但 `mod.rs:1103` `Ok(_)` **丢弃了存储数**，`mod.rs:1121` 改用 `out.embedded += chunk.len()`（整个 chunk 大小，含被 bisection 跳过的）。
- `embed_and_store`（`store.rs:24-41`）内部 `embed_bisect`（`store.rs:45-91`）对**所有** `embed_batch` 错误（NaN-500 **或** Ollama 掉线/超时）都走二分+跳过，最终 `Ok(stored)`，**从不返回 Err**。所以 `run_embed_loop:1106` 的 Err 分支是**死代码**，`consecutive_failures`/`stopped_early`（`:1097,1110-1118`）永不触发。
- 结果：Ollama 掉线/抖动时，整批被二分跳过、**一条向量都不存**，但 `out.embedded += chunk.len()` 照样累加到 ≥ total → `completed=true`（fresh `:510` / resume `:1315`）→ `mark_embed_complete`（`:1152`/`:519`/`:1318`）翻 `embed_complete=true`。**shard 有 payload（~191MB）但缺向量，被标"完整"。**
- 加载器 `load_project_index`（`indexer.rs:411`）只认 `embed_complete`，不查实际向量数 → 残缺 shard 被当完整加载 → search 返 0。

### 根因 2（静默）
跳过数/失败数不外露（只在 Rust `tracing::warn!`）；索引被打断→resume 用户无感；search 返 0 与"真没匹配"不可区分；加载器不校验 shard 实际向量。

### 触发条件
- bge-m3+Ollama 对某些代码片段返 500 NaN（用户工作区混进了 `socialized-*` Java 项目的 `field X: X = expr` 片段，正是 bge-m3 数值溢出 NaN 触发点；`code:` 前缀只挡住大部分，残余靠 bisection）。
- LAN Ollama（`10.0.0.5:11434`）抖动/瞬断 → 整批 embed 失败。
- 用户关 app 中途打断 embed（`embed_complete=false`），重启后 resume——**用户看到的"莫名全量重建"其实是 resume**（日志 `resuming interrupted embed (58 files already embedded, shard qdrant-...)`）。

### 链路（用户场景）
索引被打断（静默 `embed_complete=false`）→ 重启 resume → resume 的 embed 受根因 1 影响 → 产出"假完整"残缺 shard → 静默加载 → search 返 0（静默）。**全链路没有一个节点告诉用户"出事了"。**

## 2. Goal
- `embed_complete=true` **真正代表 shard 有有效向量**（不是"循环跑完了"）。
- 索引状态（complete / incomplete / resuming / N-skipped / N-failed）对用户可见；"为什么重建"（=resume 中断的 embed）不再莫名。
- search 失效能区分"索引残缺/未就绪" vs "真没匹配"。
- 残缺 shard 即便 `embed_complete=true` 也不被当完整加载（兜底校验）。

## 3. 改动

### 3.1 `embed_bisect` 区分 NaN（永久跳过）vs 瞬时错误（失败，不跳过）
File: `src-tauri/src/codegraph/indexer/store.rs` `embed_bisect`（`:45-91`）、`embed_and_store`（`:24-41`）

当前 `embed_batch` 返 Err 时一律二分+跳过。改为按错误性质分流：
- Err 信息含 `"NaN"`（bge-m3 数值溢出 500 `failed to encode response: json: unsupported value: NaN`）→ **二分**定位单条 NaN snippet 跳过，累计 `nan_skipped`（保留现有 "skipped symbol … NaN-producing snippet" 日志）。
- Err 信息**不含** NaN（Ollama 掉线/超时/连接错误等瞬时故障）→ **不二分、不跳过**，直接 `return Err(e)`，让上层 `run_embed_loop` 当 batch 失败处理（触发停止/下次 resume），而不是把整批悄悄丢掉。

`embed_and_store` 返回类型改为 `Result<EmbedStoreOutcome, Box<dyn Error>>`，`EmbedStoreOutcome { stored: usize, nan_skipped: usize }`（放 `store.rs`，`#[derive(Default)]`）。瞬时 Err 向上传播。

> 这一步让 `run_embed_loop` 的 Err 分支（`:1106`）与 `consecutive_failures`/`stopped_early`（`:1097,1110-1118`）**活过来**——Ollama 掉线时停止 early，不再静默吞整批。

### 3.2 `run_embed_loop` 正确记账
File: `src-tauri/src/codegraph/mod.rs` `run_embed_loop`（`:1061-1145`）、`EmbedRunOutcome`（`:1033-1040`）

- `EmbedRunOutcome` 加 `skipped: usize`（NaN 跳过数）。`embedded` 语义改为**实际存储数**。
- `:1102-1121` 改为：
  ```rust
  match indexer::store::embed_and_store(chunk, embedder.as_ref(), shard) {
      Ok(outcome) => {
          out.embedded += outcome.stored;
          out.skipped  += outcome.nan_skipped;
          consecutive_failures = 0;
      }
      Err(e) => {
          tracing::warn!("codegraph: embed batch failed: {}", e);
          out.batch_errors = out.batch_errors.saturating_add(1);
          out.first_err.get_or_insert_with(|| e.to_string());
          consecutive_failures = consecutive_failures.saturating_add(1);
          if consecutive_failures >= 2 {
              tracing::warn!("codegraph: embed stopping early after {} consecutive batch failures", consecutive_failures);
              out.stopped_early = true;
              break;
          }
      }
  }
  // 删除 `out.embedded += chunk.len()`——失败/跳过的不算 embedded
  out.embedded 是实际存储数；进度展示用 (out.embedded + out.skipped) vs total。
  ```
- `EmbedRunOutcome::skipped()`（`:1043`）默认值同步加 `skipped: 0`。

### 3.3 完成判定查错误 + 残缺不标 complete
File: `src-tauri/src/codegraph/mod.rs`
- Fresh build 完成判定 `:510`：
  ```rust
  let completed = !cancelled && can_embed
      && !outcome.stopped_early
      && outcome.batch_errors == 0
      && (outcome.embedded + outcome.skipped) >= total;
  ```
- Resume 完成判定 `:1315`：同形态（`!outcome.cancelled && outcome.ran && !outcome.stopped_early && outcome.batch_errors == 0 && (embedded + skipped) >= total`）。
- **不 completed → 不调 `mark_embed_complete`** → `embed_complete` 保持 false → 下次启动 resume/rebuild，而不是静默用残缺 shard。
- completed 时把 `outcome.skipped`、`outcome.batch_errors`、`outcome.embedded` 写进 build 结果（见 3.6）。

### 3.4 `mark_embed_complete` 接收 shard_dir，避免翻错 meta
File: `src-tauri/src/codegraph/mod.rs` `mark_embed_complete`（`:1152-1161`）
- 签名改 `fn mark_embed_complete(root: &Path, shard_dir: &str)`：load meta，**校验 `meta.shard_dir == shard_dir`**（即刚 embed 的那个 shard），不等则 `tracing::warn!("codegraph: mark_embed_complete: meta shard_dir {:?} != embedded {:?}, not flipping", meta.shard_dir, shard_dir)` 并**不翻**（防 meta 被别的 build 改过后翻错 shard 的标志）。
- 调用方更新：fresh build `:519` 传 `&shard_dir`（`shard_dir` 在 `:492` 已读）；resume `:1318` 传 `&meta.shard_dir`。

### 3.5 加载时校验 shard 实际向量数（兜底）
File: `src-tauri/src/codegraph/shard.rs`（新增 API）+ `src-tauri/src/codegraph/indexer.rs` `load_project_index`（`:411`）
- `CodeShard` 加 `pub fn point_count(&self) -> usize`。**实现前先读 `shard.rs`**：看内部点数怎么取（`id_tracker`、`segments` 的点数；`id_tracker.mappings` 文件有数据，但需要运行时 API 而非读文件）。若 Qdrant Edge 没现成 count，遍历 `segments` 取点数和。
- `load_project_index` 加载 shard 后、返回前加：
  ```rust
  let pc = shard.point_count();
  if pc < meta.symbol_count / 2 {   // 向量数远少于声明 → 残缺 shard
      tracing::warn!("codegraph: shard point_count {} << meta.symbol_count {}, treating as broken → rebuild", pc, meta.symbol_count);
      return None;
  }
  ```
  阈值（50%）先保守，可调。`load_compatible_index`（`indexer.rs`，`try_incremental_build:970` 用）同加此校验。

### 3.6 build 结果带 skipped/failed/health + 前端可见
File: `src-tauri/src/codegraph/mod.rs`（build 结果 JSON：fresh `:510` 附近 + incremental `:1020` + resume 返回）+ `src/types.ts` + `src/composables/useCodeGraphProgress.ts`
- build 结果 JSON 增字段：`skipped_count`、`failed_count`（batch_errors）、`shard_point_count`、`embed_complete`、`health`（`"complete"|"incomplete"|"degraded"|"structure_only"`）。`embed_status` 字符串也带上 `skipped/failed`（如 `"complete (3985 embedded, 47 skipped, 0 failed)"`）。
- `src/types.ts` 的 codegraph build 结果类型加这些字段（找 `CodegraphBuildProgress`/build 结果 interface，按现有字段风格补）。
- `src/composables/useCodeGraphProgress.ts`：现有 `console.info("[codegraph] build done with embeddings:", r)`（`:121`）之外，把 `skipped_count/failed_count/health` 透出给 UI（供 3.7 显示）。也更新 `:95` 那条 "embeddings NOT completed" 日志带上 skipped/failed。

### 3.7 索引健康指示 UI
File: `src/components/SettingsPanel.vue`（代码索引那栏，`:680` 附近的 `cg-info`/`cg-rebuild-note`）
- 显示上次构建健康（绿/黄/红小徽标 + 文本）：`完整 · 3985 符号` / `残缺 · 3985 indexed, 47 skipped, 3 failed` / `未完成，恢复中` / `语义不可用 · embedder 缺失`。
- 数据来源：先读 `codegraph_build_progress`（`mod.rs:934`）当前返回什么；按需扩展它返回 last build 健康（`health/skipped_count/failed_count/shard_point_count/embed_complete`）。或前端缓存最近一次 build 结果。前端读法仿现有 `useCodeGraphProgress` 的 poll 机制。
- 目的：让"索引未完成→恢复中""索引残缺"对用户可见——即用户问的"莫名重建"变得不莫名。

### 3.8 search 失效区分"残缺" vs "真没匹配"
File: `src-tauri/src/codegraph/agent.rs`（`execute_agent_query` semantic 分支，`:145-200`）+ `agent-sidecar/src/codegraphTools.ts`（`:95-115`）
- `execute_agent_query` semantic 分支：shard 加载后、search 前加 degraded 判定——`shard.point_count() < 阈值`（复用 3.5 的口径）→ 返回 `{"ok": true, "status": "degraded", "results": [], "health": "shard_point_count=<N> vs symbols=<M>"}`。
- `codegraphTools.ts:107-111` 的 "No match (index is healthy)" 分支前，加 `if (resp.status === "degraded") { return "索引残缺（仅 N 个向量，应 M），建议全量重建"; }`。`structure_only`（`:98`，embedder 缺失）保持不变。
- 效果：agent/用户看到"索引残缺"而非"index is healthy"——不再误导。

### 3.9（可选）NaN 兜底重试
File: `src-tauri/src/codegraph/indexer/store.rs` `embed_bisect`
- 二分到底定位单条 NaN snippet 后、跳过前，先试一次 snippet 改写（截断到 ~512 token / 去重复 token）再 embed，成功则 upsert（不丢这个符号的语义）。失败才跳过、`nan_skipped += 1`。
- 非必需，看 bge-m3 NaN 在 `socialized-*` Java 片段上是否仍频繁。先做 3.1-3.8，观察 skipped_count，再决定要不要 3.9。

## 4. 复用现有（不要重造）
- `embed_and_store` 已返回 `Result<usize>`（存储数）——只需让 `run_embed_loop` 用它 + `embed_bisect` 区分 NaN/瞬时。
- `EmbedRunOutcome` 已有 `batch_errors/first_err/stopped_early/cancelled/ran`——加 `skipped`、让 `embedded` 只计成功即可。
- `consecutive_failures`/`stopped_early` 逻辑已存在（`:1097,1110-1118`）——改 3.1 后自然生效。
- `NaNEmitter` test embedder（`store.rs:104`）已有——用于测 NaN 分流。新增一个 `TransientEmitter`（返连接错误）测瞬时分流。
- build 结果 `embed_status` 字段已存在——只加新字段。
- `codegraph_build_progress` 命令已存在——按需扩展返回字段。

## 5. 验证
1. **单测 store.rs**：`NaNEmitter`（返 NaN-500）→ `embed_and_store` 返回 `Ok(EmbedStoreOutcome { stored: 非NaN数, nan_skipped: NaN数 })`、NaN 单条被跳过。新增 `TransientEmitter`（返 `os error 10054` 连接错误）→ `embed_and_store` 返回 `Err`（不二分、不跳过）。
2. **单测 mod.rs run_embed_loop**：全 batch 瞬时失败 → `completed=false`（**修前是 true，这就是 bug 的回归保护**）；混合（部分 NaN + 部分 ok）→ `completed=true`、`skipped` 正确；2 次连续瞬时失败 → `stopped_early=true`。
3. **单测 mark_embed_complete**：meta.shard_dir 与传入 shard_dir 不符 → 不翻 `embed_complete`、`tracing::warn`。
4. **单测 load_project_index**：构造 point_count 远低于 symbol_count 的 shard → 返回 `None`。
5. **端到端**：bge-m3 + 中途断开 Ollama → 构建结束 `embed_complete` 保持 false（修前会被错误标 true）；重启后 resume 而不是用残缺 shard。
6. **手动（用户场景）**：打包重启触发 resume 时，UI 显示"恢复中 / N skipped"；resume 失败则 `embed_complete` 不翻 true，再次启动继续 resume；search 返 0 时若索引残缺，提示"索引残缺，建议重建"而非"index is healthy"。
7. **回归**：`cargo test --manifest-path src-tauri/Cargo.toml codegraph` 全过（含现有 `run_embed_loop_checkpoints_all_completed_files` 等 + 新增）；`vue-tsc --noEmit` EXIT=0。

## 6. 关键文件
- `src-tauri/src/codegraph/indexer/store.rs`（3.1、3.9）
- `src-tauri/src/codegraph/mod.rs`（3.2、3.3、3.4、3.6、3.7 后端）
- `src-tauri/src/codegraph/shard.rs`（3.5 加 `point_count`）
- `src-tauri/src/codegraph/indexer.rs`（3.5 load 校验 + `load_compatible_index`）
- `src-tauri/src/codegraph/agent.rs`（3.8 degraded 状态）
- `agent-sidecar/src/codegraphTools.ts`（3.8 消息区分）
- `src/types.ts`（3.6 build 结果字段）
- `src/composables/useCodeGraphProgress.ts`（3.6 透出）
- `src/components/SettingsPanel.vue`（3.7 健康指示）

## 7. 顺序与提交
建议顺序：3.1 → 3.2 → 3.3 → 3.4（根因，让 `embed_complete` 可信）→ 3.5（兜底）→ 3.6 + 3.7（可见性）→ 3.8（search 区分）→ 3.9（可选）。每步配单测，小步提交。先跑 `cargo test codegraph` + `vue-tsc` 再提交。

## 8. 不要做
- 不要重写 bisection 的整体策略——只加 NaN/瞬时分流。
- 不要改 `embed_input` 的 `code:` 前缀（它是 bge-m3 NaN 的一级防御，保留）。
- 不要动 `run_embed_loop` 的 checkpoint 机制（`save_embed_checkpoint`）——它服务于 resume，正确。
- 不要把 `embed_complete` 改成"必须有 0 skipped"——NaN 永久跳过是合法的，skipped 计入"已处理"。