# 会话供应商/模型身份：一次 400 报错牵出的问题与修复方案

日期：2026-09-08
触发：鸿蒙端报 `400 不支持 glm-5.3-flash:cloud`，而该会话是 DeepSeek 的
状态：方案已定稿，**第 1 笔实施中**（Rust 侧已改完，编译验证中）

---

## 1. 现象

手机端把全局供应商切到 Ollama（模型 `glm-5.3-flash:cloud`），再点开一条 DeepSeek 的旧会话发送，
DeepSeek 的 API 收到了 Ollama 的模型名 → 400。

```
不支持 glm-5.3-flash:cloud。支持：deepseek-v4-pro / deepseek-v4-flash / deepseek-v4-flash-vision-exp
```

## 2. 根因：两端对"会话属于哪个供应商"的口径不一致

| | 选项集按谁算 | 后果 |
|---|---|---|
| 桌面端 | **会话自己的供应商**（`useSessionIdentity.ts:80-87` → `providerOf(sid)`） | 下拉里根本选不到别的供应商的模型，天然安全 |
| 鸿蒙端 | **全局激活供应商**（`ChatModel.ets:304`） | 能选到 glm |

再叠上鸿蒙端发送时的两个约定，错误就成型了：

- `ChatModel.ets:194` 发消息时 `provider: null` → 桌面按会话自己的供应商解析 → 走 DeepSeek 的 baseUrl；
- `ChatModel.ets:198` **只有新建会话才带 `initialModel`**，存活会话不重带 → 进程沿用上次 `setModel` 下来的模型 → glm；
- `ChatModel.ets:332` 会话记忆的模型不在新选项集里时，`store.model = ''` **直接赋值、不通知 sidecar** → 旧模型留在进程里。

于是 baseUrl 是 DeepSeek、模型是 glm，两边各走各的。

**顺带确定的一条**（不是"可能"）：鸿蒙端 `pickModel`（`ChatModel.ets:408`）**无条件下发** `setModel`，不校验模型是否属于会话的供应商。所以只要「会话有活进程 + 用户在手机端选了别的供应商的模型」，点选的瞬间就会 400，不用等发送。

## 3. 顺带挖出来的四个问题

### 3.1 未启动的旧会话，切换供应商无路可走

- 盘上身份的唯一写入点是 `settleOnSend`（`useSessionIdentity.ts:138-153`），闸门是 `!providerOf(sid)`——会话只要有过身份就不再覆盖；
- 清绑定的入口只有 `releaseBinding`，它只挂在"关 tab"（`PaneTabBar.vue:95`）和"删会话"（`contextMenus.ts:243`）上，**UI 没有独立的"停止会话"**；
- 关了也没用：重开时 `restoreBinding` 又从盘上 `session_meta.provider` 读回旧值。

### 3.2 状态归属错位（这才是根子）

`useSessionIdentity` 是模块级单例（`:17-18` 自述），而 `App.vue:1041` 明确"PaneLayout 用 v-show 保活"——**多个面板同时挂载**，共享同一份状态：

- `currentSid` 单值 → 分屏时 B 面板显示 A 会话的模型；在 A 面板选模型会写进 `bindings[currentSid]`，**草稿落到别人会话上**；
- `lastProvider` 单值 → `ChatPanel.vue:307` 的门控基线不看 sid，**误弹/漏弹"将切换供应商"**；
- `pendingDraft` 单值 → 多个空白预览 tab 共享一份草稿；
- `resolve` 先同步写 `currentSid` 再 await 读盘，期间别的面板插进来覆盖它，`ChatInputBox.vue:128` 的守卫挡不住。

### 3.3 非组件路径在读视图状态（已造成数据损坏）

`state.ts:553`：

```ts
await identity.settleOnSend(realId, identity.effectiveProvider.value);
```

注释假设"finalize 时 `currentSid` 仍是 null"。但新建会话首发后**立刻切走 tab**，`session_init` 才回来 → 读到的是当前面板那条会话的 provider → **新会话被落盘成别人的供应商**。

同类：`useChatSession.ts:224` 的 `initialModel = identity.effectiveModel.value`（注释称"与落盘值同源"，其实读的是视图 computed）。

### 3.4 磁盘并发写丢失字段

`sessionMeta.ts:49-51` 用 `Promise.all` **并行**发 `set_session_provider` + `set_session_model`，两个命令各自 `spawn_blocking` 对同一个 `<sid>.json` 做 read-modify-write，无锁 → 后写的覆盖先写的。首次发送时最容易撞（写 provider 与写 model 几乎同时）。

## 4. 定稿方案（四笔，每笔可独立验证）

### 第 1 笔：`<sid>.json` 写入收敛为唯一入口（进行中）

- 新增 `MetaField` 三态枚举（`Keep` / `Clear` / `Set{value}`，serde tag `op`），取代"空串 = 删字段"的魔法值；
- 新增 `write_session_meta_blocking`——**唯一**写入路径，一次读、合并 patch、一次写；`rename` / `auto_rename` / `set_session_meta` 全部走它；
- 新增 `set_session_meta(id, provider, model, effort)`，**删除** `set_session_provider` / `set_session_model` / `set_session_effort` 三个单字段命令（读命令保留）；
- L1 `writeSessionMeta` 改为单次调用，不再 `Promise.all`。

lost update 从结构上消失，且"将来要加文件锁只需改一处"。

### 第 2 笔：拆 store / view

- `sessionIdentityStore`（全局一份，按 sid）：`bindings[sid]`、**`lastProvider[sid]`**、`defaultModels`、落盘；只回答"这条会话是什么身份"；
- `useSessionIdentityView()`（每面板一份）：`currentSid`、`pendingDraft`、`resolveSeq`（防异步交错）；`effectiveProvider` / `effectiveModel` / `displayModels` / `lastProvider` 全是视图级 computed；
- `state.ts:301` 那个模块级实例改为 store（events / state / useChatSession 本就是"无面板归属"语义）；
- 三处隐式依赖改为显式传参：`useChatSession.ts:224`、`state.ts:553`、`useChatSession.ts:459`。

### 第 3 笔：行为变更——未启动跟随全局

- 删掉 `restoreBinding` 里的 `setProvider`（`:102`）。它是注册表的**第二个写入方**，而 `useSessionProviders.ts:12` 的契约白纸黑字写着"写入方：useSessionProviders（sendMessage 时…记绑定）"——**这行代码就是漂移点**；
- 统一语义：**有活进程就锁定，没活进程就跟随全局**；
- 门控判据不用改（`needsConfirm` 天然命中），但文案必须从"本次发送将切换供应商"改成"此会话将改用 X"——确认 = 永久改绑。

### 第 4 笔（暂缓）：鸿蒙端按会话供应商算选项集

需要鸿蒙端拿到"会话是否存活"。**意外收获**：`session_provider` 的远程 RPC **早就注册了**（`remote/rpc.rs:73`），鸿蒙端只是没封装，所以这笔比预想的小。

## 5. 设计红线（本次确立，后续照此执行）

1. **拒绝打补丁**：不留"先止血、根治以后再说"；修完若在原地留下"这里为什么这样"的例外，就是补丁。
2. **不要影子参数**：不把语义塞进语义不符的字段传递。本次点名三处——Rust 的空串魔法值、`SendOptions & { effectiveProvider, effectiveModel }`（门控字段缝在发送选项上再拆掉，见 `ChatPanel.vue:302-304`）、L1 的 `undefined | null | "" | string` 四态。
3. **状态按归属放**：会话固有数据按 sid 全局共享，"我在看哪个会话"每面板一份。

## 6. 当前进度与待办

- [x] 方案定稿
- [x] 第 1 笔（Rust）：`MetaField` 三态 + `write_session_meta_blocking` 唯一写入路径 +
      `set_session_meta` 命令，删掉三个单字段命令；`cargo check` 通过
- [x] 第 1 笔（TS/ets）：`api.setSessionMeta` 单一入口；L1 `writeSessionMeta` 单次调用；
      effort 写入也收口进 L1；鸿蒙 `api.ets` 同步（`MetaField` 类 + `setSessionMeta`）
- [x] 第 1 笔验证：`vue-tsc --noEmit` 零错误；前端/SDK 14 个测试文件 **222 passed**；
      Rust `cargo test --lib commands::session` **65 passed**（含新增
      `set_session_meta_writes_all_fields_in_one_pass`）；`cargo check` 仅既有 `automation run_id` warning
- [ ] 第 2 笔、第 3 笔
- [ ] 第 4 笔（暂缓，等 1/2/3 落地后重估）
