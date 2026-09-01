# 模型身份真相化设计（PreModelSwitch 拦截 + 事件驱动落盘）

- 日期：2026-09-01
- 状态：设计定稿，开工
- 关联：2026-09-01-context-usage-panel-design.md（SDK 0.3.252 升级）
- 关联记忆：builtin-mcp-hooks-frontend-mirror（hook 登记联动）；UI 变体先出可视原型

## 1. 背景与目标

现有「切换模型后发送弹确认」门控不准，根源：判定用**前端基线**（上次发送的选择）而非**进程真相**——切换在下拉点击瞬间已经发生，弹窗问的是既成事实；落盘（`settleOnSend` 发送时写草稿）与进程现实脱节（setModel 驳回后盘上写着错模型、CLI 内部变化永不落盘）。

SDK 0.3.252 提供 `PreModelSwitch`（切换前拦截，带 `prompt_cache_warm`/`context_tokens`/`estimated_cache_write_usd`/`cache_ttl`/`source`）与 `PostModelSwitch`（切换坐实，带 `to_model`/`requested_model`）。

**目标：判定权与落盘权全部移交 SDK 真相。旧门控按本次设计废除，不打补丁不做兼容。**

## 2. 废除清单（本次删除，非兼容）

| 旧机制 | 处置 | 理由 |
|---|---|---|
| `lastIdentityState` 门控基线（identity 层） | 删除字段与相关读写 | 「上次发送」≠「进程现实」，错位之源 |
| `confirmGate.needsConfirm`/`buildConfirmDecision` 的 model 维度 | 删除（gate 收窄为 provider-only，`ConfirmChanged` 缩为 `"provider"`） | model 门控由 PreModelSwitch 弹窗替代 |
| ChatPanel「本次发送将切换模型」弹窗分支 | 整块移除（含文案与 `changed === "model"` 分支） | 被切换前的成本确认替代 |
| `settleOnSend` 的模型身份落盘 | 收窄：只落 provider（respawn 恢复需要）；**模型落盘移交 model_committed 事件** | 草稿落盘是错误注入点 |
| `bindRuntime` 后基线不同步问题 | 随基线废除自然消失 | — |

## 3. 新架构：sidecar 是身份权威，SDK 是事实来源

```
用户下拉切换 → set_model → applyModelSwitch → setModel()
  → CLI PreModelSwitch hook（sidecar 注册）
      策略：prompt_cache_warm && context_tokens ≥ 50K 才问，否则放行
      需确认 → emit model_switch_confirm{to, context_tokens, estimated_cache_write_usd, cache_ttl}
              → await 前端决定（model_switch_confirm_decision 命令）
      allow {} | deny {permissionDecision:'deny'}
  → CLI 执行切换 → PostModelSwitch（source='sdk'）
      → sidecar emit model_committed{requested, resolved}
  → 前端 events.ts: bindRuntime + writeSessionMeta(model=requested_model)
  → applyModelSwitch 的成功回执改由 model_committed 到达驱动（回执=事实）
```

- **deny 闭环**：hook deny → CLI 中止 → `setModel` reject（若 resolve 则 UI 已由下拉本地回滚兜底，双路闭环）→ 现有回滚广播 + model_switch_result(ok:false) 原样生效
- **`model_committed` 落盘值**：`requested_model ?? to_model`——requested 是用户命名空间（下拉别名，restoreModel 可恢复）；to_model 是 CLI resolved 全名（原注释"别名落盘会污染记忆"的解法：落 requested，显示用 to 由 current 走）

## 4. 数据契约（sidecar types.ts ↔ @aide/sdk types/chat.ts 镜像）

```ts
// 新事件
| { type: "model_switch_confirm"; session_id: string; to_model: string; from_model: string;
    context_tokens: number; prompt_cache_warm: boolean; estimated_cache_write_usd: number;
    cache_ttl: "5m" | "1h" }
| { type: "model_committed"; session_id: string; from_model: string; to_model: string;
    requested_model: string | null; source: "command" | "picker" | "sdk" | "auto" | "resume" }

// 新命令（前端 → sidecar）
cmd.model_switch_confirm_decision: { sid, approve: boolean, confirmId }
```

- sidecar hook 挂起期间若会话 stop/超时（10s），按 deny 收尾（挂起不悬死）
- btw/automation 支线不注册本 hook（一次性支线无切换语义）

## 5. 建模与层次

- **策略对象**（`ModelSwitchGuardPolicy`）：阈值与 warm 判定收敛到一个纯函数 `shouldConfirm(input): boolean`——policy 归 sidecar 单一文件，测试纯函数
- **前端确认状态机**（判别联合）：`idle | awaiting{decision payload} | resolved`，非法跳转造不出来；复用 Modal 基建
- **identity 层收尾**：`settleOnSend(sid, {provider})` 签名收窄为 provider-only；落盘侧新增 `commitModelFromRuntime(sid, requested)`（model_committed 驱动，写盘 + bindRuntime 一体）
- **分层守恒**：sidecar hook 回调 = 外壳（emit/等待 IPC）；策略纯函数可 vitest；gate 变化不动 persistence 层

## 6. 验收

1. 冷缓存切换：全程零弹窗，`models_available` current 与 `model_committed` 先后到达
2. 热缓存 + context_tokens≥50K：切下拉 → 成本弹窗 → 允许才真切；取消 → 下拉回滚、无 model_committed、盘上身份不变
3. CLI 驳回（非法模型名）：现有 model_switch_result(ok:false) 通路不变
4. 重开会话：身份从盘恢复；发送无「将切换模型」弹窗（已废除）
5. 分支覆盖对账：hook 策略三臂（cold 放行 / warm 小体量放行 / warm 大体量询问）、deny 回滚、回执幂等
## 附录：分支覆盖对账表（实现轮实测）

| 层 | 函数/分支 | 测试 | 实测 |
|---|---|---|---|
| sidecar 策略 | shouldConfirmModelSwitch 三臂（冷放行/热小体量放行/热大体量询问） | `modelSwitchGuard.test.ts` 策略 describe | vitest 绿 |
| sidecar hook | PreModelSwitch 挂起（事件字段断言）/allow 零表态/deny 输出/过期 ID 忽略/连续切换接管/超时兜底（fake timers）/dispose | 同上 6 例 | vitest 绿 |
| sidecar hook | PostModelSwitch 分流（onCommitted 字段映射） | 同上 | vitest 绿 |
| sidecar 注册 | buildBuiltinHooks：guard=null 两键缺席+不入 manifest / guard 非空两 hook 分组+manifest 登记 | `builtinHooks/index.test.ts` 6 例 | vitest 绿 |
| sidecar 回执 | applyModelSwitch 成功**零本地副作用**（坐实/广播/回执全交 model_committed 链，deny-.resolve 幻影防护）；失败回滚+err 回执不变 | `modelSwitch.test.ts` | modelSwitch.ts stmt 100%/branch 90%/lines 100%（v8） |
| SDK 路由 | events.ts：model_switch_confirm 建状态（字段映射+非法枚举兜底）、model_committed 清弹窗+currentModel 坐实+落盘、model_switch_result 终态清弹窗（超时 deny 黑洞回归）、models_available spawn 对账落盘链 | `useChatSession.test.ts` 4 例 | events.ts stmt 79.78%/branch 67.45%/lines 82.35%（v8 实测，新 case 语句已覆盖；未覆盖为既有其他行） |
| SDK identity | settleOnSend provider-only（绑定/落盘/基线/失败降级/IPC 节流）+ commitModelFromRuntime 四例 | `useSessionIdentity.test.ts` | vitest 绿 |
| SDK gate | needsConfirm/provider 决策包（model 维度废除回归） | `confirmGate.test.ts` | vitest 绿 |
| UI 集成 | ChatPanel：同会话切换模型发送**不再弹** __sendConfirm__（旧行为废除回归） | `ChatPanel.test.ts` | vitest 绿 |

| UI 弹窗 | ModelSwitchConfirm：渲染成本明细、decide(true/false) 回传与清态、api 失败 finally 兜底 | `ModelSwitchConfirm.test.ts` 4 例 | vitest 绿 |

机械检查终态：前端 **156 files / 1718 全绿**；sidecar **40 files / 577 全绿**（含 modelSwitchGuard 11 例）；vue-tsc 与 tsc 双零错误；dist/runtime.js 已重建。覆盖率（v8 实测）：guard 全量 statements 97.56/branch 93.75/lines 100；modelSwitch.ts 100/90/100；events.ts 79.78/67.45/82.35（新 case 语句全覆盖）。22 个旧设计断言按换代改写（非回归）：基线 provider 化、settleOnSend 签名收窄、成功回执换轴、门控 model 维度删除、成功链路零本地副作用。
