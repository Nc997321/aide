# 扩展（Extensions）管理重做设计

- 日期：2026-08-10
- 范围：设置面板「扩展」tab 重做——前端编辑器补全 + sidecar 打通死配置 + 运维反馈
- 不涉及：市场 tab 结构、项目级 `.mcp.json` 编辑、Hook 探活、热更新

## 背景与现状诊断

设置面板「扩展」tab（`SettingsPanel.vue` L577-621 内联实现）名义上管理 5 类——智能体 / 技能 / 指令 / 钩构（Hook）/ MCP 服务器，共用 `CustomizationList` + `CustomizationDetail` 两个组件。实际存在三个致命问题：

### 问题 1：详情编辑只有 name + description，类型专属字段全部缺失

`CustomizationDetail.vue` 留了一个 slot 给类型专属字段，但 `SettingsPanel` 使用它时**没有传任何 slot 内容**。于是：

- MCP 服务器的 `command / args / env` 不可见、不可编辑
- Hook 的 `event / matcher / command / timeout / asyncRewake` 不可见、不可编辑
- Skill 的 `scripts` 不可见、不可编辑
- Agent 的 `model / tools` 不可见、不可编辑

创建流程只弹窗问一个名字（`CustomizationList.vue` L23-28），产出的 MCP / Hook 是空配置废条目。

### 问题 2：写出的 MCP / Hook 配置根本没生效（死配置）

`customizations.rs` 把 MCP / Hook 写进 `~/.aide/claude/settings.json` 的 `mcpServers` / `hooks` 键。但 sidecar 启动 SDK 时用 `settingSources: []`（`session-worker.ts` L934），**SDK 完全不读这个文件**。`mcpServers` 只注入内置 codegraph（in-process server），`hooks` 全是 sidecar 代码内建。

结果：用户在 UI 里"管理"了 MCP / Hook，实际只有内置 codegraph 和受信任项目 `.mcp.json` 在跑；Hook 则全是代码内建。只有 Skill 因为和 `skills.rs` 扫描器共享同一目录（`~/.aide/claude/skills/`），间接生效。

### 问题 3：「扩展」与「市场」概念割裂 + 死代码

市场 tab 装的 git 插件（superpowers 等）本身就是 skill / hook / mcp / agent 的打包分发单元，装完后用户在「扩展」tab 看不到插件自带的组件，两套系统互不通。另：`src/components/customizations/CustomizationPanel.vue`（223 行，弹窗版）在 `src` 下零引用，是死代码。

### 附带发现：Skill scripts 后端基础已就绪

`list_skills` / `get_skill` 已经在 `metadata.scripts` 返回脚本文件清单（customizations.rs:256-268, 298-310），`create_skill` 建目录时就 `create_dir_all(scripts_dir)`（L335-336）。前端只是没展示、没编辑。原始设计本意就要支持 scripts，本期补齐前端 + 读写命令。

## 目标

让「扩展」tab 真正能管好 MCP / Skill / Hook / Agent / 指令：能看见全部来源（用户 / 项目 / 插件）、能编辑类型专属字段、配置改完真正接入 sidecar 生效、MCP 有连接状态反馈、有测试连接验证配置正确性。

## 架构总览

三个问题分三层解：

| 层 | 问题 | 解法 |
|---|---|---|
| 前端编辑器 | 缺类型字段 | `customizations/` 重构为「门面 + editors/ 子目录」 |
| 后端打通 | 死配置 | sidecar 新增 `userExtensions.ts`，显式读 settings.json 注入 query options |
| 概念统一 | tab 割裂 | 扩展 tab 只读展示插件来源组件 + 来源 badge 横切维度 |

数据流：

```
前端 editor → useCustomizations → api/customization.ts → Rust customizations.rs
   → 写 ~/.aide/claude/settings.json 的 mcpServers / hooks 键
   → 写 ~/.aide/claude/skills/<name>/（SKILL.md + scripts/）
   → 写 ~/.aide/claude/agents/*.md、CLAUDE.md

sidecar 启动 query 前：
   → userExtensions.ts 读 settings.json（CLAUDE_CONFIG_DIR 指向）
   → 过滤 disabled → merge 进 options.mcpServers / options.hooks
   → SDK spawn stdio/sse/http MCP / 跑 hooks（新会话生效）
   → builtinHooks 注册表输出本次实际挂载的内建 hook 清单 → 前端 hook 列表只读展示

探活：
   前端 [测试连接] → Tauri test_mcp_connection(config) → Rust spawn agent-runtime test-mcp.ts
   → MCP Client 握手（按 transport 类型）→ 结果回前端 → 状态灯
```

## 前端组件设计

### 目录结构

```
src/components/customizations/
├── CustomizationList.vue        保留（通用列表：名称+描述+toggle+来源 badge）
├── CustomizationDetail.vue       退化为门面：switch(type) → 渲染对应 editor
└── editors/                      新建子目录，5 个专属 editor
    ├── McpServerEditor.vue      表单：传输类型 / command·args·env 或 url·headers / 状态灯 / 测试连接
    ├── HookEditor.vue           表单：event / matcher / command / timeout / asyncRewake
    ├── SkillEditor.vue          frontmatter 字段 + 正文 CodeMirror + 预览 + scripts 子面板
    ├── AgentEditor.vue           frontmatter 字段 + 正文 CodeMirror + 预览
    └── InstructionEditor.vue     全文 CodeMirror + 预览（全局/项目切换）
```

死代码 `CustomizationPanel.vue`（223 行，零引用）删除。

### 各 editor 字段

Skill / Agent 的 frontmatter 字段表单依赖前端 frontmatter 解析/写回能力。复用 Rust 侧 `extract_frontmatter_field` / `update_frontmatter_field`（customizations.rs）的简易正则思路，前端同款逻辑，不引入新依赖。

**McpServerEditor**（结构化表单）
- `name`（唯一 key）
- 传输类型选择：`stdio` / `sse` / `http`
- `stdio`：`command` / `args[]`（每行一个，避免引号转义）/ `env`（key-value 可增删）
- `sse`：`url`
- `http`：`url` / `headers`（key-value 可增删）
- 状态灯（未测试灰 / 测试中转圈 / 成功绿附工具数 / 失败红 hover 看错误）
- 测试连接按钮、保存、删除

**HookEditor**（结构化表单）
- `name`
- `event` 下拉：PreToolUse / PostToolUse / Notification / Stop
- `matcher`（正则，提示 `^Read$` / `.*`）
- `command`（shell 命令）
- `timeout?`（数字，可选）
- `asyncRewake?`（开关，可选）
- 保存、删除（不做测试连接——见运维反馈章节）

**SkillEditor**（Markdown 文件）
- frontmatter 字段表单：`name` / `description`
- 正文 CodeMirror 编辑 + 预览切换（复用项目已有 CodeMirror + `marked`）
- scripts 子面板：文件清单（吃 `metadata.scripts`）+ 选中用 CodeMirror 编辑 + 新建/删除
- 来源 badge：`user` / `project` / `plugin:xxx`；`plugin:xxx` 只读不可编辑（编辑请去市场 tab 卸载/换插件）

**AgentEditor**（Markdown 文件）
- frontmatter 字段表单：`name` / `description` / `model?` / `tools[]?`（可增删）
- 正文 CodeMirror 编辑 + 预览切换
- 来源 badge 同 Skill

**InstructionEditor**（Markdown 文件）
- 全文 CodeMirror 编辑 + 预览切换
- 全局 / 项目指令切换（复用 `get/save_global|project_instructions`）

### CustomizationDetail 退化

从「name + description 输入框 + 空槽」退化为按 `type` 分派到对应 editor 的门面：`switch(type)` → 渲染组件 + 透传 `item` / 来源 + 监听 `save / delete / back`。`name` 不再由 Detail 统一管——不同类型 name 语义不同（MCP 的 name 是 settings.json 的 key，Skill 的 name 是 frontmatter 字段），下沉到各 editor 内部更准。

### 来源 badge 横切维度

所有类型的列表项带来源 badge：`用户` / `项目` / `插件:xxx` / `内置`（仅 Hook 有内置）。Skill / Agent 的插件来源条目只读；Hook 的内置条目只读。同一套 badge 机制贯穿所有列表。

## sidecar 打通

新增模块 `agent-sidecar/src/userExtensions.ts`，导出两个纯函数：`loadUserMcpServers()` 和 `loadUserHooks()`。`session-worker.ts` 在组装 `options` 前调用一次，结果 merge 进 `options.mcpServers` / `options.hooks`。

### 读什么、用什么路径

读 `CLAUDE_CONFIG_DIR` env 指向的 `settings.json` 的 `mcpServers` 和 `hooks` 两键。**必须用 `CLAUDE_CONFIG_DIR` env 而不是硬编码 `~/.aide/claude`**——单一来源，和 Rust `claude_home()` 读写的是同一个文件。文件不存在 / 解析失败 → 返回空对象、记日志、不阻断会话。

### mcpServers 注入

```
mcpServers: {
  ...(codegraphMcp ?? {}),        // 内置 in-process server（SdkMcpServer 实例）
  ...filterDisabled(userServers), // 用户 server（stdio/sse/http），过滤 disabled:true
}
```

内置 codegraph 是 `SdkMcpServer`（in-process），用户的是 stdio / sse / http 描述——SDK 的 `mcpServers` 字段按 name 混存这几种，name 不冲突即可。`disabled` 过滤由 sidecar 做（SDK 不认 `disabled` 键），保证 SDK 看到的是干净配置。用户 config 原样透传（含 `type` / `url` / `headers` 等），SDK 按格式识别传输类型。

### hooks 注入（铁律：内建在前）

```
hooks: {
  PreToolUse: [
    { matcher: ".*", hooks: [policyHook] },          // 内建权限策略必须最先，不可被用户 hook 越过
    ...userHooks.PreToolUse.filter(未 disabled),      // 用户 hook 排在内建之后
  ],
  Stop: [
    { hooks: [makeStopEffortHook()] },
    ...userHooks.Stop.filter(未 disabled),
  ],
  ...其他事件（PostToolUse / Notification）原样补上用户 hook,
}
```

铁律：**内建 hook 永远在前，用户 hook 追加在后**。`policyHook` 是权限策略权威层，`allowDangerouslySkipPermissions` 都不绕过它，用户配置的 hook 绝不能跑到权限策略前面。用户 hook 的 `type: "command"` 由 SDK spawn 执行，和内建 JS hook 共存。

### 内建 hook 注册表（顺带重构）

现在内建 hook 散在 `session-worker.ts:954-974` 硬编码。抽成 `agent-sidecar/src/builtinHooks/` 注册表模块：每个内建 hook 的**实现 + 元数据**（`name` / `event` / `matcher` / `purpose`）集中一处。`session-worker` 组装 hooks 时从注册表取，前端展示也从这里输出的清单取——实现和描述同源，不会出现 UI 写了"图片守卫"但代码改了用途对不上的情况。

`session-worker` 组装 hooks 时，把「本次实际挂载的内建 hook 清单」一并回传前端（动态反映：`codegraphGrepNudgeHook` 只在 codegraph 开时挂、`subagentModelHook` / `skillGuardHook` 在特定条件下挂，不是静态硬编码）。前端 hook 列表合并显示：内置 hook 只读在前（带 `内置` badge，不可编辑/删除/toggle），用户 hook 可编辑在后。

### 生效时机

`query()` 在会话启动时调用一次、options 组装一次。**改完 MCP / Hook 要下次新会话才生效**，当前会话中途改不会热加载。UI 明确标注「下次新会话生效」，由测试连接按钮给即时反馈补延迟感。

### 错误隔离

单条 mcpServer / hook 配置缺字段或格式错 → 跳过该条 + 记日志，不影响其他条目和会话启动。

## 运维反馈

### 状态灯：以测试连接结果为准，不依赖 SDK 运行时事件

MCP 列表每行一个状态灯：未测试（灰）/ 测试中（转圈）/ 成功（绿，附工具数）/ 失败（红，hover 看错误）。状态由用户点「测试连接」主动探活得到，**不靠监听 SDK 运行时的 MCP 连接事件**——SDK 是否暴露细粒度连接事件不确定，硬依赖会踩「拿不到状态」的坑。主动探活可靠、即时、不受会话开没开影响。会话运行中若恰好能拿到 SDK 的 MCP 错误，被动更新状态灯（可选增强，本期不强上）。

### MCP 探活：一次性进程，只读握手，无副作用

```
前端 [测试连接] → Tauri test_mcp_connection(config)
→ Rust spawn agent-runtime 跑 test-mcp.ts 入口（CREATE_NO_WINDOW + dunce 路径）
→ sidecar test-mcp.ts: @modelcontextprotocol/sdk Client + 按传输类型选 transport
   → stdio: StdioClientTransport（spawn command）
   → sse:  SSEClientTransport（连 url）
   → http: StreamableHTTPClientTransport（请求 url + headers）
   → initialize 握手 → tools/list → 拿工具清单 → 关进程 → 输出 JSON 退出
→ Rust 收 stdout 返回前端 → 更新状态灯
```

探活是**只读握手**（initialize + tools/list），不调任何工具，无副作用——这是能做「测试」的前提。超时 10s → `timeout`；spawn 失败（command 不存在）→ `spawn_error`；协议错 → `handshake_error`；连接失败 → `connect_error`。复用 SDK 的 MCP Client 而不是 Rust 手写 JSON-RPC，避免和 SDK 协议版本对不上的诡异问题。

### Hook 不做探活

Hook command 是 shell 命令，测它要模拟 SDK 调用契约（spawn + 传 JSON 到 stdin + 读 stdout + 超时），且**有副作用风险**：若 `PostToolUse` 挂的是 git commit 类 hook，"测试"就真执行了一次。MCP 探活无副作用（只读握手），所以能测；Hook 探活有副作用，所以不测。Hook 的反馈由列表本身满足——内置 hook 只读清单 + 用户 hook，能看见「实际挂了几个、谁干的」。

### 改完配置的生效提示

MCP / Hook 编辑保存后，列表顶部一条提示：「已保存，下次新会话生效。」配 sidecar「新会话生效」语义。测试连接是即时验证配置正确性的口子，绕开「要开会话才知道」的延迟。

## 后端 Rust 改动

### customizations.rs 改造

- `create_mcp_server` / `update_mcp_server`：从硬编码 `command/args/env` 三字段改为**整体透传 config 对象**（保留 `disabled` 处理），支持 stdio / sse / http 三种格式。
- 新增三个 async command（文件 IO，`trace_command` + `PathBuf` 拼接，限文件名防 `../` 越界）：
  - `read_skill_script(skill_id, filename) -> String`
  - `write_skill_script(skill_id, filename, content) -> ()`
  - `delete_skill_script(skill_id, filename) -> ()`
- 新增 `test_mcp_connection(config) -> TestResult`：async，spawn `agent-runtime` 跑 `test-mcp.ts`，收集 stdout JSON 返回。`#[cfg(windows)]` 加 `CREATE_NO_WINDOW (0x08000000)`；传给子进程的路径用 `dunce::simplified()` 剥 `\\?\` 前缀。

### 不动

- `customizations.rs` 的 skill / agent / instruction / hook 读写逻辑（结构已对，前端补字段即可）
- `settingSources: []`（维持隔离，不放开）
- settings.json 路径（继续 `~/.aide/claude/settings.json`）

## 测试覆盖

- 每个 editor 渲染测试：props 传 item → 断言字段渲染 + 来源 badge（user 可编辑 / plugin 只读）
- 表单交互测试：输入 → save emit 正确 payload
- `McpServerEditor` 传输类型切换测试：stdio / sse / http 切换后字段正确显示
- `McpServerEditor` 测试连接交互：mock `testMcpConnection` → 断言状态灯 灰→转圈→绿/红
- `SkillEditor` scripts 子面板：mock `read/write/delete_skill_script` → 文件清单 + 编辑 + 新建删除
- `useCustomizations` CRUD 行为测试：现状只 mock 断言导航项，补全
- sidecar `userExtensions.ts` 单测：过滤 disabled、单条出错不阻断整体、路径来自 `CLAUDE_CONFIG_DIR`
- `builtinHooks` 注册表单测：元数据完整、组装顺序 `policyHook` 第一
- `test-mcp.ts` 探活用 mock transport（不真 spawn），三种 transport 分支覆盖
- 注意项目记忆 `jsdom-vshow-isvisible-unreliable`：测折叠/切换别用 `isVisible()`，读 `style.display` + 文本

## 范围边界

### 做

- 前端 5 个专属 editor（类型字段补全）
- sidecar `userExtensions.ts` 注入 mcpServers / hooks
- 内建 hook 注册表 + 前端只读展示
- MCP 状态灯 + 测试连接探活（stdio / sse / http 三种 transport）
- Skill scripts 子面板 + 三个 Rust command
- 来源 badge 横切维度
- 删 `CustomizationPanel.vue` 死代码
- 补测试

### 不做

- 不合并市场 tab（只读展示插件来源组件已满足「看全」）
- 不做项目级 `.mcp.json` 编辑（先全局，项目级后续）
- 不做 Hook 探活（副作用风险）
- 不做 Hook / MCP 热更新（新会话生效，文档化）
- 不做内建 hook 可配置化（只读展示）
- 不放开 `settingSources`（维持隔离）

## 关键文件清单

| 关注点 | 路径 |
|---|---|
| 扩展 tab 宿主 | `src/components/SettingsPanel.vue`（L577-621） |
| 前端门面 + editors | `src/components/customizations/`（重构） |
| 前端状态/CRUD | `src/composables/useCustomizations.ts` |
| 前端 API | `src/api/customization.ts` |
| 前端类型 | `src/types/customization.ts`、`src/types/skill.ts` |
| Rust customizations | `src-tauri/src/commands/customizations.rs` |
| Rust 注册 | `src-tauri/src/lib.rs`（L319-328） |
| sidecar query 组装 | `agent-sidecar/src/session-worker.ts`（L928-998） |
| 新：sidecar 注入模块 | `agent-sidecar/src/userExtensions.ts` |
| 新：内建 hook 注册表 | `agent-sidecar/src/builtinHooks/` |
| 新：探活入口 | `agent-sidecar/src/test-mcp.ts`（仿 `smoke-mcp.ts`） |
| 内置 MCP 参考 | `agent-sidecar/src/codegraphTools.ts`（L178-228） |
| 散装 plugin 注入 | `agent-sidecar/src/dispatchPlugins.ts` |
| Skill 扫描器 | `src-tauri/src/skills.rs` |
| Marketplace 模块 | `src-tauri/src/commands/marketplace/` |

## 实施顺序建议

1. 先打通 sidecar（`userExtensions.ts` + `builtinHooks` 注册表 + `session-worker` 接线）——后端先生效，前端再接
2. 探活链路（`test-mcp.ts` + `test_mcp_connection` command）
3. 前端 editor 重构（`CustomizationDetail` 退化 + 5 个 editor + 来源 badge + 删死代码）
4. Skill scripts 子面板 + 三个 Rust command
5. MCP SSE/HTTP 传输类型支持（前端切换 + Rust 透传改造 + 探活分支）
6. 测试补全

每步可独立验证，不一次性大爆炸。