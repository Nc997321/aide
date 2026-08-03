# 散装 Skills/Agents 经 plugins 旁路注入 agent — 设计

- 日期：2026-08-03
- 状态：待实现
- 关联：`docs/reference/SDK 中的 Agent Skills.md`、`docs/reference/agent-sdk-plugins.md`、`docs/superpowers/specs/2026-07-13-marketplace-extension-design.md`
- 关联记忆：`aide-trust-workspace-skills-moot`（受信任工作区 + skills/.mcp.json 门控 moot）

## 1. 背景与问题（实锤）

Aide 用 `settingSources: []`（`agent-sidecar/src/session-worker.ts:864`）隔离 SDK 的文件系统 settings 体系——注释明示「否则 SDK 仍会去读 `.claude/settings*.json`，与 Aide 独立设置体系冲突」。这是**设计意图**，不能动。

副作用：SDK 的文件系统 skill 发现机制被一并断掉。而 SDK 的发现机制只认 `.claude/skills`（`SDK 中的 Agent Skills.md` 第 101-104 行），Aide 的散装 skills/agents 在 **`.aide/claude/`** 命名空间（与 CLI 的 `.claude/` 隔离，见 `skills.rs:67-69`），**SDK 发现机制覆盖不到**。即便开 `settingSources:["user","project"]`，SDK 发现的是 `.claude/skills`，对 Aide 的 `.aide/claude/skills` 无用，还会带入 CLI 的 `.claude/` 污染。

结果：Aide 的散装工件**全部进不了 agent**，且 **UI 展示与实际可用脱节**：

- 用户级 `~/.aide/claude/skills/`（实测 4 个：`business-process-flow-mapper`/`codegraph-explore`/`generate-api-test-suite`/`image-analysis`）— UI 下拉展示（`skills.rs:63-64` 扫描），agent 调不到
- 项目级 `{cwd}/.aide/claude/skills/` — UI 展示（`skills.rs:69-70`），agent 调不到；`skills.rs:67-68` 注释实锤「SDK 隔离模式不自动发现项目 skills，这里仅供 UI 下拉展示」
- 用户级 `~/.aide/claude/agents/`（实测 `unit-test-runner.md`）+ 项目级 agents — 同理进不了 agent
- `skillsDiscovery.ts` 在 `!trusted` 时用 `managedSettings.skillOverrides:{name:"off"}` 隐藏项目 skill（`session-worker.ts:837`）——这是 **moot 防御**，因为根本没注入，隐藏的是不存在的东西

## 2. 文档依据

- `SDK 中的 Agent Skills.md` 第 32 行 Note：「如果显式设置 `settingSources`，请包含 `'user'` 或 `'project'` 以保持 Skill 发现，**或使用 `plugins` 选项从特定路径加载 Skills**」。第一条路对 Aide 无用（命名空间不匹配），**第二条路是唯一通道**。
- `agent-sdk-plugins.md`：plugins 从本地路径加载，示例 `{type:"local", path:"./my-plugin"}` 为**真实目录**（非 symlink）；清单 `.claude-plugin/plugin.json` 可选，省略时按目录布局自动发现组件；plugin 内 skill 自动加 `plugin-name:` 前缀（命名空间）。
- SDK 类型 `SdkPluginConfig = { type:"local"; path:string; skipMcpDiscovery?:boolean }`（`agent-sidecar/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:3879`）——**无 `name` 字段**，plugin name 只能靠清单指定或 SDK 推导。
- `sdk.mjs` 实锤 plugin name 约束：`name: l.string().min(1).refine(e => !e.includes(" "), ...)` + 正则 `^[A-Za-z0-9][-A-Za-z0-9._]*$`，kebab-case、不能空格。
- `.gitignore:43` 实锤 `.aide/` 是 gitignore 本地数据目录——清单写进 `.aide/claude/.claude-plugin/` **不进版本库**。

## 3. 方案（单一，按文档）

**plugins 旁路**：保持 `settingSources:[]` 不动，在现有 `buildPluginsOption()`（marketplace 插件）之外，把用户级与受信任的项目级 `.aide/claude/` 真实目录作为 local plugin 注入，Aide 自动写清单指定唯一 name。

| | plugin path | 清单（Aide 自动写） | 何时注入 |
|---|---|---|---|
| 用户级 | `~/.aide/claude/` | `~/.aide/claude/.claude-plugin/plugin.json` = `{"name":"aide-user"}` | 非轻量模式始终 |
| 项目级 | `{cwd}/.aide/claude/` | `{cwd}/.aide/claude/.claude-plugin/plugin.json` = `{"name":"aide-project"}` | 仅 `trusted` 且非轻量 |

全部带 `skipMcpDiscovery:true`。撞名靠清单（`aide-user` / `aide-project` 前缀不同，单会话仅一个 cwd，项目级固定名不撞用户级）。

**否决的方案**：
- 方案 A（合成容器 + junction/symlink）：文档无此机制，引入跨平台 junction 黑盒风险（SDK 是否接受 symlink 子目录无法靠读码确认）、"失败回退"等加戏复杂度。在确认 `.aide/` gitignore 后，其"避免清单进 git"的唯一价值消失——清单进 `.aide/` 本就不进 git。
- 开 settingSources：发现的是 `.claude/skills`，对 Aide `.aide/claude/skills` 无用且带入 CLI 污染。

## 4. 架构与分层

**硬约束**：新逻辑全部进独立模块，`session-worker.ts`（1146 行，已超阈值）只加一行拼接、不增肥。

```
agent-sidecar/src/
  dispatchPlugins.ts        ← 新增：散装 plugin 清单 ensure + 构建 config（纯函数，叶子模块，预计 <120 行）
  session-worker.ts         ← 改 1 行：plugins 拼接 buildDispatchPluginsOption(...)
  skillsDiscovery.ts        ← 现有 58 行：本设计重新评估去留（见 §7）
```

**分层原则**（CLAUDE.md：组织文件在上、实现在同级清晰、抽象在上实现下）：`dispatchPlugins.ts` 是叶子实现模块，与 `skillsDiscovery.ts`/`instructions.ts` 同级；不往 `session-worker.ts`（主控）里塞实现细节。Rust 侧 `skills.rs`（300 行，UI 扫描）职责单一不变，不掺写清单。

**为什么清单写入放 sidecar（TS）不放 Rust**：写清单是注入的前置步骤、紧耦合；sidecar 已有 `node:fs`/`node:path` 跨平台能力；写一个小 JSON 是轻 IO 不卡。Rust `skills.rs` 保持只读扫描职责。

**`session-worker.ts` 集成点**（`startLoop` 内，现 `session-worker.ts:883`）：
```ts
plugins: this.lightweightMode
  ? []
  : [...buildPluginsOption(), ...buildDispatchPluginsOption(effectiveCwd, trusted)],
```

## 5. 清单自动维护（`dispatchPlugins.ts`）

**`ensureDispatchManifest(pluginRoot: string, name: string): boolean`**
- 目标文件 `{pluginRoot}/.claude-plugin/plugin.json`，内容 `{"name": name}`（最小 schema，name 是 SDK 唯一必需字段）
- 幂等：文件已存在且 `JSON.parse` 后 `name` 匹配 → 跳过写，返回 true
- 文件不存在或 name 不匹配 → `mkdir -p .claude-plugin` + 写文件，写成功返回 true
- 任何 IO 异常（目录只读/权限/磁盘）→ catch 返回 false，**不抛**
- `name` 是 Aide 硬编码常量（`aide-user`/`aide-project`），不读外部输入，无注入风险，且符合 SDK 正则

**`buildDispatchPluginsOption(cwd: string, trusted: boolean, lightweight: boolean): SdkPluginConfig[]`**
- `lightweight` → 返回 `[]`
- 用户级：`pluginRoot` 指向 `~/.aide/claude`。sidecar 经 `process.env.CLAUDE_CONFIG_DIR` 取 claude home（与 `session-worker.ts:851` 的 `loadAideInstructions` 同源，Rust 启动 sidecar 时设该 env）。**实现时确认 `CLAUDE_CONFIG_DIR` 指向 `~/.aide` 还是 `~/.aide/claude`，据此决定是否再 `path.join(..., "claude")`**（Rust 侧 `skills.rs:63` 的 `claude_home().join("skills")` 是等价参照，`claude_home()` 返回 `~/.aide/claude`）。若 `existsSync(pluginRoot)` 且 `ensureDispatchManifest(pluginRoot, "aide-user")` → push `{type:"local", path: pluginRoot, skipMcpDiscovery:true}`
- 项目级：仅 `trusted` 时；`pluginRoot = path.join(cwd, ".aide", "claude")`；同样 existsSync + ensureManifest("aide-project") → push
- 目录不存在 / ensure 失败 → 跳过该条（降级，不阻塞）

**`~/.aide/claude/plugins/` 这个 CLI 缓存子目录**：它在用户级 plugin 根下。SDK 扫 plugin 根只认固定组件名 `skills/`/`agents/`/`hooks/`/`commands/`/`.claude-plugin/`/`.mcp.json`（`agent-sdk-plugins.md:271-285`），`plugins/` 不在列，SDK 应忽略。已评估为低风险，实现时通过 init 消息的 `plugins`/`skills`/`slash_commands` 字段确认无意外组件混入（验收项）。

## 6. 注入与门控

- `buildDispatchPluginsOption(cwd, trusted, lightweight)` 是唯一入口，门控集中在它内部
- **trust 门控**：项目级仅在 `trusted` 时注入，与现有 `projectSkillOverrides = trusted ? {} : buildProjectSkillOverrides(...)`（`session-worker.ts:837`）、`loadAideInstructions(..., trusted)`、codegraphMcp 的 trust 门控一致。`trusted` 来自前端 `cmd.trusted`（`session-worker.ts:756`），已全程流转
- **轻量模式**：`lightweightMode` 时返回 `[]`，与现有 `skills:[]`/`plugins:[]`（`session-worker.ts:882-883`）一致——btw 是纯问答，散装 skills/agents/MCP 全关
- **`skipMcpDiscovery:true`**：plugin 只贡献 skills/agents/hooks/commands，不贡献 MCP（sdk.d.ts:3888-3891）。隔离 plugin 根下可能存在的 `.mcp.json`，与 Aide 现有 `.mcp.json` 门控（`strictMcpConfig`，`session-worker.ts:867`）不冲突——散装 plugin 永不注入 MCP，MCP 只走 Aide 自己的 strictMcpConfig 通道
- **拼接顺序**：`[...buildPluginsOption(), ...buildDispatchPluginsOption(...)]`——marketplace 插件在前（用户主动装的），散装在后

## 7. 与现有机制的清理

**`skillsDiscovery.ts` / `buildProjectSkillOverrides` / `managedSettings.skillOverrides` 的去留**：
- 现状是 moot（`settingSources:[]` 没注入项目 skill，隐藏不存在的东西）
- 本设计后：`trusted` 时项目级真注入（不需隐藏）；`!trusted` 时项目级不注入（没 skill 不需隐藏）。两种情况都不再需要 `skillOverrides` 隐藏
- **结论**：`buildProjectSkillOverrides` 调用与 `managedSettings.skillOverrides` 注入可移除，`skillsDiscovery.ts` 可废弃
- **实现时确认点**：`managedSettings` 是否仅用于 `skillOverrides`。若是则连同 `managedSettings` 选项移除；若另有用途则保留 `managedSettings` 仅删 `skillOverrides` 部分。先 grep `managedSettings` 在 `session-worker.ts` 全部用法确认

**UI 展示对齐**（`skills.rs`）：现状扫三源（user/project/plugin）给 UI 下拉。本设计后 agent 真正可用 user/project 散装 skill，**补齐展示-可用脱节**。
- 初版：UI source 标识保持 `user`/`project`/`plugin:xxx`（对用户友好），不改 `skills.rs`
- 后续优化（不在本 scope）：skill 详情展示实际调用名前缀 `aide-user:xxx`/`aide-project:xxx`

**agents 工具权限**：plugin agent（如 `unit-test-runner`，frontmatter `tools: Bash,Read,Write,Grep,Glob`）注入后，model 经 Agent 工具调用它。子 agent 的工具调用仍走 Aide 权威前置层：
- `PreToolUse` hook `matcher:".*"` 的 `policyHook`（`session-worker.ts:885-887`）最先评估，`allowDangerouslySkipPermissions` 也不绕过
- `canUseTool` 回调（`session-worker.ts:863`）拦截非 allowedTools
- SDK 的 agent frontmatter `tools` 字段限制子 agent 工具集（`sdk.d.ts` 注明 SDK 不支持 SKILL.md 的 allowed-tools，但 agent frontmatter tools 仍约束子 agent）
- **实现时验证点**：plugin agent 的子工具调用确实过 Aide `canUseTool`/policy（应过，因所有工具调用都过 canUseTool）。若发现 plugin agent 工具调用绕过 Aide policy，则该路径是安全漏洞，需在 canUseTool 内额外覆盖子 agent 工具调用

## 8. 安全（重点）

用户强调安全最重要。本设计的安全面与防护：

1. **plugin path 不接受外部输入**：`buildDispatchPluginsOption` 的 path 是 Aide 用 `path.join` 构造的 `.aide/claude` 绝对路径（claudeHome/cwd 拼接），不读用户配置、不读网络，无路径注入
2. **清单 name 是硬编码常量**：`aide-user`/`aide-project` 由 Aide 写死，不读外部输入；符合 SDK 正则 `^[A-Za-z0-9][-A-Za-z0-9._]*$`，无命名空间注入。即便用户手改 `.aide/claude/.claude-plugin/plugin.json` 的 name，也只影响自己工作区会话，无跨用户/跨工作区风险
3. **`skipMcpDiscovery:true` 隔离 MCP**：散装 plugin 永不贡献 MCP server。`.mcp.json` 仍只走 Aide `strictMcpConfig` 门控（`!trusted` 时 `strictMcpConfig:true` 忽略项目 `.mcp.json`）。两条 MCP 通道互不串扰，杜绝 plugin 夹带 MCP server 绕过 Aide mcp 审批
4. **trust 门控防项目级越权**：`!trusted` 工作区的项目 skills/agents 不注入——不信任工作区的散装 agent（可能含危险工具调用）不进 agent，与受信任工作区机制（commit `ddf3168`）一致
5. **agents 工具走 Aide policy**：见 §7，plugin agent 的工具调用经 Aide policy hook + canUseTool 前置拦截，Aide 权限策略是权威层，plugin agent 无法绕过
6. **`.aide/` 可写性**：`trusted` 时 `.aide/` 可写（Aide 已写 settings.json/skills/agents）。写清单失败降级跳过该 plugin，不阻塞会话、不部分写入残留
7. **`~/.aide/claude/plugins/` CLI 缓存子目录**：见 §5，SDK 忽略非固定组件名目录，低风险，实现时 init 消息验收
8. **不破坏现有隔离**：`settingSources:[]` 保留，SDK 仍不读 `.claude/settings*.json`，Aide 独立设置体系不受影响
9. **plugin hooks 面**：把 `.aide/claude/` 当 plugin 根注入，SDK 除 skills/agents 外还可能从 `hooks/` 子目录加载 plugin hooks（在 sidecar Node 进程内执行的任意代码）。`skipMcpDiscovery:true` 只隔离 MCP，不隔离 hooks。当前 `.aide/claude/` 无 `hooks/` 目录（低实际风险）；trust 门控（`!trusted` 不注入项目级）缓解项目向量，用户级为 self-owned（用户本机已有本地代码执行权）。未来增强：trust 时若 `{cwd}/.aide/claude/hooks/` 存在则前端提示

## 9. 错误处理与降级

**永不阻塞会话**（与 `skillsDiscovery.ts:8`「调用方 startLoop 不能被 skill 扫描阻塞」同原则）：
- 目录不存在 → 跳过该 plugin（用户没建 skills/agents 目录是正常状态）
- 清单写失败（只读/权限/磁盘）→ catch 返回 false，跳过该 plugin，会话正常起，只是缺散装 skills
- 清单已存在但内容损坏（用户手改坏 JSON）→ `JSON.parse` 失败，重写为正确内容（Aide 是 `.aide/` 的权威管理者），不抛
- SDK 未发现某 skill（SKILL.md frontmatter 不合法等）→ SDK 自身处理，Aide 不介入

降级结果：散装 plugin 全部失败时，会话退化为现状（只有内置 + marketplace 插件 skill），与改动前等价，零回归。

## 10. 跨平台

方案 B **无 symlink**，跨平台只剩路径处理：
- `dispatchPlugins.ts` 用 `node:path.join`/`path.resolve`，不硬编码分隔符
- plugin path 传绝对路径；Windows 绝对路径（如 `C:\Users\...\.aide\claude`）SDK 已在 `buildPluginsOption` 现有 marketplace 插件路径中正常接受（`enabled-plugins.json` 实测含 `C:\\Users\\yangx\\.aide\\claude-agent-sdk\\plugins\\...`）
- `mkdir -p` 用 `fs.mkdirSync(dir, {recursive:true})`，跨平台
- 无新跨平台风险，符合 CLAUDE.md 跨平台红线

## 11. 测试策略

`dispatchPlugins.ts` 单测（与 `skillsDiscovery.test.ts` 同风格，纯函数 + 临时目录）：
- `ensureDispatchManifest`：首次写、幂等不重写、内容不匹配时重写、损坏 JSON 重写、只读目录降级返回 false、name 合法性（Aide 硬编码无需测用户输入）
- `buildDispatchPluginsOption`：lightweight 返回 `[]`、`!trusted` 不含项目级、`trusted` 含项目级、目录不存在跳过、ensure 失败跳过、返回项带 `skipMcpDiscovery:true`、path 是绝对路径
- 跨平台路径：临时目录用 `os.tmpdir()`，不硬编码分隔符

集成（sidecar 启动后）：init 消息 `skills` 列表含 `aide-user:<用户级 skill>` 和 `aide-project:<项目级 skill>`（trusted 时）；`plugins` 列表含两个 dispatch plugin；`!trusted` 时不含 `aide-project:*`；lightweight 时全无。验收时手动跑一次确认（非自动测试，因依赖 SDK native 行为）。

回归：不破坏现有 `buildPluginsOption`（marketplace 插件仍注入）、`skillsDiscovery.test.ts`（若废弃则删其测试）。

## 12. 验收清单

- [ ] 用户级 `~/.aide/claude/skills/` 的 skill 以 `aide-user:` 前缀进 agent（init 消息确认）
- [ ] 项目级 `{cwd}/.aide/claude/skills/` 的 skill 以 `aide-project:` 前缀进 agent（仅 trusted）
- [ ] `~/.aide/claude/agents/` 与 `{cwd}/.aide/claude/agents/` 的 agent 进 agent（同样前缀规则）
- [ ] `!trusted` 时项目级散装不注入
- [ ] `lightweightMode` 时散装全不注入
- [ ] `skipMcpDiscovery:true` 生效：散装 plugin 不贡献 MCP（init 消息 MCP server 列表无变化）
- [ ] `~/.aide/claude/plugins/` CLI 缓存子目录不混入任何组件（init 消息验收）
- [ ] `.claude-plugin/plugin.json` 幂等写、内容 `{"name":"aide-user"}`/`{"name":"aide-project"}`、位于 `.aide/claude/` 下（gitignore，不进版本库）
- [ ] 清单写失败/目录不存在 → 降级跳过，会话正常起，零回归
- [ ] plugin agent 的工具调用过 Aide policy/canUseTool（手动构造危险工具调用 agent 验证被拦截）
- [ ] `session-worker.ts` 仅改 1 行（plugins 拼接），不增肥；`dispatchPlugins.ts` <120 行独立模块
- [ ] `buildProjectSkillOverrides`/`managedSettings.skillOverrides` 按确认结果移除，`skillsDiscovery.ts` 废弃
- [ ] `settingSources:[]` 保持不变，现有 marketplace 插件注入不受影响

## 13. 遗留与后续（不在本 scope）

- **`session-worker.ts` 1146 行超阈值**：本设计只加 1 行不增肥，但该文件本身需后续单独拆分（建议按职责拆 startLoop/options 构造/工具回调/输出处理等）。不在本设计 scope，避免 scope 蔓延
- UI source 前缀展示优化（§7）
- 若未来 Aide 接入其他 agent provider（codex/opencode，`skills.rs:15` 预留），`dispatchPlugins` 的 plugin name 命名空间需扩展（`aide-user` 是 Claude 专属，与 `claude-agent-sdk` 命名空间收拢原则一致）