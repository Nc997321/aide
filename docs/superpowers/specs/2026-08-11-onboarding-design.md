# 首次安装引导（Onboarding）设计

- 日期：2026-08-11
- 状态：设计已批准，待出实现计划
- 范围：aide 桌面应用首次安装打开时的引导界面

## 1. 问题与目标

### 1.1 现状缺口

全新用户安装 aide 双击打开后，**完全没有引导**：

- 窗口打开 → 空侧栏 + 中央 hero（"新会话位于 · 使用 默认模型" + 输入框）+ 空文件树。
- 用户不知道三件必做事：① 要先有工作区才能正经开聊（用户心智模型如此；实际代码也允许无工作区开聊，但文件树/CodeGraph/运行配置全失效）；② 要配官方 Claude 凭证（claude CLI 有 OAuth 登录引导，aide 没有）；③ 连"要配供应商和模型"这个概念都不知道。
- 后果：首条消息因无凭证直接报**原始 SDK 401 错误**（`useChatSession` 把 SDK error 当 `error` chat-event 落聊天区，用户无法归因）；文件树空态文案是"首次使用 / 工作区被删"，无引导。
- 系统无"首次运行"标志：全仓无 `onboarded`/`initialized`（持久化）/`firstRun` 字段，无法区分新老用户。

### 1.2 目标

引导界面核心使命是**教一个完全懵的新用户"怎么用 aide"**——把 工作区 → 登录 Claude → 供应商/模型 三件事串成一个有仪式感的引导流程，而不是最小化的凭证采集。

### 1.3 非目标

- 不做 OAuth 从零实现（合规风险，见 §6.4）。
- 不强制完成所有步骤才能进 app（用户选择"全可跳过"）。
- 不做功能介绍/特性巡游 tour——每一步都是真实配置动作，不是看图说话。
- 不改 runtime/sidecar 引导逻辑（runtime/claude.exe 已随包自动起）。

## 2. 总体方案

**全屏沉浸式分步向导**（方案 A，已批准）：

- 整窗覆盖（含标题栏）的全屏覆盖层，z-index 1200（与 ModalDialog 同层，二者不共存——onboarding 是首启动、早于任何弹窗），复用 ModalDialog 遮罩范式。Teleport to body，覆盖 app-shell 全部内容；模型步的 ThemedSelect 下拉 Teleport 到 body、z-index 9999，自然渲染在 onboarding 之上。
- 一步一屏，线性向导：`01 欢迎 → 02 工作区 → 03 登录 Claude → 04 模型 → 进入 aide`。
- 顶部进度轨（带步骤名）+ 右上"跳过引导"胶囊 + 底部"上一步 / 下一步"。
- glass 暗色质感（默认 glass 主题），极光氛围 + 模糊，accent 渐变 + 辉光主按钮。
- **全可跳过**：每步可跳过；右上"跳过引导"直接进 app；已登录/已有工作区时对应步自动略过。
- **跳过不丢**：跳过的步骤后续撞缺口时由"上下文兜底"接住（§7），不再裸 401。

## 3. 步骤流程

```
01 欢迎 ──→ 02 工作区 ──→ 03 登录 Claude ──→ 04 模型 ──→ 进入 aide
(签名)      (选文件夹)    (OAuth 主/key 兜底)  (默认+可改)
```

每步职责：

| 步 | 标题 | 动作 | 可跳过 | 自动跳过条件 |
|---|---|---|---|---|
| 01 欢迎 | "和 Claude 并肩写代码" | 签名时刻：logo + 价值主张 + 三步预览 + "开始" | 是 | 无（首屏） |
| 02 工作区 | "选一个文件夹开始" | 文件夹选择器（Tauri OpenFolderDialog + 拖拽）→ `createWorkspace` | 是 | 已有激活工作区 |
| 03 登录 Claude | "登录你的 Claude 账号" | OAuth 浏览器登录（主）/ API key（兜底） | 是 | 已有有效凭证（`~/.aide/claude/.credentials.json` 存在 或 SystemDefault apiKeyConfigured） |
| 04 模型 | "用哪个模型？" | 下拉选默认模型（登录后 `refreshSystemDefaultModels` 加载） | 是 | 无（总是展示，建立"模型来自供应商"认知） |

顺序理由：工作区在登录前——工作区选完即时填充文件树（可见反馈），比抽象的登录更适合做第一步，也贴合"新对话要先有工作区"的用户直觉。

## 4. 视觉设计

### 4.1 复用 token（全部 `var(--aide-*)`，禁硬编码 hex）

默认 glass 主题：accent `#a5b8ff`、textPrimary `#eef0f8`、textSecondary `#b9bdd0`、textMuted `#7c8296`、border `rgba(255,255,255,.1)`、accentGradient、accentGlow、highlightInset、surfaceBlur（`blur(20px) saturate(150%)`）、radius sm/md/lg = 8/10/14、ease `cubic-bezier(.2,.8,.2,1)`。

### 4.2 chrome（全步通用）

- **覆盖层**：`position: fixed; inset: 0; z-index: 1200`；背景 = 三层极光 radial-gradient + `rgba(10,11,17,.78)` 兜底 + `backdrop-filter: var(--aide-surface-blur)`。
- **顶部行**：左 = 进度轨（4 段，每段 = 3px 横条 + 步骤名；done = accent 55%；cur = accentGradient + 8px 辉光；future = surface-active）；右 = "跳过引导"胶囊（ghost，hover surface）。
- **中央列**：`max-width: 540px; text-align: center`，垂直居中。eyebrow（10px accent 600 letter-spaced）→ headline（24px 600）→ support（13px secondary 1.65）→ action 区。
- **底部行**：左 = "上一步"（ghost，首步隐藏）+ 辅助提示；右 = "下一步/开始/进入 aide"（primary，accentGradient + accentGlow + highlightInset，hover translateY(-1px) + brightness(1.07)）。
- **字体**：继承全局 Inter Variable 13px 基准；标题/eyebrow 按上述字号字重。
- **动效**：`var(--aide-ease-t)`（.16s）过渡 + hover 上浮 1px + `prefers-reduced-motion` 静止；步骤切换走 fadeIn/slide（参考 ModalDialog scaleIn、ChatPanel hero-rise）。

### 4.3 各步内容（已批准高保真稿）

- **欢迎步**：logo-big（56px，radius 14，accentGradient + accentGlow + highlightInset）+ eyebrow "01 / 04" + headline "和 Claude 并肩写代码" + support "aide 是一个桌面工作区——会话、文件树、代码索引都在一个窗口。三步配好，马上能开聊。" + 三 pill（1 选工作区 / 2 登录 Claude / 3 选模型）+ 底部"开始 →"。背景隐约透出 app 的 hero（blur+brightness 衰减），点明"这是覆盖在你将来的工作区上"。
- **工作区步**：folder-pick 卡片（`bg-deep` + border + highlightInset，hover border accent + accentRing）= 文件夹图标 + "选择一个文件夹…" + "或把文件夹拖到这里" + "浏览"。支持 Tauri 对话框 + 拖拽落盘。
- **登录步**：eyebrow "03 / 04 · 登录 Claude" + headline "登录你的 Claude 账号" + support + 主按钮"用 Claude 账号登录 ↗ 浏览器打开"（primary，整宽）+ "或"分隔 + link "改用 API key（去 console.anthropic.com 申请）"。点 link 展开 password 输入（`.text-input` 范式）+ 保存。
- **模型步**：model-pick 卡片（图标 + 当前模型名 + "来自 Anthropic · 默认" + chevron）= ThemedSelect 下拉。下方 hint "模型来自你的供应商。在设置 → 模型里可加更多供应商、换默认模型。" 底部按钮"进入 aide →"。

### 4.4 字形

新字形加进 `src/utils/icons.ts` 的 `GLYPHS`（viewBox 0 0 16 16 SVG path）：`folder`、`key`、`login`（或复用现有 `key`/`provider`）、`model`（或复用 `model`，已有）。缺则补，不引第三方图标库。三角箭头用 SVG chevron，不用字符 ▾/▸（遵循新组件规范）。

## 5. 组件与架构

### 5.1 文件结构

```
src/components/onboarding/
  OnboardingWizard.vue        # 全屏壳：覆盖层 + chrome + 步骤状态机 + 进度轨 + skip-all + 导航
  steps/
    WelcomeStep.vue            # 01
    WorkspaceStep.vue          # 02
    LoginStep.vue               # 03（OAuth + API key 两个子模式）
    ModelStep.vue              # 04
```

宿主 `App.vue` 仅加 `<OnboardingWizard v-if="showOnboarding" />` + onMounted 门控逻辑。符合"内聚新逻辑下沉同名子目录、宿主只留门面"约束。

### 5.2 状态机

`OnboardingWizard` 持有 `step ∈ 'welcome' | 'workspace' | 'login' | 'model' | 'done'`，线性推进 + 上一步/下一步/跳过/跳过整个。每步完成各自落盘：

- workspace → `createWorkspace(path)`（复用 `useWorkspaces`）
- login → OAuth 完成或 API key `SecretMutation{action:"set"}`（复用 ProviderSettings 范式）
- model → `update({ model })`（复用 useSettings）
- done → `update({ onboarded: true })` + 关闭覆盖层

进每步前做"自动跳过"检测（§3 表）。`done` 触发后关闭向导，app 已在背景就绪。

### 5.3 复用清单

| 需求 | 复用 | 备注 |
|---|---|---|
| 主/ghost 按钮 | `AButton`（primary/ghost） | |
| API key 输入 | `.text-input` 范式（ProviderSettings.vue:290-307） | password + SecretMutation |
| 模型下拉 | `ThemedSelect`（block） | |
| 遮罩范式 | `ModalDialog`（fixed inset 0 + bg-overlay + blur + z-index 1200） | Teleport to body，与 ModalDialog 同层不共存 |
| logo | `AppLogo` | 56px hero 配方 |
| 主题应用 | `applyTheme` + `localStorage("aide.theme")` | 切主题即时生效 |
| 设置持久化 | `useSettings().update(partial)` | |
| 凭证检测 | `useProviders`（apiKeyConfigured） | |
| 工作区 | `useWorkspaces` / `createWorkspace` | |
| 字形渲染 | `Icon`（GLYPHS） | |

### 5.4 跨进程改动（唯一）

agent-sidecar `session-worker.ts` 暴露一个**登录控制通道方法**：

- 对已建立的 `query()` 会话，通过 SDK 内部 `request()` 通道发 `{subtype: "claude_authenticate", loginWithClaudeAi: true}`。
- 拿到 `{manualUrl, automaticUrl}` 后，经 Rust command → Tauri shell 插件用系统浏览器打开 `automaticUrl`。
- claude.exe 自己的本地回调服务器接住浏览器跳转、把 token 写进 `~/.aide/claude/.credentials.json`（`CLAUDE_CONFIG_DIR` 已强制指向此目录，见 `runtime/mod.rs:141-142`）。
- sidecar 轮询 `claude_oauth_wait_for_completion` 控制请求，或前端轮询 credentials.json 出现，判定完成。
- Rust 侧新增一个 `#[tauri::command]` 用来：a) 触发登录（调 sidecar）；b) 打开系统浏览器；c) 查询 credentials.json 是否存在。
- runtime 侧不变（已有 CLAUDE_CONFIG_DIR；SystemDefault provider 维持"凭证为空不注入 env"，见 `system_default.rs:34-39`，claude.exe 自动复用存储的 OAuth 凭证）。

## 6. 登录步机理（详）

### 6.1 OAuth 主路径

点"用 Claude 账号登录" →

**前提**：`claude_authenticate` 是通过一个已建立的 `query()` 会话的 `request()` 控制通道发送的。首启动登录时还没有聊天会话，因此 sidecar 需为登录**单独引导一个临时 query 会话**（不发用户消息，仅承载控制请求）。登录完成后该会话可保留供紧随其后的首次聊天复用，或拆除。若引导临时会话在实践中受阻（如 SDK 要求首条 user message 才建会话），降级到 A1 子进程路径（见 §6.4）。

1. sidecar `session-worker` 在临时会话上发 `claude_authenticate {loginWithClaudeAi:true}` 控制请求（经 SDK `query().request()`）。
2. claude.exe 返回 `{manualUrl, automaticUrl}`（authorize URL，PKCE + state 已由 claude.exe 生成）。
3. Rust command → Tauri shell 打开 `automaticUrl` 到系统默认浏览器。
4. 用户在浏览器登录 Claude 账号 → claude.exe 本地回调服务器（`http://127.0.0.1:<随机端口>/callback`，claude.exe 自起）接住 → 写 `~/.aide/claude/.credentials.json`。
5. sidecar 发 `claude_oauth_wait_for_completion` 控制请求等完成（或前端轮询 credentials.json 出现）。
6. 完成 → 关闭浏览器提示 → onboarding 进下一步。SystemDefault provider 不注入 env，claude.exe 自动用这份凭证。

### 6.2 API key 兜底

点"改用 API key" → 展开 password 输入（`<input type="password" autocomplete="new-password" class="text-input">`，照搬 `ProviderSettings.vue:292-297`）+ "保存"。保存走 SystemDefault 的 `SecretMutation {action:"set"}` → 存 keyring（账号 `aide/settings/provider/__system_default__/apiKey`，见 `secrets.rs`）。`apiKeyConfigured` 即刻变 true。

### 6.3 已登录检测

进登录步前：

- 查 `~/.aide/claude/.credentials.json` 文件是否存在（Rust `fs::metadata`，`claude_home()` 已有，`commands/mod.rs:206-208`）。
- 或 SystemDefault `apiKeyConfigured === true`。
- 满足任一 → 该步自动跳过（进度轨显示 done）。
- 可选校验：发 SDK `Query.accountInfo()` 验凭证有效；v1 可只查文件存在，校验留后续。

### 6.4 风险与降级

`claude_authenticate` 是 claude.exe 内部未公开控制请求（SDK 类型未公开，`request()` 公开但 subtype 未在 d.ts 暴露）。SDK 升级可能改/移。

降级策略（两级）：

1. **A1 子进程降级**：若 A2 控制通道不可用（临时会话引导受阻、`claude_authenticate` 不被该版 claude.exe 识别、超时），改 spawn `claude.exe auth login --claudeai` 子进程（带 `CLAUDE_CONFIG_DIR=~/.aide/claude`，Windows 加 `CREATE_NO_WINDOW`），让 claude.exe 自己跑完 OAuth、写 credentials.json；前端轮询文件出现判定完成。子进程无 TTY 时的兼容性需实测，若同样失败 → 进入下一级。
2. **API key only**：A1 也失败 → 登录步只显示 API key 入口 + 一句"浏览器登录暂不可用，请改用 API key"。主按钮文案改为"用 API key 登录"，OAuth 路径隐藏。上下文兜底（§7）同走 API key 路径。

版本探测：sidecar 启动时记录 claude.exe 版本，按版本决定是否启用 A2/A1（可选 v1 后置，首发全量试 A2→A1→API key）。

不采用从零实现 OAuth（Path B）：client_id 是 Anthropic CLI 专用，第三方用违反 ToS 且随时失效；`.credentials.json` 格式逆向脆弱。

### 6.5 迁移补漏（顺带）

`src-tauri/src/commands/migration.rs:86-94` 的 `MIGRATABLE_ENTRIES` 加 `".credentials.json"`（及 `-custom-oauth` 变体），让老 `~/.claude/` 的 OAuth 登录能随迁移提示一并迁入 `~/.aide/claude/`。小改，与本设计顺带做。

## 7. 上下文兜底（跳过的步骤不丢）

因"全可跳过"，跳过后撞缺口时把原始错误换成友好引导，复用 onboarding 单步组件：

### 7.1 无凭证发首条消息

现状：`useChatSession`（`src/composables/useChatSession.ts:986-1003`）把 SDK 401 等 error 当 `error` chat-event 落聊天区，用户看不懂。

改为：发送前检测 `apiKeyConfigured === false 且 credentials.json 不存在` →

- 拦截本次发送（不调 SDK）。
- 在聊天区插入一张系统卡片："还没登录 Claude——发消息需要凭证" + "去登录"按钮。
- "去登录" → 打开 onboarding 到 `login` 步（或直接打开 SettingsPanel → 模型 tab）。
- 有凭证但返回 401/其他错误 → 仍走原始 `error` chat-event（真实错误不吞）。

### 7.2 空工作区

`src/components/FileTree.vue:145-153` 的空态文案"首次使用 / 工作区被删" → 改为带按钮的引导："还没有工作区" + "选一个工作区"按钮（打开 onboarding `workspace` 步 或 标题栏打开目录流程）。

### 7.3 复用

兜底打开的是 onboarding 的**单步组件**（`LoginStep` / `WorkspaceStep` 可独立渲染），不重复造表单。需暴露一个"以指定步打开 onboarding"的入口（如 `useOnboarding().openAt('login')`）。

## 8. 持久化与再入口

### 8.1 标志位

新增 `AppSettings.onboarded: boolean`：

- 前端：`src/types.ts`（AppSettings 接口）+ `src/composables/useSettings.ts`（defaults）。
- 后端：`src-tauri/src/settings/schema.rs`（serde `#[serde(default = "default_onboarded")]`，`default_onboarded() -> bool { false }`）+ `descriptors.rs`（描述符登记）。
- 默认 `false`。
- 落盘走 `~/.aide/settings.json`（`store.rs:34`），不存 state.json。
- 符合"设置默认值分层"记忆——前后端 serde/descriptors 都改，只改前端 defaults 无效。

### 8.2 挂载门控

`App.vue` `onMounted`（`src/App.vue:690-745`）中，**紧跟 `loadSettings()` 之后、`maybePromptJdk` / `maybePromptMigration` 之前**：

```
if (!settings.onboarded) showOnboarding = true
```

这样全新用户先看 onboarding，而不是先被 Java/迁移提示弹。onboarding 完成（done）或"跳过引导" → `update({ onboarded: true })` + 关闭覆盖层，后续条件性提示照常走。老用户（已 settings.json 有 `onboarded: true`）永不弹。

### 8.3 再入口

- SettingsPanel "关于"tab（`SettingsPanel.vue`，9 个 tab 之一）加"重新运行首次引导"按钮 → `update({ onboarded: false })` + `useOnboarding().open()`。
- 上下文兜底按钮（§7）→ `useOnboarding().openAt(step)` 直达指定步。
- 不做自动重弹——只用户主动或撞缺口触发。

## 9. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| `claude_authenticate` 未公开 API 被 SDK 升级改/移 | 中 | 版本探测 + 降级到 API key only（§6.4） |
| OAuth 浏览器登录在 headless/无浏览器环境失败 | 低 | 降级 API key；headless 不是首启动目标场景 |
| `~/.aide/claude/.credentials.json` 格式逆向 | 低 | 不直接读，靠 claude.exe 自管 + 文件存在性检测 |
| 用户系统 env 有 `ANTHROPIC_API_KEY` 透传压过 OAuth 凭证（`env.rs:20-28` fallback） | 低 | onboarding 登录步提示"检测到系统 ANTHROPIC_API_KEY，将优先使用"；或 runtime 侧在 SystemDefault 有存储凭证时不透传（后续优化） |
| 全可跳过导致用户跳过一切仍撞 401 | 中 | 上下文兜底接住（§7.1），不再裸错 |
| 进度轨在窄窗溢出 | 低 | 4 段 + 步骤名，窄窗降级为纯点条（去掉文字） |
| 拖拽文件夹落盘跨平台路径 | 低 | 复用 `createWorkspace` 既有路径处理 |

## 10. 范围外 / 未来

- OAuth 从零实现（自注册 client_id）——若 Anthropic 开放第三方注册再做。
- 凭证有效性强校验（`accountInfo()`）——v1 只查文件存在。
- 迁移已有 `~/.claude/` OAuth 凭证——本设计顺带补 `MIGRATABLE_ENTRIES`，但迁移提示弹窗本身（`maybePromptMigration`）不属本设计改动。
- 引导内多供应商配置——本设计只配 SystemDefault（Anthropic 直连），其他供应商走 Settings → 模型。
- 功能特性 tour——不做。

## 11. 验收要点

- 全新用户（无 settings.json、无 `~/.aide/claude/`、无凭证）首启 → 自动弹 onboarding，走完 4 步能发消息且文件树可用。
- 任意步"跳过" → 不阻塞，进 app 可正常浏览；撞缺口（发消息/文件树）→ 友好引导卡片，不裸错。
- "跳过引导" → 进 app，`onboarded=true`，下次启动不弹。
- 老用户（`onboarded=true`）首启 → 不弹 onboarding。
- 已有 OAuth 凭证（`~/.aide/claude/.credentials.json` 存在）→ 登录步自动跳过。
- OAuth 降级：A2（控制通道）失败 → 试 A1（子进程）；A1 也失败 → 登录步只显 API key，文案提示"浏览器登录暂不可用"。
- SettingsPanel"关于"tab"重新运行首次引导"→ 重弹向导。
- 多主题切换在 onboarding 期间即时生效（applyTheme）。
- `prefers-reduced-motion` → 所有动效静止。