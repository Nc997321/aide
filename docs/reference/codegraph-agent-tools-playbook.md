# CodeGraph Agent 工具打磨手册

> 配套阅读：[从零理解这套系统](codegraph-agent-tools-explained.md)。
> 本文是操作手册：怎么量、怎么改、怎么判断改对了。所有命令在仓库根目录执行，除注明外。

## 1. 打磨循环（每次改动都走这个圈）

```
改引导/索引/格式化 → smoke-runtime 看直方图 → 真实 app 跑一轮 → 转录取证 → 下结论
```

**纪律：不看感觉，看直方图。** 任何"我觉得这样写模型会更爱用"的改动，不过 smoke-runtime 不许合入。

### 1.1 行为层验证（最常用）

```bash
cd agent-sidecar && npx tsx smoke-runtime.ts
```

驱动真实打包 sidecar 跑一遍探索型 prompt（当前为"理清 aide 权限弹窗链路"），结束输出：

```
=== TOOL HISTOGRAM === {
  'mcp__aide-codegraph__semantic_search': 2,
  'mcp__aide-codegraph__find_symbol': 1,
  Skill: 1,
  Grep: 13,
  Read: 2
}
```

注意：smoke 里没有 Rust 应答，codegraph 查询会 10s 超时返回降级文案——**采纳率数据有效，工具结果质量数据无效**（结果质量要在真实 app 里看）。

### 1.2 注册层验证（工具没出现时用）

```bash
cd agent-sidecar && npx tsx smoke-mcp.ts
```

看 `mcp_servers` 是否 `connected`、tools list 里有没有 `mcp__aide-codegraph__*`。

### 1.3 转录取证（真实 app 跑完后）

```bash
# 最新转录（排除当前会话），统计工具直方图
cd ~/.aide/claude/projects/C--Users-heaven-IdeaProjects-aide
latest=$(ls -t *.jsonl | grep -v <当前会话id> | head -1)
grep -o '"name":"[A-Za-z_]*"' "$latest" | sort | uniq -c | sort -rn | head
```

看 mcp 工具的**返回内容**（模型为什么弃用，答案全在返回里）：在转录里搜 `codegraph` 找 tool_use 和紧随的 tool_result。

## 2. 健康基线（2026-07-26，Kimi K2.6）

同一 prompt（"理清 aide 权限弹窗链路"）的参考数据，改动后对比用：

| 阶段 | codegraph 调用 | Grep | Read | 说明 |
|---|---|---|---|---|
| 无工具（旧行为） | 0 | 10–19 | 6–13 | 纯 grep/read 扇出 |
| instructions only | 3 | 19 | 12 | 工具被无视是常态 |
| +skill+纠偏 hook | 2–3 + Skill×1 | 13 | **2** | 当前基线，成本 -30% |

**健康信号**：skill 被触发；find_symbol/call_graph 出现在前 5 次工具调用里；Read 集中在定位之后。
**危险信号**：连续 2 次以上空命中后 mcp 调用消失（模型弃用）；Read 数回到两位数。

## 3. 问题决策树

### 3.1 「工具卡一次都没出现」

按顺序查：

1. **bundle 是不是新的**：`grep -c "aide-codegraph" agent-sidecar/dist/runtime.js`（≥3），mtime 是否晚于最近改动
2. **进程是不是新的**：sidecar 进程启动时间 vs bundle mtime（dev 改 sidecar 必须重启 `pnpm tauri dev`）
3. **跑 smoke-mcp.ts**：`connected` + tools list 有 → 注册正常，是采纳率问题（转 3.3）；没有 → 注册坏了，查 session-worker.ts 的 mcpServers 组装和 `AIDE_CODEGRAPH_TOOLS` 环境变量
4. **确认在哪个窗口测的**：release 版 bundle 是旧的！dev 窗口 = `target\debug\aide.exe`

### 3.2 「工具返回空命中」

**空命中是产品反馈，必须逐个归因**：

| 情况 | 判断 | 动作 |
|---|---|---|
| 查的根本不是符号（SDK 字段、配置项、事件名） | 合理 | 不改；这类查询 Grep 是正确工具 |
| 限定名（`Class.method`/`A::b`/`save()`） | 名字形式不匹配 | 查询层归一化（已有 `leaf_name`，遇到新形式往里加） |
| Vue/React 组件名 | 覆盖缺口：组件名不在任何符号声明里 | 索引层合成符号（参考 Vue SFC 文件名方案） |
| 符号确实存在但没搜到 | 索引过期或提取漏了 | 全量重建；仍缺 → 查 extract.rs 对该节点类型的处理 |
| semantic 全空 | embed 未完成 / 阈值过滤 / snippet 无锚点 | 查 meta.json `embed_complete`；给符号 snippet 加实质内容 |

### 3.3 「用了几次就弃用」

去转录里读那几次调用的**返回内容**：

- 全是降级文案（no_index/timeout）→ 修索引可用性，不是模型问题
- 空命中过多 → 按 3.2 归因
- 结果质量差（候选太多、snippet 没用）→ 调输出格式/上限/snippet 内容
- 结果正常但模型就是不用了 → 加强引导层（见 §4），别动索引

## 4. 引导层打磨（L1/L2/L3 各自怎么改）

三层机制的改动位置和验证重点：

| 层 | 文件 | 改什么 | 验证 |
|---|---|---|---|
| L1 instructions | `codegraphTools.ts` `CODEGRAPH_INSTRUCTIONS` | 规则措辞（MUST/FIRST 比"建议"有效） | smoke-runtime |
| L1 工具描述 | 同上，`tool()` 第二参数 | 首句说清"什么时候用它替代什么" | 快照测试会拦改动——刻意更新 |
| L2 skill | `codegraphSkill.ts` `SKILL_CONTENT` | frontmatter description（触发关键词）、正文工作流 | 转录里看 skill 是否被 Launch |
| L3 hook | `codegraphTools.ts` `looksLikeSymbolLookup` + `makeCodegraphGrepNudgeHook` | 符号判定正则、纠偏文案 | smoke-runtime 直方图 |

**写作要点**：
- 命令式 > 建议式："you MUST call X FIRST — do NOT use Grep for definition lookup"
- 给出明确的**分工边界**：什么归索引（符号/调用关系/概念）、什么归 Grep（日志串/事件名/正则）——模型需要知道什么时候**不**用索引，才不会误用后弃用
- 每层改完都要想：这条规则模型违反了会怎样？L3 的价值就是"违反了也会被贴脸提醒"

**L3 hook 的 patterns 维护**：`looksLikeSymbolLookup` 只管裸标识符（含 `\b`）。遇到模型用新形式 Grep 符号（比如带命名空间），先加测试再加规则。别把正则放宽到误伤文本搜索——误伤比漏拦代价大。

## 5. 索引质量打磨

### 5.1 覆盖缺口（最高优先级）

索引的价值 = 命中率。定期检查"模型想查但查不到"的类别：

- **Vue SFC 组件名**（已修：文件名合成符号）——同类候选：TSX 默认导出匿名组件、`index.ts` 桶文件的 re-export
- **Rust trait 方法调用**：名字级调用边在泛型/trait 场景歧义大，接受候选标注即可
- **新语言**：加 tree-sitter grammar（parser.rs 注册 + extract.rs 节点映射），工作量集中在节点类型映射

每修一类缺口：**必须全量重建索引**（结构层变化不会自动进旧索引，load 兼容直接复用旧的）。

### 5.2 snippet 质量（语义层的命根子）

语义搜索质量 = 嵌入文本的质量。当前 snippet 是「kind + name + 定义开头 512 字符」。打磨方向：

- 无实质内容的符号（如合成的组件符号）要补锚点（Vue 案例：带 template 前 300 字符）
- 改 snippet 构成 = 换嵌入空间 → **必须全量重建**
- 换 embedder（设置 → 代码索引）：fastembed（本地 CPU，384 维，零配置）vs Ollama bge-m3（1024 维，中英文都强）——跨语言查询（中文问英文码）建议 bge-m3

### 5.3 输出格式（token 纪律）

单次工具结果目标 ≤2KB。上限：find_symbol 20 条、semantic 5 条（snippet ≤300 字符）、call_graph 30 条。改上限前先想：多给的结果是帮模型还是淹模型？

## 6. 验收与迭代节奏

**一轮完整验收**（spec §9）：
1. smoke-runtime 直方图达标（mcp 调用 >0 且 Read ≤3）
2. 真实 app 三任务：探索型 / 语义型（不知标识符）/ 实现型对照
3. 转录取证：工具采纳贯穿全程、空命中 ≤1 次、结果内容可用
4. 用量面板对比 input token

**迭代优先级**（按投入产出比）：
1. 覆盖缺口（一次修复永久受益）
2. 查询归一化（便宜，直接提升命中率）
3. L3 hook patterns（强制通道，收益确定）
4. L1/L2 文案（边际递减，且对第三方模型不稳）
5. snippet/embedder（贵，先确认语义搜索是瓶颈再做）

**别做的事**：
- 别为"模型某轮没用工具"就改文案——先看三轮数据，采样噪声很大（实测同配置 3 次调用和 0 次调用都出现过）
- 别放宽 L3 正则去追求 100% 拦截——误伤合法文本搜索的代价比漏拦大
- 别在没看转录返回内容前下"模型不爱用"的结论——90% 的"不爱用"其实是"返回了没用的东西"
