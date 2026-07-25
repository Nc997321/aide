# CodeGraph Agent Tools A/B 实测 Runbook

前置：代码已全部合入 master（0c6ba54..976b82c，9 commits），全量测试绿（Rust 283 / sidecar 274）。

## 准备（一次性）

```bash
cd agent-sidecar && npm run build && cd .. && pnpm tauri dev
```

在 app 里打开 **aide 仓库自身**的工作区 → 设置 → 代码索引 → 构建，等 embed 完成（状态显示索引就绪）。

## A 臂（工具开启，默认即开）

每个任务开**全新会话**、同一模型（建议 Sonnet），逐字发送：

| # | 类型 | Prompt |
|---|------|--------|
| 1 | 探索型 | 理清 aide 权限弹窗从 canUseTool 到用户点击的完整链路 |
| 2 | 语义型 | 找到处理图片输入能力的代码并说明工作流程 |
| 3 | 实现型对照 | 给设置面板加一个小开关 |

每任务记录：
- 总工具调用数（数转录里的工具卡）
- 其中 Grep/Glob/Read 次数
- `mcp__aide-codegraph__*` 调用次数（验证 agent 真的用了）
- 累计 input token（用量面板）
- 结果质量一句话（链路说对了吗）

## B 臂（工具关闭）

```bash
AIDE_CODEGRAPH_TOOLS=off pnpm tauri dev
```

全新会话，**逐字相同**的三个 prompt，同样记录。

## 判定（spec §9 验收线）

- 任务 1、2：Grep/Read 调用数下降 ≥40%，input token 显著下降 → 达标
- 任务 3：无劣化
- A 臂转录里确实出现 `mcp__aide-codegraph__*` 调用

不达标 → 迭代工具描述/输出格式，不宣布完工。

## 快速冒烟（2 分钟，正式 A/B 前先做）

A 臂 dev 起来后，新会话发一句：
> 用 find_symbol 查一下 makeSkillGuardHook 定义在哪

预期：agent 调用 `mcp__aide-codegraph__find_symbol`，一次返回 `agent-sidecar/src/skillGuard.ts` 的精确位置，不发 Grep。若工具没出现或报 no_index → 先排查（索引是否构建、cwd 是否匹配工作区根），别继续 A/B。
