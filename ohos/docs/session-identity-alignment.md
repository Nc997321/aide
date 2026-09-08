# 鸿蒙端会话供应商/模型口径对接

面向鸿蒙端（ohos）的改动说明。桌面侧（Rust + SDK）已就位，本文说明**为什么要改**、
**新接口是什么**、**鸿蒙端改哪几处**。

相关提交：`3204f7b`（桌面行为变更）、`fd78438`（身份层拆分）、本文档同批的 Rust 存活表。

---

## 1. 缘由：400 是怎么发生的

### 现象

手机端全局供应商切到 Ollama（`glm-5.3-flash:cloud`），点开一条 DeepSeek 的旧会话发送，
DeepSeek 的 API 收到了 Ollama 的模型名：

```
不支持 glm-5.3-flash:cloud。支持：deepseek-v4-pro / deepseek-v4-flash / ...
```

### 直接原因：两个字段各走各的

| 字段 | 取值来源 | 结果 |
|---|---|---|
| 请求的 baseUrl / key | `send` 时 `provider: null` → 桌面按**会话自己的供应商**解析 | DeepSeek |
| 请求的模型 | 进程当前模型 = 上次 `setModel` 下来的值 | glm |

`ChatModel.ets` 的 `send` 里 `provider: null`（:194）、且**只有新建会话才带 `initialModel`**
（:198），存活会话不重带；而 `pickModel`（:408）**无条件下发** `setModel`，不校验这个模型属
不属于会话的供应商。于是只要「会话有活进程 + 用户在手机端选了别的供应商的模型」，
**点选的瞬间**就会 400，不用等发送。

### 根因：手机端无从判断"这条会话的进程还活着吗"

桌面端的规则是（第 3 笔之后统一为）：

> **有活进程才锁定 spawn 时的供应商，没活进程就跟随全局激活供应商。**

手机端要遵守同一条规则，就必须知道会话是否存活——而它此前拿不到：

- 桌面前端的存活状态在 `useSessionState`（事件驱动），远程 RPC 跑在 Rust 侧，**拿不到前端状态**；
- Rust 侧的 `session_routes` 只在 spawn 时登记、**从不移除**（连 stop 都不清），不能当判据。

所以本次在 Rust 侧建了一张唯一权威的存活表，并暴露成远程 RPC。

---

## 2. 桌面侧提供的接口

### 2.1 新增：`session_alive`

| 项 | 值 |
|---|---|
| 远程方法名 | `session_alive` |
| 入参 | `{ id: string }` |
| 返回 | `boolean`（`true` = 该会话的进程活着） |
| 白名单 | `src-tauri/src/remote/rpc.rs`（已注册） |
| 实现 | `commands/session/mod.rs::session_alive` → `runtime/mod.rs::is_session_alive` |

存活表的维护（都在 Rust 侧，手机端不用管）：

- `session_init` 事件到达 → 登记存活
- `session_dead` 事件到达 → 移除
- `stop_chat_session` 命令 → **立即**移除（不等事件，事件有 RTT 且进程已死时可能不来）
- Runtime 进程整体死亡（`runtime_dead`）→ 全清

### 2.2 已有（可直接用）

| 方法 | 说明 |
|---|---|
| `session_provider(id)` | 读会话绑定的供应商 id；没记过 → `null`。**远程 RPC 早已注册**（`remote/rpc.rs:73`），鸿蒙端此前没封装 |
| `session_model(id)` | 读会话记住的模型；没记过 → `null` |
| `set_session_meta(id, patch)` | 会话元数据**唯一**写入入口（provider / model / effort 一次写齐，详见 §4） |

---

## 3. 鸿蒙端要改的三处

### 3.1 `sdk/api.ets`：补两个封装

照 `sessionModel` 的写法补即可：

```typescript
sessionProvider(id: string): Promise<string | null> {
  return getTransport().invoke<string | null>('session_provider', { 'id': id });
}

/** 会话进程是否存活（决定模型下拉口径，见 docs/session-identity-alignment.md） */
sessionAlive(id: string): Promise<boolean> {
  return getTransport().invoke<boolean>('session_alive', { 'id': id });
}
```

### 3.2 `ChatModel.syncModelEffort`（:302-351）：下拉口径分支

现在是**无条件**用 `providerModel.activeProvider()`（:304）。改成：

```
打开/切会话时：
  1. sid 为空（新会话还没发过消息）→ 用 activeProvider 算选项集（现状，不动）
  2. sid 非空 → 先问 sessionAlive(sid)
     - true  → 用 sessionProvider(sid) 对应的 ProviderConfigView 算选项集
               （拿不到/已删除 → 回退 activeProvider）
     - false → 用 activeProvider 算选项集（与桌面"未启动跟随全局"一致）
```

`fetchModelOptions(p)`（:358）已经是"按 ProviderConfigView 算列表"，只要传对 `p` 就行，
它本身不用改。

**为什么不能省掉 sessionAlive**：省掉就只剩两种极端——要么永远按会话 meta（手机端永远
切不了供应商，与桌面第 3 笔不一致），要么永远按全局（就是现在的 400）。

### 3.3 `ChatModel.pickModel`（:393-419）：跨供应商切换要拦

现在是 `api.setModel(sid, value)` 直接下发。存活会话上，如果 `value` 不属于
`sessionProvider(sid)` 的模型列表，**这个请求必然 400**。两种处理，任选：

- **保守（推荐先做）**：直接拒绝 + toast 提示"该会话正在 X 上运行，如需换供应商请先停止会话"，
  不改 `store.model`；
- **完整**：弹确认（鸿蒙端目前没有确认弹层，要新写），确认后写 `set_session_meta` 改会话
  provider 再 `setModel`。注意桌面的语义是**永久改绑**（没有反向入口），文案别写"本次"。

未存活会话不受限——它跟随全局，选什么就是什么，发送时由桌面门控提醒。

---

## 4. 元数据写入：只有一个入口

`set_session_model` / `set_session_effort` 两个命令**已删除**，统一为：

```
set_session_meta({ id, provider?, model?, effort? })
```

每个字段是三态（不是空串魔法值）：

```typescript
{ op: 'keep' }              // 本次不动
{ op: 'clear' }             // 删掉这个字段
{ op: 'set', value: 'xxx' } // 写入
```

鸿蒙端 `api.ets` 已经改好（`MetaField` 类 + `setSessionMeta`，`ChatModel.ets:417/432` 已切
过去），**不用再动**——列在这里是为了说明为什么 `set_session_model` 不能再用。

---

## 5. 判定表（对照用）

| 场景 | 下拉口径 | 能否换供应商 |
|---|---|---|
| 新会话（还没发过消息） | 全局激活供应商 | 可以（切换即生效） |
| 旧会话，**进程没在跑** | 全局激活供应商 | 可以；发送时桌面弹「此会话将改用 X」确认，确认后**永久改绑** |
| 旧会话，**进程在跑** | 会话自己的供应商 | 不可以（跨供应商切模型必然 400） |

---

## 6. 边界与坑

- **`session_alive` 只在桌面在线时有意义**：会话跑在用户桌面上，桌面不在线时远程调用会失败
  （与其他 RPC 同），按 `false` 处理即可。
- **手机端自己 spawn 的会话**：`session_init` 会到达并登记，所以 `session_alive` 也准。
- **桌面已启动、手机后打开的会话**：以前手机端收不到 `session_init`（它只在 spawn 时发），
  这正是需要 `session_alive` 而不是靠事件推断的原因。
- **`session_provider` 可能为 null**（会话从没记过 / 被删）→ 回退 `activeProvider`，不要崩。
- **改绑是永久的**：`set_session_meta` 写盘后，桌面下次打开这条会话就是新供应商，没有反向入口
  （除非手工改 `~/.aide/sessions/<sid>.json`）。确认文案必须说清。
