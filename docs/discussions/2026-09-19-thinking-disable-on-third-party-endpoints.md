# 思考关不掉：第三方 Anthropic 兼容端点上「快速 ⇒ 关思考」的根因、实测与方案

日期：2026-09-19
触发：切「快速」后模型仍在思考（UI 看不到思考块，但转录 jsonl 里还有）
状态：**已定案并落地**——走 `CLAUDE_CODE_EXTRA_BODY` 注入（§10）；方案 A（线名别名）与方案 B（本地代理）**都不需要**。方案 A 的代码已撤除（形态存档见 §9）

---

## 0. 一句话结论

「快速 ⇒ 关思考」这条链路我们这边全部正确（决策 + 重建 query + 参数），**但 CLI 会对"它不认识的模型名"整个丢掉 `thinking` 字段**，而兼容端点「没有该字段 = 默认开推理」——于是只剩展示层隐藏、token 照烧。

正解已落地：**用 `CLAUDE_CODE_EXTRA_BODY` 把 `thinking` 直接写进请求体**，绕过 CLI 那份名单。模型名保持精确真名，不依赖供应商认 Claude 名，也不需要任何新组件（见 §10；为什么没走 A/B 见 §5）。

---

## 1. 现象与定位：两种「看不见」要分清

用户看到「UI 上没有思考块」，但**转录 jsonl 里还有**——这两件事不矛盾，是两条通道：

| 通道 | 内容 | 归谁管 |
|---|---|---|
| UI 展示 | sidecar 事件流 → 前端渲染 | 我们（`showThinking = thinkingEnabled`，可剥除） |
| 转录 jsonl | CLI 按 API 原样响应写入 | 上游；**有思考块 = 模型确实推理过** |

**判据**：拿转录当"模型真的想了没"的证据，别拿 UI。反过来，"UI 干净"从来不能证明"没推理"。

---

## 2. 根因（三层，缺一不可）

```
第 1 层 CLI：按模型名查**本地名单**（编译在 claude.exe 里）
             名单内 → 按调用方要求发 thinking 参数
             名单外 → **整个字段都不发**   ← 病灶
                          │
第 2 层 端点：没有 thinking 字段 = 默认开推理（DeepSeek 兼容层实测）
                          │
第 3 层 端点：名字还有第二重含义——**选型**（见 §3 F8）
```

关键区分：**"能不能关思考"取决于第 1 层（CLI 肯不肯发参数），"最终给你哪个模型"取决于第 3 层（端点的名字映射表）。** 我们只拥有"报什么名字"这一个自由度。

---

## 3. 实测事实（每条都可复跑，探针见 §7）

### F1 端点对**任何**名字都认 `disabled`
报 `deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-pro` / 各种 Claude 名，只要带
`"thinking":{"type":"disabled"}` → 响应块只有 `["text"]`，**无推理** ✓。
⇒ 病灶确实只在 CLI 那一层。

### F2 CLI 对陌生名字**不发**该字段
抓包（本地捕获端点，原始字节）：
- `model=claude-opus-4-8` + 要求关 → body 键含 `thinking` ✓ `{"type":"disabled"}`
- `model=deepseek-flash` + 要求关 → body 键**不含** `thinking` ✗
- `model=deepseek-flash` + 要求开（adaptive）→ **发**了 ✓

⇒ 不是"陌生模型什么都不发"，而是**"它认为这模型不会思考 → 关思考这个参数是多余的 → 省掉"**。

### F3 注册表写不进去
试过 6 种 `settings.modelSettings["deepseek-flash"]` 形状（`supportsThinking` / `supportsAdaptiveThinking` / `supportsEffort` / `thinking` / `canThink` / 基线）→ **一律无效**，CLI 依旧不发字段。CLI 的 `--help` 也没有任何 thinking/reasoning 相关 flag。

### F4 名字在端点上**是选型开关**（这条最反直觉）
| 报的名字 | 端点实际给的模型（响应自报） |
|---|---|
| `claude-sonnet-5` | `deepseek-flash` |
| `claude-opus-4-8` | `deepseek-v4-pro` |
| 4 个 haiku 名（全试） | `deepseek-flash` |
| `deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-pro` | 同名（精确名直通，服务端不翻译） |
| `deepseek-chat` | `deepseek-v4-flash`（它自己的别名表） |
| `deepseek-pro` | **400**（不是精确名、也不在它表里 → 直接拒） |

⇒ 该兼容层只有**两档**：`sonnet|haiku → deepseek-flash`、`opus → deepseek-v4-pro`。
⇒ **`deepseek-v4-flash` 没有对应的 Claude 名** —— 它在"选型正确"和"能关思考"之间只能二选一。

### F5 服务端会在多个层面替我们解释名字
- 它自己的别名表（`deepseek-chat → deepseek-v4-flash`）
- Claude 名映射（见 F4）
- 表外名字 **400 拒绝**（错误信息是服务端写的："The supported API model names are …"）

### F6 ollama 不认 Claude 名
直打本机 `http://127.0.0.1:11434/v1/messages`：
- `claude-sonnet-5` → **404** `model 'claude-sonnet-5' not found`
- `ornith-1.5:9b` → 200 ✓

⇒ 一刀切"永远用 Claude 名"会把 ollama 通道整个跑挂。
⇒ **ollama 认不认 `disabled` 仍未验**（待办）。

### F7 思考只能 spawn 生效
- SDK 没有运行时的 thinking setter（`applyFlagSettings({alwaysThinkingEnabled:false})` 被 CLI **静默接受但请求体一字不变**，且关了就回不来——单向锁死）
- ⇒ 改思考必须重建 query

### F8 respawn + resume 对 prompt cache **透明**（真实 API 实测）
同一会话三段对比：基线（同 query 第二轮）`in=176 + read=52352`；**杀进程 → 新 query 带 resume** 后 `in=215 + read=52352` —— **cache_read 一字不差**。
⇒ 为切档重建 query 不吃缓存亏。（副作用：ollama 通道**不报任何缓存字段**，那条通道既没有可冷的缓存也看不到收益。）

### F9 档位是思考的唯一事实源（今天已改）
`设置→通用 → 启用思考` 开关**已删除**：两个事实源必然打架（切了快速却又开着思考）。
现规则：`thinking_enabled = (档位 != "low")`，见 `src-tauri/src/commands/chat.rs` 的 `thinking_enabled_for_effort`。

---

## 4. 今天的代码改动（已落地，未提交）

| 文件 | 改动 | 验证 |
|---|---|---|
| `src-tauri/src/commands/chat.rs` | `thinking_enabled_for_effort`（档位唯一事实源）；`apply_wire_model_alias`（在 `build_send_command` **最后一步**替换交给 CLI 的 `ANTHROPIC_MODEL`）；**设了就一定注入**（模型名有三个来源，provider 留空时靠环境变量，只替换已存在的值会漏） | 单测 4 臂 + 规则 8 断言，`cargo test --lib commands::chat` 27 条过 |
| `src-tauri/src/runtime/provider/mod.rs` | `ProviderModelMappings.wire_model_alias`（空 = 不启用），住 `modelMappings` 里是刻意的：设置面板对 provider 是**深拷贝**，字段能原样往返；放顶层会被 `save_provider_inputs` 的"全新构造"**静默抹掉** | 同上 |
| `src-tauri/src/commands/settings.rs` | 删掉 `thinking_enabled` 设置字段（含 default fn 与 `Default` impl）；旧配置残留键被 serde 忽略，下次写盘自消 | 同上 |
| `agent-sidecar/src/engine/session-worker.ts` | `spawnedThinking` 记账 + `restartPending` 归因标志 + `restartQueryForThinking`：**思考值漂移 → 下一条空闲 send 原地 resume 重建**（不 fork、会话 id 不变、不发任何伪造终态）。`rollbackInjection` 泛化成 `nextQueryInjections[]`（图片回滚与重启共用预置槽） | 单测 3 条 + 台账冒烟 |
| `agent-sidecar/src/engine/effortSwitch.ts`、`src/components/ChatPanel/ChatInputBox.vue`、`packages/aide-sdk/src/types.ts` | 注释与文案改成如实口径（"已**请求**关闭思考"），并把"请求 ≠ 真关"的前提写进三处 | 前端 2961 条过 |
| 同日另一件（无关本主题）：`lib.rs` 恢复 single-instance 的 dev 豁免 + `remote/mod.rs` 新增 `relay_allowed_in_this_build()` 挡住 dev 连 relay | 深挖 `src-tauri/src/lib.rs:101` 与 `remote/mod.rs` 注释：**两件事是一对，改一个必须同时看另一个**（否则复活 relay 互踢） | 真机验证：dev 与安装版并存、dev 不连 8787 |

**闸门（2026-09-19 结案后重测）**：`npx vitest run` 全仓 238 文件 / 2966 用例全过；Rust `cargo test --lib commands::chat` 26 过；`vue-tsc`、`cargo check`、`check:sync-io`、`check:overlay-layers`、`check:tauri-imports` 干净。

> ⚠️ **订正上一段"前端 2961"的叫法**：根 `vitest.config.ts` 的 include 是 `src/**` + `agent-sidecar/src/**` + `packages/**`——那条命令**从来就不是"只跑前端"**，它一直是全仓（含 sidecar）。单跑 agent-sidecar 是 75 文件 / 1113 用例。引用这个数时别再当成分端计数。

**定案补丁（EXTRA_BODY 路线）**：`engine/cliEnv.ts`（注入 + 先删后设）、新增 `engine/thinkingPolicy.ts`（唯一推导点）+ 单测、`session-worker.ts`（算一次落值）、`session-worker/queryOptions.ts`（改消费该值）。方案 A 的 `wire_model_alias` 全线撤除（存档见 §9）。新增探针 `probe-extra-body.ts`（5 臂，定案依据）与台账冒烟 `smoke-thinking-extrabody.ts`（4 判据）；旧 `smoke-thinking-alias.ts` 随方案 A 删除。

**两条被负载暴露的既有脆弱测试**（与本次改动无关，但会咬人，四次全量跑里各红一次、单跑都过）：
- `src/components/ChatMessage.renderScale.test.ts` 的节点数用例卡在 vitest 5s 默认预算边上（实测 5671ms）→ 已改为与同文件另一条一致的 30s 结构性预算（断言是节点数上限，放宽超时不掩盖东西）。
- `agent-sidecar/src/engine/subagentOutputTail.test.ts` 的"单次 tick 最多读 1MB"用例：`tickOnce()` 靠**推进固定步数**的 0ms 定时器去等**真实 fs** 落地，负载下 fs 落在步数之外就断言失败（单跑 8/8 过）。**未修**——修法应是改成等条件（poll 到事件出现）而不是等步数。

---

## 5. 曾经的待决策：两条方案（+ 两个备选）——**均未采用**

> **2026-09-19 结案**：两条都没走。根因第 1 层（CLI 丢字段）有一条**不需要绕**的直路——
> `CLAUDE_CODE_EXTRA_BODY` 把字段直接写进请求体（§10）。A 的「要供应商认 Claude 名」与
> B 的「新增关键路径组件」两个代价**同时消失**。下面保留原文，供理解当时的选择空间。

### 方案 A：线名别名（现状；建议升级为**映射表版**）
- **做法**：`modelMappings.wireModelAlias` 填 Claude 名 → 交给 CLI 的 `ANTHROPIC_MODEL` 换成它 → CLI 肯发 `thinking` → 端点照办。
- **现状**：单字符串版（`wireModelAlias: "claude-sonnet-5"`）。**尚未启用**（config.json 里没填）。
- **已知缺陷**：单字符串版**会锁死选型**（一律报 sonnet → 永远是 deepseek-flash）。**必须升级为按模型映射**：
  ```json
  "modelMappings": { "wireModelAlias": {
      "deepseek-flash":   "claude-sonnet-5",
      "deepseek-v4-pro":  "claude-opus-4-8"
  } }
  ```
  查不到就不换（安全回退：选型正确、思考关不掉但不撒谎）。
- **依赖**：供应商的兼容层**认 Claude 名**（DeepSeek ✓ / ollama ✗ 404 / 其它未验）。
- **成本**：小（字符串替换）。

### 方案 B：本地透传代理（更彻底）
- **做法**：`ANTHROPIC_BASE_URL` 指向我们自己的小转发；它只做一件事——`POST /v1/messages` 时**往 body 里加 `thinking:{"type":"disabled"}`**。
- **优点**：模型名保持**精确真名**（选型 100% 归我们，`deepseek-v4-flash` 也能关）；**不依赖供应商认 Claude 名**；不依赖 CLI 合作。
- **代价**：多一个**夹在所有 API 流量必经之路上的常驻组件**（流式 SSE / 错误 / 鉴权 / 其它端点都要原样透传）；它出问题 = 全线会话不可用。
- **可行性已被 F1 证明**（端点对任何名字都认 disabled）。

### 备选 C：换一个本来就不推理的模型（改产品选择，不是"同模型关思考"）
### 备选 D：不做（只隐藏显示；文案已如实）

| | A（映射表版） | B（本地代理） |
|---|---|---|
| 依赖供应商认 Claude 名 | 必须 | **不需要** |
| 模型选型自由度 | 受它映射表限制 | 100% |
| 新增基础设施 | 无 | **有一个关键路径组件** |
| 风险 | 某些端点不生效（退化为只隐藏） | 代理出错则全线不可用 |
| 工作量 | 小 | 中（要做透传测试/流式对拍/失败回退） |

**倾向**：短中期 A（已覆盖 DeepSeek 两个主要模型）；想要彻底（含 `deepseek-v4-flash`、其它第三方）再上 B。

---

## 6. 剩余待办（2026-09-19 结案后）

**已结**：① 决策 → 走 EXTRA_BODY（§10）② 启用与否 → 不需要任何配置，按档位自动生效，没有 config.json 要填（也不再有"安装版与 dev 共享配置"的顾虑）③ **ollama 认不认 `disabled` → 认**：本机 `/v1/messages` 直测，不带字段出 `thinking` 块、带 `{"type":"disabled"}` 只出 text，且 **HTTP 200 不报 400**。

**未结**：

1. **官方 Anthropic 端点上的「快速 ⇒ 关思考」从未验过**（本机无凭据）。现在多了一层新风险：EXTRA_BODY 是**硬覆盖**（§10 E 臂），而官方端点上 CLI 本来就会自己发 `disabled`，两者同值、理论上无冲突——但没实机验过。
2. ~~`deepseek-v4-flash` 没有对应的 Claude 名~~ → **不再是问题**：EXTRA_BODY 不改名字，选型自由度 100%（这正是 B 当初想买的东西，白拿了）。
3. **EXTRA_BODY 是未文档化的内部 env**：CLI 升级可能改名或移除，届时静默退回"照烧 token"。金丝雀挂在 `smoke-thinking-extrabody.ts` 的 **A 臂**（不注入时仍有思考块）——升 SDK/CLI 后跑一次即知；A 臂变绿＝CLI 自己修了，注入可以撤。
4. ~~探针去留~~ → **已办**（2026-09-19）：留 4 删 9，清单与理由见 §7。⚠️ 但留存的 4 个**还没 `git add`**——"入仓"这半件事没做，仍然只在工作区。

---

## 7. 附录：探针与冒烟清单

**留存的 4 个** —— ⚠️ **至今仍是未跟踪文件**：`git add` 之前，"可复跑"只在这台机器上成立。

| 文件 | 用途 | 跑法 |
|---|---|---|
| `agent-sidecar/smoke-thinking-extrabody.ts` | **台账冒烟**（4 判据）：真打到上游(B0) + 注入臂无思考(B1) + 自报真名(B2) + 金丝雀(A) | `AIDE_BASE_URL=http://127.0.0.1:11434 AIDE_MODEL=ornith-1.5:9b npx tsx smoke-thinking-extrabody.ts`（ollama 零成本）；打真供应商则补 `AIDE_TOKEN=…` |
| `agent-sidecar/probe-extra-body.ts` | **本主题定案依据**：`CLAUDE_CODE_EXTRA_BODY` 5 臂（正对照 / 复现 F2 / 摊入对照 / 本命 / 合并次序） | `npx tsx probe-extra-body.ts`（只本地捕获，不转发上游，零成本） |
| `agent-sidecar/probe-cli-body-replay.ts` | **通用工具**：抓 CLI 真实 body 并原样转发 —— "选项传入 ≠ 参数发出" 的破局手段，下次遇到同类问题**第一件该跑的事** | `npx tsx probe-cli-body-replay.ts [model] [disabled\|adaptive]` |
| `agent-sidecar/smoke-thinking-restart.ts` | 台账冒烟：漂移 → 原地重启（id 不变 / 无伪造终态） | 同目录 `npx tsx smoke-thinking-restart.ts` |

**已清理的一次性调研探针（9 个，2026-09-19 结案后删除）**：`probe-deepseek-models` / `probe-deepseek-param-matrix` / `probe-deepseek-history-thinking` / `probe-endpoint-thinking-disabled` / `probe-registry-write` / `probe-effort-midturn` / `probe-thinking-midsession` / `probe-thinking-replay` / `probe-cache-respawn`。

> 它们的**结论仍在 §3 的 F1–F9 里，但脚本已经没了、跑不了了**。这 9 个从未进过 git（一直未跟踪），删掉即永久消失。下次碰本主题前先 `git add`——仓库已经因为"调研探针没进仓（基线不可复跑）"吃过一次同样的亏。

> 通用注意：探针在 Claude Code 会话里跑要**清掉继承的 `CLAUDE_CODE_*`/`ANTHROPIC_*`**，否则子 CLI 会以为自己是嵌套子会话、注入父会话语境（脚本里改 `env` 不够，SDK 会重新合并 `process.env`）。
>
> 另注意：**CLI 无凭据时会直接回 `Not logged in · Please run /login` 并且根本不发请求**，而它伪装成一条正常 assistant 消息（`model: "<synthetic>"`）。跑任何"端点认不认某参数"的探针，不认这条就会把"请求失败"读成"参数生效"——`smoke-thinking-extrabody.ts` 的 B0 判据就是钉这个的。

---

## 8. 方法论教训（本轮踩的，写下来防复发）

1. **拿单个样本当规律**——本轮犯了三次：只测一个 Claude 名就说"报哪个名字不影响选型"（F4 打脸）；只测"端点不认 disabled"就下了结论（其实是 CLI 丢字段）；只看 UI 就说"关掉了"（转录里还在）。**每个结论都要问一句"样本量够吗、有没有反向对照"。**
2. **选项传入 ≠ 参数发出 ≠ 端点生效**——三个独立命题，中间任何一层都可能悄悄丢掉它。本轮真正的破局点只有一步：**把 CLI 的 body 原样抓下来看**（一眼看到 `thinking=undefined`），此前四轮推断全在猜。
3. **"源改了"≠"产物改了"≠"进程重起了"**——今天两次翻车都在这缝里。判据固定成两条：**进程启动时间 > 产物 mtime**、**二进制 mtime > 源文件 mtime**（grep 符号会被内联掉，不可靠）。
   **2026-09-19 补记：这条又被踩了一次，而且是在写下它之后。** 定案补丁改完 sidecar 的 `src/` 没重建 `dist/runtime.js`（那是凌晨的产物，里面没有注入代码）就去看实测——看到的自然是旧代码行为，一度被当成"改动没生效"。根因是 `beforeDevCommand` 当时为 `pnpm build:codegraph && pnpm dev`，**不编 sidecar**，而 dev 分支跑的是 `node dist/runtime.js`。**现已堵死**：新增 `build:sidecar:dev`（只跑 esbuild，约 0.5s，不跑 107MB 的 bun 打包）并挂进 `beforeDevCommand`；release 路径本来是好的（`release` 自己先跑 `build:sidecar`）。
   **教训**：源码级探针全绿、单测全绿，**都不等于运行中的进程里有你的改动**。改 sidecar 后要么看产物 mtime，要么直接重启 dev。

---

## 9. 存档：方案 A（线名别名）的代码形态（已撤）

**2026-09-19 决策**：改走 `CLAUDE_CODE_EXTRA_BODY`（见 §10），方案 A 的代码从工作区**撤除**——它从未启用过（`wire_model_alias` 默认空、无 UI 入口、config.json 里没填过），留着就是死代码（红线：无死代码）。

**撤除不可逆**：这批改动从未提交，没有 git 历史可回滚。故形态存档于此，需要时按 9.1–9.4 原样贴回。

### 9.1 `src-tauri/src/runtime/provider/mod.rs`（`ProviderModelMappings` 末尾字段）

```rust
    /// **线名别名**（空 = 不启用）：交给 CLI 的 `ANTHROPIC_MODEL` 换用这个名字。
    ///
    /// 为什么需要它（2026-09-19 实测）：CLI 拿模型名**查自己本地的能力表**，只对认识的
    /// 模型才往请求体里塞 `thinking` 参数。名字陌生（如 `deepseek-flash`）时它**整个字段
    /// 都不发**，而兼容端点「没有该字段 = 默认开推理」——于是「快速档关思考」只剩展示层
    /// 隐藏，token 照烧（实测：同端点同参数，`claude-sonnet-5` 无思考块、`deepseek-flash`
    /// 有）。填一个 CLI 认识的模型名即可让参数真正发出去，端点按名字路由/忽略，行为不变。
    ///
    /// **只影响交给 CLI 的那一个字符串**：UI、会话元数据、模型徽标一律保留真名（徽标读的
    /// 是 API 自报的 model，实测端点仍自报真名）。
    ///
    /// 刻意**不做成设置面板的字段**（UI 保持现状）——这是"对 CLI 谎报模型名"的权宜之计，
    /// 手改 config.json 启用即可。CLI 升级后要重验；验收判据必须两条一起：
    /// ① 响应自报 model 仍是真名 ② 响应无 thinking 块（只验②会漏掉"端点静默换模型"）。
    #[serde(default)]
    pub wire_model_alias: String,
```

同文件 `strategy/system_default.rs` 的 `build_system_default_mappings` 里补一句：

```rust
        // 系统默认 provider 的模型名取自官方 roster（claude-*），CLI 本就认识——
        // 别名没有意义，恒空（见 ProviderModelMappings.wire_model_alias 注释）。
        wire_model_alias: String::new(),
```

### 9.2 `src-tauri/src/commands/chat.rs`（四处）

```rust
// ① SendOptions 字段（紧跟 initial_effort 之后）
    /// provider 的线名别名（`model_mappings.wire_model_alias`，空 = 不启用）——
    /// 只在交给 CLI 的 ANTHROPIC_MODEL 上生效，UI/元数据仍用真名。
    wire_model_alias: &'a str,

// ② build_send_command 末步（必须在 attach_* 全部之后，见函数注释）
    // 线名别名必须当**最后一步**：provider env 与 per-send 覆盖是两个来源，只有在此刻
    // env.ANTHROPIC_MODEL 才是最终值（见 apply_wire_model_alias 注释）。
    apply_wire_model_alias(&mut cmd, opts.wire_model_alias);

// ③ 函数本体
/// 把交给 CLI 的模型名换成别名（`wire_model_alias`，空 = 不动）。
///
/// **设了就一定注入**（不是"存在才替换"）：模型名的来源有三处——provider 配置、
/// per-send 覆盖、以及**进程环境变量**（provider 没配模型时 CLI 吃环境里的那份）。
/// 前两处已在 cmd.env 里，第三处不在——只替换已存在的值会漏掉最常见的一种（provider
/// 留空、靠环境变量驱动），别名就白设了。显式设了别名 = 用户要求这个名字胜出。
fn apply_wire_model_alias(cmd: &mut serde_json::Value, alias: &str) {
    if alias.is_empty() {
        return;
    }
    cmd["env"]["ANTHROPIC_MODEL"] = json!(alias);
}

// ④ 单测
    /// 线名别名：**只换交给 CLI 的那个字符串**。关键不变量——provider env 与
    /// per-send 覆盖是两个来源，别名是最后一步，两个都跑不掉（漏一个就会回到
    /// 「CLI 不认识模型名 → 不发 thinking 参数」的老问题）。
    #[test]
    fn build_send_command_applies_wire_model_alias() {
        let env: HashMap<String, String> =
            HashMap::from([("ANTHROPIC_MODEL".to_string(), "deepseek-flash".to_string())]);
        // ① provider env 里的模型名被换
        let cmd = build_send_command(
            "s", "hi", "/tmp", &env,
            SendOptions { wire_model_alias: "claude-sonnet-5", ..base_opts() },
        );
        assert_eq!(cmd["env"]["ANTHROPIC_MODEL"], "claude-sonnet-5");
        // ② per-send 覆盖（前端选择器的真名）同样被换
        let cmd2 = build_send_command(
            "s", "hi", "/tmp", &env,
            SendOptions {
                initial_model: Some("deepseek-flash".to_string()),
                wire_model_alias: "claude-sonnet-5",
                ..base_opts()
            },
        );
        assert_eq!(cmd2["env"]["ANTHROPIC_MODEL"], "claude-sonnet-5");
        // ③ 空别名 = 一字不动（默认关闭语义）
        let cmd3 = build_send_command("s", "hi", "/tmp", &env, base_opts());
        assert_eq!(cmd3["env"]["ANTHROPIC_MODEL"], "deepseek-flash");
        // ④ 模型名一个来源都没有（provider 留空、前端也没选）时**也要注入**——
        //    此时 CLI 会去吃进程环境变量里那份，只替换已存在的值就漏掉了这种最常见的情形。
        let cmd4 = build_send_command(
            "s", "hi", "/tmp", &HashMap::new(),
            SendOptions { wire_model_alias: "claude-sonnet-5", ..base_opts() },
        );
        assert_eq!(cmd4["env"]["ANTHROPIC_MODEL"], "claude-sonnet-5");
    }

// ⑤ 调用点（send_chat 里组装 SendOptions）
            wire_model_alias: &active.model_mappings.wire_model_alias,
```

### 9.3 TS / Vue 侧镜像（三处）

```ts
// packages/aide-sdk/src/types.ts —— ProviderModelMappings
  wireModelAlias: string;

// packages/aide-sdk/src/composables/useProviders.ts —— emptyModelMappings()
  wireModelAlias: "",

// src/components/ProviderSettings.vue —— 两处草稿构造
  wireModelAlias: "", // 预置默认不启用
```

### 9.4 启用方式（config.json，安装版与 dev 共用）

```json
"modelMappings": { "wireModelAlias": {
    "deepseek-flash":  "claude-sonnet-5",
    "deepseek-v4-pro": "claude-opus-4-8"
} }
```

（映射表版相对单字符串版的差别：单字符串会**锁死选型**——一律报 sonnet 就永远是 `deepseek-flash`；映射表版查不到就不换，安全回退。）

---

## 10. 定案：`CLAUDE_CODE_EXTRA_BODY` 注入（2026-09-19 落地）

### 10.1 是什么

CLI 读一个**未文档化**的 env `CLAUDE_CODE_EXTRA_BODY`（JSON 对象），把它**摊进 `/v1/messages` 的请求体**。`claude.exe` 内的证据（逐字）：

```js
function vM(e){let t=process.env.CLAUDE_CODE_EXTRA_BODY,r={};if(t)try{let u=Ut(t);
 if(u&&typeof u==="object"&&!Array.isArray(u))r={...u};else n(`CLAUDE_CODE_EXTRA_BODY env var must be a JSON object, but was given ${t}`,{level:"error"})}
 catch(u){n(`Error parsing CLAUDE_CODE_EXTRA_BODY: ${l(u)}`,{level:"error"})}
 let o=r.metadata; ... if(e&&e.length>0){...r.anthropic_beta=...} return r}
```

调用点（`sa` 就是它，字段被读出/删除后交给 body 组装器）：

```js
sa=vM(Qi); B7n(sa,...); let ga={...sa.output_config??{}};
delete sa.output_config, j7n(et,ga,sa,Ir,F), ...
```

更直接的旁证是 CLI 的**净化器**——它专门把 `{type:'disabled'}` 上的多余键剥掉，遥测里还记 `hasExtraBodyEnv`（即官方已知有人经这个 env 塞 `thinking`；我们塞的是没有多余键的 `{"type":"disabled"}`，原样放行）：

```js
function H7n(e,t,r){if(e?.type!=="disabled")return e;
 let o=Object.keys(e).filter(u=>u!=="type"); if(o.length===0)return e;
 if(r) s("tengu_thinking_disabled_sanitized",{...,hasExtraBodyEnv:a.CLAUDE_CODE_EXTRA_BODY?w("true"):w("false")}),
   n(`[thinking] stripped ${o.length} extra key(s) from {type:'disabled'} thinking param (gh-68567)`,{level:"warn"});
 return{type:"disabled"}}
```

### 10.2 为什么它比 A / B 都好

- **比 A**：不改模型名——选型自由度 100%（`deepseek-v4-flash` 这类没有 Claude 名的模型也能关思考），且不依赖供应商认 Claude 名（ollama 认不认 Claude 名都无所谓）。
- **比 B**：零新增组件——没有代理、端口、SSE 透传，也就没有"代理挂了全线不可用"的关键路径风险。
- 增量极小：`cliEnv` 一条注入 + 一处推导收敛（§10.4）。

### 10.3 实测

`probe-extra-body.ts` 5 臂（只本地捕获，**不转发上游，零成本**）：

| 臂 | 模型名 | body 注入 | 结果 |
|---|---|---|---|
| A | `claude-sonnet-5` | — | `thinking={"type":"disabled"}`（正对照：harness 能看见） |
| B | `deepseek-flash` | — | `thinking=null`（复现 F2） |
| C | `deepseek-flash` | `{"top_k":42}` | `top_k=42`（**摊进 body 这件事成立**） |
| **D** | `deepseek-flash` | `{"thinking":{"type":"disabled"}}` | **`thinking={"type":"disabled"}`** ← 定案依据 |
| **E** | `deepseek-flash` + SDK 要 adaptive | 同上 | **`{"type":"disabled"}`** ← EXTRA_BODY **硬覆盖** SDK 选项 |

C 臂是关键：没有它，D 臂的"字段不在"分不清是"没摊进去"还是"摊进去又被删了"。

端到端（真 CLI + 真端点，`smoke-thinking-extrabody.ts` 4/4，用本机 ollama 零成本跑通）：

```
A 臂（不注入）：块=["thinking"]  自报=ornith-1.5:9b   ← 陌生名字确实丢字段（真推理模型上复现 F2）
B 臂（注入）  ：块=["text"]      自报=ornith-1.5:9b   ← 真关掉，且模型名没被偷换
```

**两条顺带更正**：

1. **ollama 认 `disabled`**：旧注释里"ollama 等兼容端点不认 thinking 参数"的说法来自 mock 端点，**是错的**（真 ollama 实测：不带字段出 thinking 块、带 `disabled` 只出 text）。而且它**不会因为多这个字段而 400**——不存在"注入打断 ollama 通道"的风险。
2. `ornith-1.5:9b` 的 `capabilities` 只写 `completion/vision`，但它**默认就会推理**。别拿 capabilities 当"会不会思考"的判据。

### 10.4 落地形状

- `engine/thinkingPolicy.ts`（新增）：`thinkingDisabledFor({automation, thinkingEnabled})`——**唯一推导点**，Rust 侧 `thinking_enabled_for_effort` 的对偶。
- `engine/cliEnv.ts`：`CliEnvParams.thinkingDisabled`（**必填**，不用 `?:`——那是假三态）；函数体先 `delete` 再按需设 `THINKING_DISABLED_BODY`。
- `session-worker.ts:751` 附近：算一次落值，同一个值喂 env 与 SDK 选项（下面还有 `await prepareQueryContext`，两处各推一遍会在装配窗口里劈叉）。
- `session-worker/queryOptions.ts`：`thinking` 改为消费 `p.model.thinkingDisabled`。

**必须记住的一条**：EXTRA_BODY 是**硬覆盖**（E 臂），而 `buildCliEnv` 从 `{...process.env}` 起手——所以那句 `delete cliEnv.CLAUDE_CODE_EXTRA_BODY` 是**安全必需**，不是洁癖。残留一次就静默吃掉每个会话的思考（与 `CLAUDE_CODE_EFFORT_LEVEL` 同一个坑、同一个范式）。

### 10.5 方法论

**别急着建基础设施。** 方案 A/B 的选择建立在一个**从未被验证的前提**上："我们只拥有'报什么名字'这一个自由度"。它其实是"CLI 不会让我们改 body"的推断。一次对 CLI 产物的字符串检索就推翻了它——CLI 早就留了这个口子，只是没写进文档。

与 §8.2 同源：**先问"这一层真的拦着我吗"，再决定绕多大一圈。**
