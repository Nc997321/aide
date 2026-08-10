# 信任工作区自动写入安全命令白名单

日期：2026-08-10

## 背景与目标

链式命令（`pnpm vitest run <file> | grep -i allow`）在链式分段严格匹配下，管道后段的安全只读命令（grep/cat/head 等）不在 allowlist 里时每次都会弹 Aide 权限窗。用户在「保持严格 + 补规则」方向下已接受为常用管道目标补规则，但手动补很烦。

本设计在**保持链式分段严格匹配不变**的前提下，信任工作区（trusted workspace）时把安全只读命令**自动写入 local scope 权限文件**，让已信任工作区的常见管道目标免弹窗。

## 决策

| 决策点 | 结论 |
|---|---|
| 触发 | 恒开：信任工作区即写入，无开关 |
| 回填 | 只对新信任的工作区；功能上线前已信任的不回填 |
| 安全清单 | `cd grep cat head tail wc uniq cut tr ls diff`（11 条，全纯只读；`cd` 为 shell 内建仅改工作目录；不含 sort——`-o` 能写文件） |
| untrust | 删除 `auto-safe-` 前缀规则（取消信任 = 权限回到原样） |
| 实现位置 | Rust 侧挂钩 `trust_workspace` / `untrust_workspace` |
| 前端 toast | 信任成功后显示「已信任工作区，已添加 N 条安全命令白名单」 |

## 架构

```
src-tauri/src/commands/
├── permissions.rs                    # 权限命令模块（已有）
└── permissions/
    ├── permissions_test.rs           # 已有
    └── workspace_safe_rules.rs       # 新增：安全规则读写逻辑
```

**`workspace_safe_rules.rs`**（子实现，符合「组织文件上层、子实现放同名子目录」）：
- `SAFE_COMMANDS` 清单常量：`["cd", "grep", "cat", "head", "tail", "wc", "uniq", "cut", "tr", "ls", "diff"]`
- `ensure(service, project) -> Result<usize, String>`：幂等写入安全规则到 local scope，返回**新增条数**
- `remove(service, project) -> Result<usize, String>`：删除 local scope 里 `auto-safe-` 前缀规则，返回**删除条数**

**`workspace/mod.rs` 改动**：
- `trust_workspace` / `untrust_workspace` 增加 `State<'_, Arc<SettingsService>>` + `State<'_, Arc<AgentRuntimeManager>>` 参数（当前没有，需接线）
- 信任流程：写信任 key → `ensure_aide_excluded`（现有 git ignore）→ `ensure_safe_rules` → `broadcast_policy_change`（推新快照给 sidecar，即时生效）
- 取消信任流程：删信任 key → `remove_safe_rules` → `broadcast_policy_change`
- 命令返回 `Result<usize, String>`（新增/删除条数），供前端 toast 与单测断言

## 规则形状

每条规则写入 **local scope**（`.aide/settings.local.json`，per-project + 本机，`.aide/` 已被 trust 时的 git ignore 覆盖，不进 git）：

| 字段 | 值 |
|---|---|
| id | `auto-safe-<cmd>`（如 `auto-safe-grep`）——untrust 清理的标记 |
| effect | `allow` |
| tool | `Bash` |
| matcher | `{ kind: "bash", mode: "prefix", value: "<cmd>" }` |
| order | 现有 max+1（沿用 create 命令逻辑） |

**幂等**：写入前检查 local scope 是否已有**同 (tool, matcher)** 规则，有则跳过——用户手动加过 `grep` 前缀规则就不重复写；重复信任也不堆。

**关键语义**：`auto-safe-` 前缀只做 untrust 标记；幂等去重按 (tool, matcher)。用户手动规则和自动规则互不覆盖，untrust 只删 `auto-safe-` 的。

## 数据流

**信任**（`trust_workspace`）：
```
写信任 key → ensure_aide_excluded → ensure_safe_rules(N) → broadcast_policy_change
                                                           返回 Ok(N)
```

**取消信任**（`untrust_workspace`）：
```
删信任 key → remove_safe_rules(N) → broadcast_policy_change
                                     返回 Ok(N)
```

## 错误处理

- **信任 key 写入是主动作**；`ensure_safe_rules` 失败（如 settings 文件不可写）**不回滚信任**——记 `tracing::warn!`，仍返回 `Ok(0)`。工作区信任了，规则是便利项，写不进不拦信任本身
- `remove_safe_rules` 失败同理：untrust 成功，清理失败仅记日志
- `broadcast_policy_change` 是现有管道（create/update/remove 都在用），复用即可
- local scope 文件 `.aide/settings.local.json` 不存在时由 settings store 自动创建（写入管道已处理）

## 前端

- `trust()` composable：`api.trustWorkspace(path)` 返回 N，成功且 N > 0 时 toast「已信任工作区，已添加 N 条安全命令白名单」
- 不需要其它前端改动（规则在设置 → 权限里可见、可手动删）

## 测试

**单测**（`workspace_safe_rules` 模块，用 `SettingsStore::for_test` 临时目录）：
1. `ensure` 首调写入全部 11 条：id 是 `auto-safe-<cmd>`、matcher 是 Bash prefix、scope 是 local
2. `ensure` 幂等：二调新增 0 条；同 (tool, matcher) 的用户手动规则存在时也跳过
3. `remove` 只删 `auto-safe-` 前缀规则，用户手动规则保留
4. `remove` 无 `auto-safe-` 规则时返回 0，不报错
5. trust/untrust 集成：写信任 key 后 local scope 出现规则 + 触发 broadcast；untrust 后规则消失

**现有测试影响**：`trust_workspace` / `untrust_workspace` 命令签名变化（加 State 参数），检查现有 workspace 测试是否需同步更新。

## 安全考量

- 自动规则**只覆盖纯只读命令**，链式分段严格匹配不变（每段仍需 allow 才放行）
- `cd` 是 shell 内建，只改会话工作目录，不读写文件、不执行命令；每条命令独立评估，`cd` 不会给后续命令授新权限
- 危险命令（`rm tee xargs sed sort awk find curl wget dd` 等）**不在清单**，AI 无法用 `... | xargs rm` 混过去
- 信任是用户主动行为，放宽了哪些在 设置→权限 里一目了然，可手动删
- untrust 清理对称，取消信任即回到原权限态
