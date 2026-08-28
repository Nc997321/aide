> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Plugins 参考

> Claude Code 插件系统的完整技术参考，包括架构、CLI 命令和组件规范。

<Tip>
  想要安装插件？请参阅[发现和安装插件](/docs/zh-CN/discover-plugins)。如需创建插件，请参阅[Plugins](/docs/zh-CN/plugins)。如需分发插件，请参阅[Plugin marketplaces](/docs/zh-CN/plugin-marketplaces)。
</Tip>

本参考提供了 Claude Code 插件系统的完整技术规范，包括组件架构、CLI 命令和开发工具。

**plugin** 是一个自包含的组件目录，用于扩展 Claude Code 的自定义功能。插件组件包括 skills、agents、hooks、MCP servers、LSP servers 和 monitors。

<h2 id="plugin-components-reference">
  Plugin 组件参考
</h2>

<h3 id="skills">
  Skills
</h3>

Plugins 向 Claude Code 添加 skills，创建可由您或 Claude 调用的 `/name` 快捷方式。

**位置**：插件根目录中的 `skills/` 或 `commands/` 目录，或插件根目录中的单个 `SKILL.md` 文件

**文件格式**：Skills 是包含 `SKILL.md` 的目录；commands 是简单的 markdown 文件

**Skill 结构**：

```text theme={null}
skills/
├── pdf-processor/
│   ├── SKILL.md
│   ├── reference.md (可选)
│   └── scripts/ (可选)
└── code-reviewer/
    └── SKILL.md
```

**集成行为**：

* 安装插件时会自动发现 Skills 和 commands
* Claude 可以根据任务上下文自动调用它们
* Skills 可以在 SKILL.md 旁边包含支持文件

如果插件没有 `skills/` 目录且没有 `skills` manifest 字段，则插件根目录中的 `SKILL.md` 会作为单个 skill 加载。设置 frontmatter `name` 字段以控制 skill 的调用名称。如果没有设置，Claude Code 会回退到安装目录名称，对于从市场安装的插件，这是一个在每次更新时都会改变的版本字符串。对于提供多个 skill 的插件，请使用上面所示的 `skills/` 目录布局。

有关完整详情，请参阅 [Skills](/docs/zh-CN/skills)。

<h3 id="agents">
  Agents
</h3>

Plugins 可以为特定任务提供专门的 subagents，Claude 可以在适当时自动调用。

**位置**：插件根目录中的 `agents/` 目录

**文件格式**：描述 agent 功能的 Markdown 文件

**Agent 结构**：

```markdown theme={null}
---
name: agent-name
description: 该 agent 的专长以及 Claude 应何时调用它
model: sonnet
effort: medium
maxTurns: 20
disallowedTools: Write, Edit
---

详细的系统提示，描述 agent 的角色、专业知识和行为。
```

Plugin agents 支持 `name`、`description`、`model`、`effort`、`maxTurns`、`tools`、`disallowedTools`、`skills`、`memory`、`background` 和 `isolation` frontmatter 字段。唯一有效的 `isolation` 值是 `"worktree"`。出于安全原因，plugin 提供的 agents 不支持 `hooks`、`mcpServers` 和 `permissionMode`。

**集成点**：

* Agents 在 [@-mention 类型提前](/docs/zh-CN/sub-agents#invoke-subagents-explicitly) 中显示，使用其作用域名称，例如 `my-plugin:code-reviewer`，一旦启用插件
* Claude 可以根据任务上下文自动调用 agents
* Agents 可以由用户手动调用
* Plugin agents 与内置 Claude agents 一起工作

有关完整详情，请参阅 [Subagents](/docs/zh-CN/sub-agents)。

<h3 id="hooks">
  Hooks
</h3>

Plugins 可以提供事件处理程序，自动响应 Claude Code 事件。

**位置**：插件根目录中的 `hooks/hooks.json`，或在 plugin.json 中内联

**格式**：具有事件匹配器和操作的 JSON 配置

**Hook 配置**：

```json theme={null}
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/format-code.sh"
          }
        ]
      }
    ]
  }
}
```

Plugin hooks 响应与 [用户定义的 hooks](/docs/zh-CN/hooks) 相同的生命周期事件：

| Event                 | When it fires                                                                                                                                                                                                                                         |
| :-------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`        | When a session begins or resumes                                                                                                                                                                                                                      |
| `Setup`               | When you start Claude Code with `--init-only`, or with `--init` or `--maintenance` in `-p` mode. For one-time preparation in CI or scripts                                                                                                            |
| `UserPromptSubmit`    | When you submit a prompt, before Claude processes it                                                                                                                                                                                                  |
| `UserPromptExpansion` | When a user-typed command expands into a prompt, before it reaches Claude. Can block the expansion                                                                                                                                                    |
| `PreToolUse`          | Before a tool call executes. Can block it                                                                                                                                                                                                             |
| `PermissionRequest`   | When a tool call needs a permission decision                                                                                                                                                                                                          |
| `PermissionDenied`    | When auto mode denies a tool call, including denials without a classifier verdict. Use JSON `hookSpecificOutput.retry: true` to tell the model it may retry the denied tool call. Claude Code ignores `retry` when the classifier produced no verdict |
| `PostToolUse`         | After a tool call succeeds                                                                                                                                                                                                                            |
| `PostToolUseFailure`  | After a tool call fails                                                                                                                                                                                                                               |
| `PostToolBatch`       | After a full batch of parallel tool calls resolves, before the next model call                                                                                                                                                                        |
| `Notification`        | When Claude Code sends a notification                                                                                                                                                                                                                 |
| `MessageDisplay`      | While assistant message text is displayed                                                                                                                                                                                                             |
| `SubagentStart`       | When a subagent is spawned                                                                                                                                                                                                                            |
| `SubagentStop`        | When a subagent finishes                                                                                                                                                                                                                              |
| `TaskCreated`         | When a task is being created via `TaskCreate`                                                                                                                                                                                                         |
| `TaskCompleted`       | When a task is being marked as completed                                                                                                                                                                                                              |
| `Stop`                | When Claude finishes responding                                                                                                                                                                                                                       |
| `StopFailure`         | When the turn ends due to an API error                                                                                                                                                                                                                |
| `TeammateIdle`        | When an [agent team](/docs/en/agent-teams) teammate is about to go idle                                                                                                                                                                                    |
| `InstructionsLoaded`  | When a CLAUDE.md or `.claude/rules/*.md` file is loaded into context. Fires at session start and when files are lazily loaded during a session                                                                                                        |
| `ConfigChange`        | When a configuration file changes during a session                                                                                                                                                                                                    |
| `CwdChanged`          | When the working directory changes, for example when Claude executes a `cd` command. Useful for reactive environment management with tools like direnv                                                                                                |
| `DirectoryAdded`      | When a working directory is added mid-session via `/add-dir` or the SDK `register_repo_root` control request                                                                                                                                          |
| `FileChanged`         | When a watched file changes on disk. The `matcher` field specifies which filenames to watch                                                                                                                                                           |
| `WorktreeCreate`      | When a worktree is being created via `--worktree`, `isolation: "worktree"`, or for a background session. Replaces default git behavior                                                                                                                |
| `WorktreeRemove`      | When a worktree is being removed at session exit, when a subagent finishes, or when you delete a background session                                                                                                                                   |
| `PreCompact`          | Before context compaction                                                                                                                                                                                                                             |
| `PostCompact`         | After context compaction completes                                                                                                                                                                                                                    |
| `Elicitation`         | When an MCP server requests user input during a tool call                                                                                                                                                                                             |
| `ElicitationResult`   | After a user responds to an MCP elicitation, before the response is sent back to the server                                                                                                                                                           |
| `SessionEnd`          | When a session terminates                                                                                                                                                                                                                             |

**Hook 类型**：

* `command`：执行 shell 命令或脚本
* `http`：将事件 JSON 作为 POST 请求发送到 URL
* `mcp_tool`：在配置的 [MCP server](/docs/zh-CN/mcp) 上调用工具
* `prompt`：使用 LLM 评估提示（使用 `$ARGUMENTS` 占位符表示上下文）
* `agent`：运行具有工具的 agentic 验证器以完成复杂验证任务

针对插件自己的 [捆绑 MCP server](#mcp-servers) 的 Hooks 必须使用其作用域名称。工具匹配器和 `if` 字段采用作用域工具名称 `mcp__plugin_<plugin-name>_<server-name>__<tool>`，而 `mcp_tool` hook 的 `server` 字段采用 `plugin:<plugin-name>:<server-name>`。针对裸服务器密钥编写的匹配器永远不会触发。请参阅 [匹配 MCP 工具](/docs/zh-CN/hooks#match-mcp-tools) 和 [Plugin 提供的 MCP servers](/docs/zh-CN/mcp#plugin-provided-mcp-servers)。

<h3 id="mcp-servers">
  MCP servers
</h3>

Plugins 可以捆绑 Model Context Protocol (MCP) servers 以将 Claude Code 与外部工具和服务连接。

**位置**：插件根目录中的 `.mcp.json`，或在 plugin.json 中内联

**格式**：标准 MCP server 配置

**MCP server 配置**：

```json theme={null}
{
  "mcpServers": {
    "plugin-database": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      "env": {
        "DB_PATH": "${CLAUDE_PLUGIN_ROOT}/data"
      }
    },
    "plugin-api-client": {
      "command": "npx",
      "args": ["@company/mcp-server", "--plugin-mode"]
    }
  }
}
```

**集成行为**：

* 启用插件时，Plugin MCP servers 会自动启动
* Servers 在 Claude 的工具包中显示为标准 MCP 工具
* Server 功能与 Claude 的现有工具无缝集成
* Plugin servers 可以独立于用户 MCP servers 进行配置

<h3 id="lsp-servers">
  LSP servers
</h3>

<Tip>
  想要使用 LSP plugins？从官方市场安装它们：在 `/plugin` Discover 选项卡中搜索"lsp"。本部分记录了如何为官方市场未涵盖的语言创建 LSP plugins。
</Tip>

Plugins 可以提供 [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) (LSP) servers，在处理代码库时为 Claude 提供实时代码智能。

LSP 集成提供：

* **即时诊断**：Claude 在每次编辑后立即看到错误和警告
* **代码导航**：转到定义、查找引用和悬停信息
* **语言感知**：代码符号的类型信息和文档

**位置**：插件根目录中的 `.lsp.json`，或在 `plugin.json` 中内联

**格式**：将语言服务器名称映射到其配置的 JSON 配置

**`.lsp.json` 文件格式**：

```json theme={null}
{
  "go": {
    "command": "gopls",
    "args": ["serve"],
    "extensionToLanguage": {
      ".go": "go"
    }
  }
}
```

**在 `plugin.json` 中内联**：

```json theme={null}
{
  "name": "my-plugin",
  "lspServers": {
    "go": {
      "command": "gopls",
      "args": ["serve"],
      "extensionToLanguage": {
        ".go": "go"
      }
    }
  }
}
```

**必需字段：**

| 字段                    | 描述                         |
| :-------------------- | :------------------------- |
| `command`             | 要执行的 LSP 二进制文件（必须在 PATH 中） |
| `extensionToLanguage` | 将文件扩展名映射到语言标识符             |

**可选字段：**

| 字段                      | 描述                                                                 |
| :---------------------- | :----------------------------------------------------------------- |
| `args`                  | LSP server 的命令行参数                                                  |
| `transport`             | 通信传输：`stdio`（默认）或 `socket`                                         |
| `env`                   | 启动 server 时要设置的环境变量                                                |
| `initializationOptions` | 在初始化期间传递给 server 的选项                                               |
| `settings`              | 通过 `workspace/didChangeConfiguration` 传递的设置                        |
| `workspaceFolder`       | server 的工作区文件夹路径                                                   |
| `startupTimeout`        | 等待 server 启动的最长时间（毫秒）                                              |
| `shutdownTimeout`       | 等待正常关闭的最长时间（毫秒）。当超时时间过去时，Claude Code 会终止 server 进程。未设置时，不适用超时      |
| `restartOnCrash`        | server 崩溃后是否重启。默认为 `true`。设置为 `false` 以保持崩溃的 server 停止而不是重启它       |
| `maxRestarts`           | 放弃前的最大重启尝试次数                                                       |
| `diagnostics`           | 是否在编辑后将诊断推送到 Claude 的上下文中（默认 `true`）。设置为 `false` 以保持代码导航但禁止自动诊断注入。 |

`restartOnCrash` 和 `shutdownTimeout` 需要 Claude Code v2.1.205 或更高版本。在 v2.1.205 之前，配置架构接受两个选项，但设置其中任何一个会导致 Claude Code 在启动时完全跳过该 LSP server，原因仅在 `claude --debug` 输出中可见。

**同一扩展名的多个 servers**：当多个启用的 LSP server 在 `extensionToLanguage` 中声明相同的文件扩展名时，无论 servers 来自一个插件还是来自不同的插件，第一个注册的 server 处理具有该扩展名的文件，其他的永远不会启动。`/plugin` 界面显示一个警告，命名其 server 处于活动状态的插件。

**初始化失败的 Servers**：Claude Code 会跳过配置无效的 server，例如缺少 `command` 或 `extensionToLanguage` 的 server，其他配置的 servers 仍然会启动。运行 `claude --debug` 以查看为什么 server 被跳过。

被跳过的 server 不会声明其文件扩展名，因此声明相同扩展名的另一个有效 server（来自同一个或不同的插件）仍然会处理这些文件。在 v2.1.205 之前，初始化失败的 server 仍然会声明其扩展名并阻止另一个有效 server 处理相同的扩展名。

<Warning>
  **您必须单独安装语言服务器二进制文件。** LSP plugins 配置 Claude Code 如何连接到语言服务器，但它们不包括服务器本身。如果在 `/plugin` Errors 选项卡中看到 `Executable not found in $PATH`，请为您的语言安装所需的二进制文件。
</Warning>

**可用的 LSP plugins：**

| Plugin              | 语言服务器                      | 安装命令                                                                            |
| :------------------ | :------------------------- | :------------------------------------------------------------------------------ |
| `pyright-lsp`       | Pyright (Python)           | `pip install pyright` 或 `npm install -g pyright`                                |
| `typescript-lsp`    | TypeScript Language Server | `npm install -g typescript-language-server typescript`                          |
| `rust-analyzer-lsp` | rust-analyzer              | [参阅 rust-analyzer 安装](https://rust-analyzer.github.io/manual.html#installation) |

首先安装语言服务器，然后从市场安装 plugin。

<h3 id="monitors">
  Monitors
</h3>

Plugins 可以声明后台 monitors，Claude Code 在 plugin 激活时自动启动。每个 monitor 为会话的生命周期运行一个 shell 命令，并将每个 stdout 行作为通知传递给 Claude，以便 Claude 可以对日志条目、状态更改或轮询事件做出反应，而无需被要求启动监视本身。

Plugin monitors 使用与 [Monitor tool](/docs/zh-CN/tools-reference#monitor-tool) 相同的机制，并共享其可用性约束。它们仅在交互式 CLI 会话中运行，在与 [hooks](#hooks) 相同的信任级别上无沙箱运行，并在 Monitor tool 不可用的主机上跳过。

**位置**：插件根目录中的 `monitors/monitors.json`，或在 plugin.json 中内联

**格式**：监视器条目的 JSON 数组

以下 `monitors/monitors.json` 监视部署状态端点和本地错误日志：

```json theme={null}
[
  {
    "name": "deploy-status",
    "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/poll-deploy.sh",
    "description": "Deployment status changes"
  },
  {
    "name": "error-log",
    "command": "tail -F ./logs/error.log",
    "description": "Application error log",
    "when": "on-skill-invoke:debug"
  }
]
```

要内联声明 monitors，请将 `plugin.json` 中的 `experimental.monitors` 设置为相同的数组。要从非默认路径加载，请将 `experimental.monitors` 设置为相对路径字符串，例如 `"./config/monitors.json"`。Monitors 是一个 [实验性组件](#experimental-components)。

**必需字段：**

| 字段            | 描述                                     |
| :------------ | :------------------------------------- |
| `name`        | 在插件中唯一的标识符。防止插件重新加载或再次调用 skill 时出现重复进程 |
| `command`     | 在会话工作目录中作为持久后台进程运行的 shell 命令           |
| `description` | 正在监视的内容的简短摘要。显示在任务面板和通知摘要中             |

**可选字段：**

| 字段     | 描述                                                                                                          |
| :----- | :---------------------------------------------------------------------------------------------------------- |
| `when` | 控制 monitor 何时启动。`"always"` 在会话启动和插件重新加载时启动它，这是默认值。`"on-skill-invoke:<skill-name>"` 在此插件中的命名 skill 首次被分派时启动它 |

`command` 值支持 [路径替换](#environment-variables) `${CLAUDE_PLUGIN_ROOT}`、`${CLAUDE_PLUGIN_DATA}` 和 `${CLAUDE_PROJECT_DIR}`，加上环境中的任何 `${ENV_VAR}`。如果脚本需要从插件自己的目录运行，请在命令前加上 `cd "${CLAUDE_PLUGIN_ROOT}" && `。

monitor `command` 不能引用 [`${user_config.*}`](#user-configuration) 值。该命令通过 shell 运行，因此 Claude Code 会拒绝该 monitor 并显示 [错误](/docs/zh-CN/errors#plugin-command-references-user-config)，而不是替换该值。Monitor 进程不会接收 `CLAUDE_PLUGIN_OPTION_<KEY>` 环境变量，因此让 monitor 脚本从它拥有的配置文件中读取该值。在 v2.1.207 之前，monitor 命令替换了 `${user_config.*}` 值。

在会话中途禁用插件不会停止已在运行的 monitors。它们在会话结束时停止。

<h3 id="themes">
  Themes
</h3>

Plugins 可以提供颜色主题，这些主题与内置预设和用户的本地主题一起出现在 `/theme` 中。主题是 `themes/` 中的 JSON 文件，具有 `base` 预设和稀疏的 `overrides` 颜色令牌映射。Themes 是一个 [实验性组件](#experimental-components)。

```json theme={null}
{
  "name": "Dracula",
  "base": "dark",
  "overrides": {
    "claude": "#bd93f9",
    "error": "#ff5555",
    "success": "#50fa7b"
  }
}
```

选择 plugin 主题会在用户的配置中持久化 `custom:<plugin-name>:<slug>`。Plugin 主题是只读的；在 `/theme` 中按 `Ctrl+E` 会将其复制到 `~/.claude/themes/`，以便用户可以编辑副本。

***

<h2 id="plugin-installation-scopes">
  Plugin 安装范围
</h2>

安装 plugin 时，您选择一个**范围**，确定 plugin 的可用位置以及谁可以使用它：

| 范围        | 设置文件                                               | 用例                       |
| :-------- | :------------------------------------------------- | :----------------------- |
| `user`    | `~/.claude/settings.json`                          | 在所有项目中可用的个人 plugins（默认）  |
| `project` | `.claude/settings.json`                            | 通过版本控制共享的团队 plugins      |
| `local`   | `.claude/settings.local.json`                      | 项目特定的 plugins，gitignored |
| `managed` | [Managed settings](/docs/zh-CN/settings#settings-files) | 托管 plugins（只读，仅更新）       |

Plugins 使用与其他 Claude Code 配置相同的范围系统。有关安装说明和范围标志，请参阅[安装 plugins](/docs/zh-CN/discover-plugins#install-plugins)。有关范围的完整说明，请参阅[Configuration scopes](/docs/zh-CN/settings#configuration-scopes)。

***

<h2 id="skills-directory-plugins">
  Skills 目录 plugins
</h2>

任何 skills 目录下包含 `.claude-plugin/plugin.json` 清单的文件夹都会在下一个会话中作为名为 `<name>@skills-dir` 的 plugin 加载，无需市场和无需安装步骤。使用 [`plugin init`](#plugin-init) 搭建一个。与市场安装不同，plugin 在原地被发现而不是复制到 plugin 缓存中。

skills 目录树支持三个不同的东西：

| 您拥有的                                          | 它是什么                                                     |
| :-------------------------------------------- | :------------------------------------------------------- |
| `<skills-dir>/foo/SKILL.md` 没有清单              | 一个名为 `foo` 的普通 [skill](/docs/zh-CN/skills)                    |
| `<skills-dir>/foo/.claude-plugin/plugin.json` | 一个 plugin `foo@skills-dir`，可以捆绑自己的 skills、agents、hooks 等 |
| `<plugin>/skills/bar/SKILL.md`                | 一个 skill `bar` 打包在 plugin 内                              |

<h3 id="choose-where-the-plugin-loads-from">
  选择 plugin 加载的位置
</h3>

| Skills 目录               | 范围 | 加载                                              |
| :---------------------- | :- | :---------------------------------------------- |
| `~/.claude/skills/`     | 个人 | 在每个项目中，因为位置仅属于您                                 |
| `<cwd>/.claude/skills/` | 项目 | 仅在您接受该文件夹的工作区 [trust dialog](/docs/zh-CN/settings) 后 |

项目范围的 plugin 被检入存储库，并到达克隆它的每个协作者。因为该内容来自存储库而不是来自您，它仅在与 `.claude/settings.json` 相同的信任门后加载，并且运行代码的组件受到进一步限制：

* 它声明的 MCP servers 通过与项目 `.mcp.json` 相同的 [per-server approval](/docs/zh-CN/mcp)
* LSP servers 仅在您信任工作区后启动
* [Background monitors](#monitors) 不加载

个人范围的 plugins 没有这些限制。

<Warning>
  项目范围的 `@skills-dir` plugins 仅从启动 Claude Code 的目录的 `.claude/skills/` 加载。它们不会 [walk up to the repository root](/docs/zh-CN/skills#automatic-discovery-from-parent-and-nested-directories) 的方式与普通 skills 和 commands 相同，因此从子目录启动会错过位于存储库根目录的 plugin。从存储库根目录启动，或在更改目录后运行 `/reload-plugins`。
</Warning>

<h3 id="edit-reload-and-disable-a-skills-directory-plugin">
  编辑、重新加载和禁用 skills 目录 plugin
</h3>

您对 skill 的 `SKILL.md` 所做的更改在当前会话中立即生效。对 plugin 的其他组件（如 `hooks/`、`.mcp.json`、`agents/` 和 `output-styles/`）的更改则不会。运行 `/reload-plugins` 或重启 Claude Code 以获取这些更改。请参阅 [Live change detection](/docs/zh-CN/skills#live-change-detection)。

要停止加载 skills 目录 plugin，请删除其文件夹或按名称禁用它。没有 `uninstall` 步骤，因为没有从市场安装任何东西。

```bash theme={null}
claude plugin disable my-tool@skills-dir
```

***

<h2 id="plugin-manifest-schema">
  Plugin 清单架构
</h2>

`.claude-plugin/plugin.json` 文件定义了您的 plugin 的元数据和配置。本部分记录了所有支持的字段和选项。

清单是可选的。如果省略，Claude Code 会自动发现[默认位置](#file-locations-reference)中的组件，并从目录名称派生 plugin 名称。当您需要提供元数据或自定义组件路径时，使用清单。

<h3 id="complete-schema">
  完整架构
</h3>

```json theme={null}
{
  "name": "plugin-name",
  "displayName": "Plugin Name",
  "version": "1.2.0",
  "description": "Brief plugin description",
  "author": {
    "name": "Author Name",
    "email": "author@example.com",
    "url": "https://github.com/author"
  },
  "homepage": "https://docs.example.com/plugin",
  "repository": "https://github.com/author/plugin",
  "license": "MIT",
  "keywords": ["keyword1", "keyword2"],
  "skills": "./custom/skills/",
  "commands": ["./custom/commands/special.md"],
  "agents": ["./custom/agents/reviewer.md"],
  "hooks": "./config/hooks.json",
  "mcpServers": "./mcp-config.json",
  "outputStyles": "./styles/",
  "lspServers": "./.lsp.json",
  "experimental": {
    "themes": "./themes/",
    "monitors": "./monitors.json"
  },
  "dependencies": [
    "helper-lib",
    { "name": "secrets-vault", "version": "~2.1.0" }
  ]
}
```

<h3 id="required-fields">
  必需字段
</h3>

如果包含清单，`name` 是唯一必需的字段。

| 字段     | 类型     | 描述                                                                                                                                    | 示例                   |
| :----- | :----- | :------------------------------------------------------------------------------------------------------------------------------------ | :------------------- |
| `name` | string | 唯一标识符（kebab-case，无空格）。当[市场条目](/docs/zh-CN/plugin-marketplaces#plugin-entries)以不同的名称列出 plugin 时，市场条目名称是 `enabledPlugins` 键和 `/plugin` 使用的名称 | `"deployment-tools"` |

此名称用于命名空间组件。例如，在 UI 中，名为 `plugin-dev` 的 plugin 的 agent `agent-creator` 将显示为 `plugin-dev:agent-creator`。

<h3 id="unrecognized-fields">
  未识别的字段
</h3>

Claude Code 忽略它不识别的顶级字段。您可以在 `plugin.json` 中保留来自另一个生态系统的元数据，plugin 仍然会加载。这使得维护一个清单变得实用，该清单可以同时用作 VS Code 或 Cursor 扩展清单、npm `package.json` 或 MCPB/DXT 包清单。

`claude plugin validate` 将未识别的字段报告为警告，而不是错误。如果字段与识别的字段相差一两个字符，警告会建议可能的预期名称。仅具有未识别字段警告的 plugin 仍然通过验证并在运行时加载。

具有错误类型的字段仍然会失败。例如，`keywords` 值是字符串而不是数组是加载错误，`claude plugin validate` 会将其报告为错误。

传递 `--strict` 以将警告视为错误。在 CI 中使用它来捕获拼写错误的字段名称或来自另一个工具清单的遗留字段，然后再发布，即使 plugin 在运行时会加载。

```bash theme={null}
claude plugin validate ./my-plugin --strict
```

<h3 id="metadata-fields">
  元数据字段
</h3>

| 字段               | 类型      | 描述                                                                                                                                                                       | 示例                                                                |
| :--------------- | :------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------- |
| `$schema`        | string  | 用于编辑器自动完成和验证的 JSON Schema URL。Claude Code 在加载时忽略此字段。                                                                                                                     | `"https://json.schemastore.org/claude-code-plugin-manifest.json"` |
| `displayName`    | string  | 在 `/plugin` 选择器和其他 UI 界面中显示的人类可读名称。当省略时回退到 `name`。与 `name` 不同，可以包含空格和任何大小写。不用于命名空间或查找。需要 Claude Code v2.1.143 或更高版本。                                                     | `"Deployment Tools"`                                              |
| `version`        | string  | 可选。语义版本。设置此项会将 plugin 固定到该版本字符串，因此用户仅在您提升版本时才会收到更新。如果省略，Claude Code 会回退到 git commit SHA，因此每个 commit 都被视为新版本。如果也在市场条目中设置，`plugin.json` 优先。请参阅[版本管理](#version-management)。 | `"2.1.0"`                                                         |
| `description`    | string  | plugin 目的的简要说明                                                                                                                                                           | `"Deployment automation tools"`                                   |
| `author`         | object  | 作者信息                                                                                                                                                                     | `{"name": "Dev Team", "email": "dev@company.com"}`                |
| `homepage`       | string  | 文档 URL                                                                                                                                                                   | `"https://docs.example.com"`                                      |
| `repository`     | string  | 源代码 URL                                                                                                                                                                  | `"https://github.com/user/plugin"`                                |
| `license`        | string  | 许可证标识符                                                                                                                                                                   | `"MIT"`、`"Apache-2.0"`                                            |
| `keywords`       | array   | 发现标签                                                                                                                                                                     | `["deployment", "ci-cd"]`                                         |
| `defaultEnabled` | boolean | 当用户未设置时，plugin 是否在启用状态下启动。默认为 `true`。请参阅[默认启用](#default-enablement)。需要 Claude Code v2.1.154 或更高版本。                                                                       | `false`                                                           |

<h3 id="default-enablement">
  默认启用
</h3>

在 `plugin.json` 中设置 `defaultEnabled: false` 以提供一个安装时禁用的 plugin。用户使用 `claude plugin enable <plugin>` 或 `/plugin` 界面将其打开。对于添加成本或用户应选择加入的范围的 plugins 使用此功能，例如连接到外部服务的 plugin。这需要 Claude Code v2.1.154 或更高版本。早期版本忽略该字段并在安装时启用 plugin。

`defaultEnabled` 是当没有其他东西决定 plugin 状态时的后备。两件事优先于它：

* **用户的设置**：任何设置范围中 `enabledPlugins` 中的 plugin 条目。一旦写入，它在 plugin 更新和重新安装中持续，因此在后续版本中更改 `defaultEnabled` 不会翻转现有用户。
* **依赖项要求**：当 plugin 被另一个活跃的 plugin 需要时，Claude Code 在安装或启用时为其写入 `true`。这给了它一个显式设置，所以它自己的默认值不再适用。请参阅[启用或禁用具有依赖项的 plugin](/docs/zh-CN/plugin-dependencies#enable-or-disable-a-plugin-with-dependencies)。

相同的字段可以出现在 plugin 的市场条目中，其中它优先于 `plugin.json` 中的值。请参阅[可选 plugin 字段](/docs/zh-CN/plugin-marketplaces#optional-plugin-fields)。

<h3 id="component-path-fields">
  组件路径字段
</h3>

| 字段                      | 类型                    | 描述                                                                                                     | 示例                                                   |
| :---------------------- | :-------------------- | :----------------------------------------------------------------------------------------------------- | :--------------------------------------------------- |
| `skills`                | string\|array         | 包含 `<name>/SKILL.md` 的自定义 skill 目录。添加到默认 `skills/` 扫描。请参阅[路径行为规则](#path-behavior-rules)了解市场根异常         | `"./custom/skills/"`                                 |
| `commands`              | string\|array         | 自定义平面 `.md` skill 文件或目录（替换默认 `commands/`）                                                              | `"./custom/cmd.md"` 或 `["./cmd1.md"]`                |
| `agents`                | string\|array         | 自定义 agent 文件（替换默认 `agents/`）                                                                           | `"./custom/agents/reviewer.md"`                      |
| `hooks`                 | string\|array\|object | Hook 配置路径或内联配置                                                                                         | `"./my-extra-hooks.json"`                            |
| `mcpServers`            | string\|array\|object | MCP 配置路径或内联配置                                                                                          | `"./my-extra-mcp-config.json"`                       |
| `outputStyles`          | string\|array         | 自定义输出样式文件/目录（替换默认 `output-styles/`）                                                                    | `"./styles/"`                                        |
| `lspServers`            | string\|array\|object | [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) 配置用于代码智能（转到定义、查找引用等） | `"./.lsp.json"`                                      |
| `experimental.themes`   | string\|array         | 颜色主题文件/目录（替换默认 `themes/`）。请参阅[Themes](#themes)                                                         | `"./themes/"`                                        |
| `experimental.monitors` | string\|array         | 后台[Monitor](/docs/zh-CN/tools-reference#monitor-tool)配置，在 plugin 激活时自动启动。请参阅[Monitors](#monitors)           | `"./monitors.json"`                                  |
| `userConfig`            | object                | 用户可配置的值，在启用时提示。请参阅[用户配置](#user-configuration)                                                          | 见下文                                                  |
| `channels`              | array                 | 消息注入的频道声明（Telegram、Slack、Discord 风格）。请参阅[Channels](#channels)                                          | 见下文                                                  |
| `dependencies`          | array                 | 此 plugin 需要的其他 plugins，可选择带有 semver 版本约束。请参阅[约束 plugin 依赖版本](/docs/zh-CN/plugin-dependencies)               | `[{ "name": "secrets-vault", "version": "~2.1.0" }]` |

<h3 id="experimental-components">
  实验性组件
</h3>

`experimental` 键下的组件，`themes` 和 `monitors`，具有在稳定期间可能在版本之间更改的清单架构。您声明它们的位置是一个单独的迁移：顶级仍然有效，`claude plugin validate` 发出警告，未来的版本将需要 `experimental.*`。

<h3 id="user-configuration">
  用户配置
</h3>

`userConfig` 字段声明了 Claude Code 在启用 plugin 时提示用户的值。使用此字段而不是要求用户手动编辑 `settings.json`。

```json theme={null}
{
  "userConfig": {
    "api_endpoint": {
      "type": "string",
      "title": "API endpoint",
      "description": "Your team's API endpoint"
    },
    "api_token": {
      "type": "string",
      "title": "API token",
      "description": "API authentication token",
      "sensitive": true
    }
  }
}
```

键必须是有效的标识符。每个选项支持这些字段：

| 字段            | 必需 | 描述                                                    |
| :------------ | :- | :---------------------------------------------------- |
| `type`        | 是  | 以下之一：`string`、`number`、`boolean`、`directory` 或 `file` |
| `title`       | 是  | 在配置对话框中显示的标签                                          |
| `description` | 是  | 显示在字段下方的帮助文本                                          |
| `sensitive`   | 否  | 如果为 `true`，掩盖输入并将值存储在安全存储中而不是 `settings.json`         |
| `required`    | 否  | 如果为 `true`，当字段为空时验证失败                                 |
| `default`     | 否  | 用户未提供任何内容时使用的值                                        |
| `multiple`    | 否  | 对于 `string` 类型，允许字符串数组                                |
| `min` / `max` | 否  | `number` 类型的边界                                        |

每个值都可用于在 MCP 和 LSP server 配置和 hook 命令中作为 `${user_config.KEY}` 进行替换。非敏感值也可以在 skill 和 agent 内容中替换。所有值都作为 `CLAUDE_PLUGIN_OPTION_<KEY>` 环境变量导出到 hook 进程和 MCP 及 LSP server 子进程，其中 `<KEY>` 是选项键的大写形式。

在 shell 中运行的字段拒绝 `${user_config.*}`：将配置的值替换到 shell 命令中会让 shell 运行该值包含的任何内容，因此组件会失败并出现[错误](/docs/zh-CN/errors#plugin-command-references-user-config)。每个被拒绝的字段都有一种替代方式来传递值：

| 被拒绝的字段                                                                          | 如何传递值                                                                                               |
| :------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------- |
| Shell 形式的 hook 命令                                                               | 使用[执行形式](/docs/zh-CN/hooks#exec-form-and-shell-form)与 `args`，或从 hook 的环境中读取 `CLAUDE_PLUGIN_OPTION_<KEY>` |
| [Monitor](#monitors) 命令                                                         | 从脚本中的配置文件读取值                                                                                        |
| MCP [`headersHelper`](/docs/zh-CN/mcp#use-dynamic-headers-for-custom-authentication) | 从脚本中的配置文件读取值                                                                                        |

在 v2.1.207 之前，这些字段替换了 `${user_config.KEY}` 值；更新依赖此功能的 plugins。

非敏感值存储在 `settings.json` 中的 [`pluginConfigs`](/docs/zh-CN/settings#pluginconfigs) 键下，作为 `pluginConfigs[<plugin-id>].options`。Claude Code 将键写入用户设置并从用户设置、`--settings` 标志和托管设置中读取它；项目的 `.claude/settings.json` 或 `.claude/settings.local.json` 中的条目被忽略。在 v2.1.207 之前，Claude Code 也读取项目和本地设置。

敏感值进入 macOS Keychain，或在没有支持的钥匙链的平台上进入 `~/.claude/.credentials.json`。钥匙链存储与 OAuth 令牌共享，总限制约为 2 KB，因此请保持敏感值较小。

<h3 id="channels">
  Channels
</h3>

`channels` 字段允许 plugin 声明一个或多个消息频道，将内容注入到对话中。每个频道绑定到 plugin 提供的 MCP server。

```json theme={null}
{
  "channels": [
    {
      "server": "telegram",
      "userConfig": {
        "bot_token": {
          "type": "string",
          "title": "Bot token",
          "description": "Telegram bot token",
          "sensitive": true
        },
        "owner_id": {
          "type": "string",
          "title": "Owner ID",
          "description": "Your Telegram user ID"
        }
      }
    }
  ]
}
```

`server` 字段是必需的，必须与 plugin 的 `mcpServers` 中的键匹配。可选的每个频道 `userConfig` 使用与顶级字段相同的架构，允许 plugin 在启用 plugin 时提示输入机器人令牌或所有者 ID。

<h3 id="path-behavior-rules">
  路径行为规则
</h3>

自定义路径是否替换或扩展 plugin 的默认目录取决于该字段：

* **替换默认值**：`commands`、`agents`、`outputStyles`、`experimental.themes`、`experimental.monitors`。例如，当清单指定 `commands` 时，不会扫描默认 `commands/` 目录。要保留默认值并添加更多，请明确列出它：`"commands": ["./commands/", "./extras/"]`
* **添加到默认值**：`skills`。默认 `skills/` 目录始终被扫描，`skills` 中列出的目录与其一起加载。异常：对于[其 `source` 解析为市场根的市场条目](/docs/zh-CN/plugin-marketplaces#advanced-plugin-entries)，声明特定子目录会替换默认 `skills/` 扫描
* **自己的合并规则**：[hooks](#hooks)、[MCP servers](#mcp-servers) 和 [LSP servers](#lsp-servers)。请参阅每个部分了解多个源如何组合

当 plugin 同时具有默认文件夹和匹配的清单键时，Claude Code v2.1.140 及更高版本在 `claude plugin list` 和 `/plugin` 详细视图中标记被忽略的文件夹。plugin 仍然使用清单路径加载。当清单键指向默认文件夹时不显示警告，例如 `"commands": ["./commands/deploy.md"]`，因为在这种情况下文件夹被明确寻址。

对于所有路径字段：

* 所有路径必须相对于 plugin 根目录，并以 `./` 开头
* 来自自定义路径的组件使用相同的命名和命名空间规则
* 可以将多个路径指定为数组
* 当 skill 路径指向直接包含 `SKILL.md` 的目录时，例如 `"skills": ["./"]` 指向 plugin 根目录，frontmatter 中的 `name` 字段确定 skill 的调用名称。这提供了一个稳定的名称，无论安装目录如何。如果 frontmatter 中未设置 `name`，则使用目录基名作为后备。

在其根目录中具有 `SKILL.md`、没有 `skills/` 子目录且没有 `skills` 清单字段的 plugin 在 Claude Code v2.1.142 及更高版本中自动作为单一 skill plugin 加载。您不需要在 `plugin.json` 中设置 `"skills": ["./"]` 来使用此布局。skill 的调用名称遵循与上述相同的规则：frontmatter `name` 字段，或目录基名作为后备。

**路径示例**：

```json theme={null}
{
  "commands": [
    "./specialized/deploy.md",
    "./utilities/batch-process.md"
  ],
  "agents": [
    "./custom-agents/reviewer.md",
    "./custom-agents/tester.md"
  ]
}
```

<h3 id="environment-variables">
  环境变量
</h3>

Claude Code 提供三个变量用于引用路径：

| 变量                      | 解析为                                                       | 用途                                              |
| :---------------------- | :-------------------------------------------------------- | :---------------------------------------------- |
| `${CLAUDE_PLUGIN_ROOT}` | plugin 安装目录的绝对路径                                          | 与 plugin 捆绑的脚本、二进制文件和配置文件                       |
| `${CLAUDE_PLUGIN_DATA}` | [持久目录](#persistent-data-directory)，在 plugin 更新后保留，首次引用时创建 | 已安装的依赖项，如 `node_modules` 或 Python 虚拟环境、生成的代码和缓存 |
| `${CLAUDE_PROJECT_DIR}` | 项目根目录                                                     | 项目本地脚本和配置文件                                     |

所有三个都作为环境变量导出到 hook 进程和 MCP 及 LSP server 子进程。哪些字段内联替换它们取决于 plugin 组件：

| Plugin 组件                     | 占位符解析的字段                                 |
| :---------------------------- | :--------------------------------------- |
| Skill 和 agent 内容              | 占位符出现的任何地方                               |
| Hook 和 monitor 命令             | 占位符出现的任何地方                               |
| MCP `stdio` servers           | `command`、`args`、`env`                   |
| MCP `http`、`sse`、`ws` servers | `url`、`headers`、`headersHelper`          |
| LSP servers                   | `command`、`args`、`env`、`workspaceFolder` |

在 hook 命令中，使用[执行形式](/docs/zh-CN/hooks#exec-form-and-shell-form)与 `args` 以便每个路径作为一个参数传递，无需引用。在 shell 形式的 hooks 和 monitor 命令中，用双引号包装变量，如 `"${CLAUDE_PROJECT_DIR}/scripts/server.sh"`。此 shell 形式的 hook 运行与 plugin 捆绑的脚本：

```json theme={null}
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/process.sh"
          }
        ]
      }
    ]
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` 在 plugin 更新时更改。前一个版本的目录在更新后约七天内保留在磁盘上以进行清理，但应将其视为临时的，不要在此处写入状态。

当 plugin 在会话中期更新时，hook 命令、monitors、MCP servers 和 LSP servers 继续使用前一个版本的路径。运行 `/reload-plugins` 以将 hooks、MCP servers 和 LSP servers 切换到新路径；monitors 需要会话重启。

MCP servers 也可以调用 `roots/list` 请求来在运行时读取会话的工作目录。请参阅[`roots/list` 返回的内容以及 Claude Code 何时通知服务器更改](/docs/zh-CN/mcp#option-3-add-a-local-stdio-server)。

<h4 id="persistent-data-directory">
  持久数据目录
</h4>

`${CLAUDE_PLUGIN_DATA}` 目录解析为 `~/.claude/plugins/data/{id}/`，其中 `{id}` 是 plugin 标识符，其中 `a-z`、`A-Z`、`0-9`、`_` 和 `-` 之外的字符被替换为 `-`。对于安装为 `formatter@my-marketplace` 的 plugin，目录是 `~/.claude/plugins/data/formatter-my-marketplace/`。

常见用途是一次安装语言依赖项并在会话和 plugin 更新中重复使用它们。由于数据目录的生命周期长于任何单个 plugin 版本，仅检查目录存在性无法检测到更新何时更改了 plugin 的依赖项清单。推荐的模式是将捆绑的清单与数据目录中的副本进行比较，并在它们不同时重新安装。

此 `SessionStart` hook 在第一次运行时安装 `node_modules`，并在 plugin 更新包含更改的 `package.json` 时再次安装：

```json theme={null}
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "diff -q \"${CLAUDE_PLUGIN_ROOT}/package.json\" \"${CLAUDE_PLUGIN_DATA}/package.json\" >/dev/null 2>&1 || (cd \"${CLAUDE_PLUGIN_DATA}\" && cp \"${CLAUDE_PLUGIN_ROOT}/package.json\" . && npm install) || rm -f \"${CLAUDE_PLUGIN_DATA}/package.json\""
          }
        ]
      }
    ]
  }
}
```

当存储的副本缺失或与捆绑的副本不同时，`diff` 退出非零，涵盖第一次运行和依赖项更改的更新。如果 `npm install` 失败，尾部的 `rm` 会删除复制的清单，以便下一个会话重试。

捆绑在 `${CLAUDE_PLUGIN_ROOT}` 中的脚本可以针对持久的 `node_modules` 运行：

```json theme={null}
{
  "mcpServers": {
    "routines": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"],
      "env": {
        "NODE_PATH": "${CLAUDE_PLUGIN_DATA}/node_modules"
      }
    }
  }
}
```

当您从最后一个安装了 plugin 的范围卸载 plugin 时，数据目录会自动删除。`/plugin` 界面显示目录大小并在删除前提示。CLI 默认删除；传递 [`--keep-data`](#plugin-uninstall) 以保留它。

***

<h2 id="plugin-caching-and-file-resolution">
  Plugin 缓存和文件解析
</h2>

Plugins 通过以下两种方式之一指定：

* 通过 `claude --plugin-dir` 或 `claude --plugin-url`，用于会话期间。
* 通过市场，为将来的会话安装。

出于安全和验证目的，Claude Code 将\_市场\_ plugins 复制到用户的本地 **plugin 缓存**（`~/.claude/plugins/cache`），而不是就地使用它们。在开发引用外部文件的 plugins 时，理解此行为很重要。

每个已安装的版本是缓存中的单独目录。当您更新或卸载 plugin 时，前一个版本目录被标记为孤立，并在 7 天后自动删除。宽限期允许已加载旧版本的并发 Claude Code 会话继续运行而不出错。

Claude 的 Glob 和 Grep 工具在搜索期间跳过孤立版本目录，因此文件结果不包括过时的插件代码。

<h3 id="path-traversal-limitations">
  路径遍历限制
</h3>

已安装的 plugins 无法引用其目录外的文件。遍历 plugin 根目录外的路径（例如 `../shared-utils`）在安装后将不起作用，因为这些外部文件不会被复制到缓存中。

<h3 id="share-files-within-a-marketplace-with-symlinks">
  使用符号链接在市场内共享文件
</h3>

如果您的 plugin 需要与同一市场的其他部分共享文件，您可以在 plugin 目录中创建符号链接。当 plugin 被复制到缓存中时，符号链接的处理方式取决于其目标的解析位置：

* **在 plugin 自己的目录内：** 符号链接在缓存中被保留为相对符号链接，因此它在运行时继续解析到复制的目标。
* **在同一市场内的其他位置：** 符号链接被解引用。目标的内容被复制到缓存中以替代它。这允许元 plugin 的 `skills/` 目录链接到市场中其他 plugins 定义的技能。
* **在市场外：** 符号链接出于安全考虑被跳过。这防止 plugins 从任意主机文件（如系统路径）拉入缓存。

对于使用 `--plugin-dir` 安装或从本地路径安装的 plugins，只有解析到 plugin 自己目录内的符号链接被保留。所有其他的都被跳过。

以下命令创建从市场 plugin 内部到由同级 plugin 定义的共享技能的链接。在 Windows 上，从提升的命令提示符使用 `mklink /D` 或启用开发者模式：

```bash theme={null}
ln -s ../../shared-plugin/skills/foo ./skills/foo
```

这在保持缓存系统安全优势的同时提供了灵活性。

***

<h2 id="plugin-directory-structure">
  Plugin 目录结构
</h2>

<h3 id="standard-plugin-layout">
  标准 plugin 布局
</h3>

完整的 plugin 遵循此结构：

```text theme={null}
enterprise-plugin/
├── .claude-plugin/           # 元数据目录（可选）
│   └── plugin.json             # plugin 清单
├── skills/                   # Skills
│   ├── code-reviewer/
│   │   └── SKILL.md
│   └── pdf-processor/
│       ├── SKILL.md
│       └── scripts/
├── commands/                 # Skills 作为平面 .md 文件
│   ├── status.md
│   └── logs.md
├── agents/                   # Subagent 定义
│   ├── security-reviewer.md
│   ├── performance-tester.md
│   └── compliance-checker.md
├── output-styles/            # 输出样式定义
│   └── terse.md
├── themes/                   # 颜色主题定义
│   └── dracula.json
├── monitors/                 # 后台 monitor 配置
│   └── monitors.json
├── hooks/                    # Hook 配置
│   ├── hooks.json           # 主 hook 配置
│   └── security-hooks.json  # 其他 hooks
├── bin/                      # 添加到 PATH 的 plugin 可执行文件
│   └── my-tool               # 在 Bash tool 中可作为裸命令调用
├── settings.json            # plugin 的默认设置
├── .mcp.json                # MCP server 定义
├── .lsp.json                # LSP server 配置
├── scripts/                 # Hook 和实用脚本
│   ├── security-scan.sh
│   ├── format-code.py
│   └── deploy.js
├── LICENSE                  # 许可证文件
└── CHANGELOG.md             # 版本历史
```

<Warning>
  `.claude-plugin/` 目录包含 `plugin.json` 文件。所有其他目录（commands/、agents/、skills/、output-styles/、themes/、monitors/、hooks/）必须在 plugin 根目录，而不是在 `.claude-plugin/` 内。
</Warning>

plugin 根目录中的 `CLAUDE.md` 文件不会作为项目上下文加载。Plugins 通过 skills、agents 和 hooks 而不是 CLAUDE.md 来贡献上下文。要提供加载到 Claude 上下文中的说明，请将其放在 [skill](#skills) 中。

<h3 id="file-locations-reference">
  文件位置参考
</h3>

| 组件                | 默认位置                         | 目的                                                                                                                        |
| :---------------- | :--------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| **清单**            | `.claude-plugin/plugin.json` | Plugin 元数据和配置（可选）                                                                                                         |
| **Skills**        | `skills/`                    | 具有 `<name>/SKILL.md` 结构的 Skills                                                                                           |
| **Commands**      | `commands/`                  | Skills 作为平面 Markdown 文件。新 plugins 使用 `skills/`                                                                            |
| **Agents**        | `agents/`                    | Subagent Markdown 文件                                                                                                      |
| **Output styles** | `output-styles/`             | 输出样式定义                                                                                                                    |
| **Themes**        | `themes/`                    | 颜色主题定义                                                                                                                    |
| **Hooks**         | `hooks/hooks.json`           | Hook 配置                                                                                                                   |
| **MCP servers**   | `.mcp.json`                  | MCP server 定义                                                                                                             |
| **LSP servers**   | `.lsp.json`                  | 语言服务器配置                                                                                                                   |
| **Monitors**      | `monitors/monitors.json`     | 后台 monitor 配置                                                                                                             |
| **Executables**   | `bin/`                       | 添加到 Bash tool 的 `PATH` 的可执行文件。此处的文件在 plugin 启用时可作为任何 Bash tool 调用中的裸命令调用                                                  |
| **Settings**      | `settings.json`              | 启用 plugin 时应用的默认配置。目前仅支持 [`agent`](/docs/zh-CN/sub-agents) 和 [`subagentStatusLine`](/docs/zh-CN/statusline#subagent-status-lines) 键 |

***

<h2 id="cli-commands-reference">
  CLI 命令参考
</h2>

Claude Code 提供了用于非交互式 plugin 管理的 CLI 命令，对脚本和自动化很有用。

<h3 id="plugin-init">
  plugin init
</h3>

在 `~/.claude/skills/<name>/` 处搭建一个新 plugin。在下一个 Claude Code 会话中，它会自动作为 `<name>@skills-dir` 加载，并在 `/plugin` 和 `claude plugin list` 中出现，无需安装步骤。

请参阅 [Skills 目录 plugins](#skills-directory-plugins) 了解范围和信任要求。

```bash theme={null}
claude plugin init <name> [options]
```

**参数：**

* `<name>`：Plugin 名称。成为 skill 命名空间和 `~/.claude/skills/` 下的目录名称，因此不能包含空格或路径分隔符。

**选项：**

| 选项                       | 描述                                                                           | 默认值                     |
| :----------------------- | :--------------------------------------------------------------------------- | :---------------------- |
| `--description <text>`   | 清单描述                                                                         |                         |
| `--author <name>`        | 作者名称                                                                         | `git config user.name`  |
| `--author-email <email>` | 作者电子邮件                                                                       | `git config user.email` |
| `--with <components...>` | 同时搭建组件文件夹。有效值：`skills`、`agents`、`hooks`、`mcp`、`lsp`、`output-style`、`channel` |                         |
| `-f, --force`            | 覆盖目标处的现有 `.claude-plugin/`                                                   |                         |
| `-h, --help`             | 显示命令帮助                                                                       |                         |

**别名：** `new`

每个 `--with` 值为该组件添加一个启动文件，准备编辑：

| 组件             | 它搭建什么                                                                                                 |
| :------------- | :---------------------------------------------------------------------------------------------------- |
| `skills`       | 一个额外的命名空间 `<name>:example` skill 与默认的一起                                                               |
| `agents`       | 一个 `agents/` subagent 定义                                                                              |
| `hooks`        | 一个 `hooks/hooks.json` 带有示例事件处理程序                                                                      |
| `mcp`          | 一个 `.mcp.json` 带有 HTTP 和 stdio server 示例                                                              |
| `lsp`          | 一个 `.lsp.json` 语言服务器示例                                                                                |
| `output-style` | 一个 `output-styles/<name>.md` 在 plugin 启用时自动应用                                                         |
| `channel`      | 一个基于 MCP 的 [channel](/docs/zh-CN/channels)：一个 stdio server (`server.ts`)、它的 `.mcp.json` 和一个 `package.json` |

搭建的 plugin 使用 `@skills-dir` 源而不是市场。管理员可以使用 `strictKnownMarketplaces` 或通过在 [managed settings](/docs/zh-CN/plugin-marketplaces#managed-marketplace-restrictions) 中添加 `{"source": "skills-dir"}` 到 `blockedMarketplaces` 来阻止此源。当被阻止时，`plugin init` 在写入前失败。

**示例：**

```bash theme={null}
# 搭建最小 plugin
claude plugin init my-helper

# 使用 skill 和 hook 文件夹搭建
claude plugin init my-helper --with skills hooks

# 覆盖现有搭建
claude plugin init my-helper --force
```

<h3 id="plugin-install">
  plugin install
</h3>

从可用市场安装 plugin。

```bash theme={null}
claude plugin install <plugin> [options]
```

**参数：**

* `<plugin>`：Plugin 名称或 `plugin-name@marketplace-name` 用于特定市场

**选项：**

| 选项                    | 描述                              | 默认值    |
| :-------------------- | :------------------------------ | :----- |
| `-s, --scope <scope>` | 安装范围：`user`、`project` 或 `local` | `user` |
| `-h, --help`          | 显示命令帮助                          |        |

范围确定将已安装的 plugin 添加到哪个设置文件。例如，`--scope project` 写入 `.claude/settings.json` 中的 `enabledPlugins`，使 plugin 对克隆项目存储库的每个人都可用。

**示例：**

```bash theme={null}
# 安装到用户范围（默认）
claude plugin install formatter@my-marketplace

# 安装到项目范围（与团队共享）
claude plugin install formatter@my-marketplace --scope project

# 安装到本地范围（gitignored）
claude plugin install formatter@my-marketplace --scope local
```

<h3 id="plugin-uninstall">
  plugin uninstall
</h3>

删除已安装的 plugin。

```bash theme={null}
claude plugin uninstall <plugin> [options]
```

**参数：**

* `<plugin>`：Plugin 名称或 `plugin-name@marketplace-name`

**选项：**

| 选项                    | 描述                                                          | 默认值    |
| :-------------------- | :---------------------------------------------------------- | :----- |
| `-s, --scope <scope>` | 从范围卸载：`user`、`project` 或 `local`                            | `user` |
| `--keep-data`         | 保留插件的[持久数据目录](#persistent-data-directory)                   |        |
| `--prune`             | 同时删除其他 plugin 不需要的自动安装依赖项。请参阅 [plugin prune](#plugin-prune) |        |
| `-y, --yes`           | 跳过 `--prune` 确认提示。当 stdin 或 stdout 不是 TTY 时需要               |        |
| `-h, --help`          | 显示命令帮助                                                      |        |

**别名：** `remove`、`rm`

默认情况下，从最后一个剩余范围卸载也会删除插件的 `${CLAUDE_PLUGIN_DATA}` 目录。使用 `--keep-data` 保留它，例如在测试新版本后重新安装时。

<h3 id="plugin-prune">
  plugin prune
</h3>

删除不再被任何已安装 plugin 需要的自动安装 plugin 依赖项。Claude Code 为满足另一个 plugin 的 [`dependencies`](/docs/zh-CN/plugin-dependencies) 字段而引入的依赖项将被删除；您直接安装的 plugin 永远不会被触及。

```bash theme={null}
claude plugin prune [options]
```

**选项：**

| 选项                    | 描述                                 | 默认值    |
| :-------------------- | :--------------------------------- | :----- |
| `-s, --scope <scope>` | 在范围处修剪：`user`、`project` 或 `local`  | `user` |
| `--dry-run`           | 列出将被删除的内容而不实际删除                    |        |
| `-y, --yes`           | 跳过确认提示。当 stdin 或 stdout 不是 TTY 时需要 |        |
| `-h, --help`          | 显示命令帮助                             |        |

**别名：** `autoremove`

该命令列出孤立的依赖项，并在删除前要求确认。要在一个步骤中删除 plugin 并清理其依赖项，请运行 `claude plugin uninstall <plugin> --prune`。

<Note>
  `claude plugin prune` 需要 Claude Code v2.1.121 或更高版本。
</Note>

<h3 id="plugin-enable">
  plugin enable
</h3>

启用已禁用的 plugin。如果 plugin 声明了[依赖项](/docs/zh-CN/plugin-dependencies)，Claude Code 会在同一范围内以传递方式启用它们，当依赖项未安装时命令会失败。

```bash theme={null}
claude plugin enable <plugin> [options]
```

**参数：**

* `<plugin>`：Plugin 名称或 `plugin-name@marketplace-name`

**选项：**

| 选项                    | 描述                                | 默认值    |
| :-------------------- | :-------------------------------- | :----- |
| `-s, --scope <scope>` | 要启用的范围：`user`、`project` 或 `local` | `user` |
| `-h, --help`          | 显示命令帮助                            |        |

<h3 id="plugin-disable">
  plugin disable
</h3>

禁用 plugin 而不卸载它。当另一个已启用的 plugin [依赖于](/docs/zh-CN/plugin-dependencies#enable-or-disable-a-plugin-with-dependencies)目标时失败。错误消息包括一个链式命令，首先禁用每个依赖项。

```bash theme={null}
claude plugin disable <plugin> [options]
```

**参数：**

* `<plugin>`：Plugin 名称或 `plugin-name@marketplace-name`

**选项：**

| 选项                    | 描述                                | 默认值    |
| :-------------------- | :-------------------------------- | :----- |
| `-s, --scope <scope>` | 要禁用的范围：`user`、`project` 或 `local` | `user` |
| `-h, --help`          | 显示命令帮助                            |        |

<h3 id="plugin-update">
  plugin update
</h3>

将 plugin 更新到最新版本。

```bash theme={null}
claude plugin update <plugin> [options]
```

**参数：**

* `<plugin>`：Plugin 名称或 `plugin-name@marketplace-name`

**选项：**

| 选项                    | 描述                                          | 默认值    |
| :-------------------- | :------------------------------------------ | :----- |
| `-s, --scope <scope>` | 要更新的范围：`user`、`project`、`local` 或 `managed` | `user` |
| `-h, --help`          | 显示命令帮助                                      |        |

***

<h3 id="plugin-list">
  plugin list
</h3>

列出已安装的 plugins 及其版本、源市场和启用状态。

```bash theme={null}
claude plugin list [options]
```

**选项：**

| 选项            | 描述                            | 默认值 |
| :------------ | :---------------------------- | :-- |
| `--json`      | 输出为 JSON                      |     |
| `--available` | 包括来自市场的可用 plugins。需要 `--json` |     |
| `-h, --help`  | 显示命令帮助                        |     |

在交互式会话中，`/plugin list` 打印相同的列表内联。交互式形式接受 `--enabled` 或 `--disabled` 以仅显示处于该状态的 plugins，以及 `ls` 作为 `list` 的简写。

<h3 id="plugin-details">
  plugin details
</h3>

显示 plugin 的组件清单和预计令牌成本。输出列出 plugin 贡献的所有组件，分组为 Skills、Agents、Hooks、MCP servers 和 LSP servers，以及它为每个会话添加多少令牌的估计。Skills 组包括 `skills/` 和 `commands/` 条目。

```bash theme={null}
claude plugin details <name>
```

**参数：**

* `<name>`：Plugin 名称或 `plugin-name@marketplace-name`

**选项：**

| 选项           | 描述     | 默认值 |
| :----------- | :----- | :-- |
| `-h, --help` | 显示命令帮助 |     |

输出为每个组件显示两个成本数字：

* **Always-on：** plugin 的列表文本（如 skill 描述、agent 描述和命令名称）添加到每个会话的令牌，无论是否有任何组件触发。
* **On-invoke：** 组件触发时的成本令牌。按组件显示，而不是作为 plugin 总计，因为典型会话仅调用组件的子集。

此示例显示具有两个 skills 的 plugin 的输出外观：

```
dependency-guard 1.2.0
  Dependency analysis for Claude Code sessions
  Source: dependency-guard@example-marketplace

Component inventory
  Skills (2)  scan-dependencies, review-changes
  Agents (0)
  Hooks (1)  (harness-only — no model context cost)
  MCP servers (0)
  LSP servers (0)

Projected token cost
  Always-on:   ~180 tok   added to every session

Per-component (rounded)
  component            always-on  on-invoke
  scan-dependencies        ~100      ~2400
  review-changes            ~80      ~1800

  On-invoke cost is paid each time a skill or agent fires.
  Token counts are estimates and may differ from actual usage.
```

always-on 总计通过您的活跃模型的 `count_tokens` API 计算。按组件的数字按比例从该总计缩放。如果 API 无法访问，该命令会回退到基于字符的估计。

<h3 id="plugin-tag">
  plugin tag
</h3>

为当前目录中的 plugin 创建发布 git 标签。从 plugin 的文件夹内运行。请参阅[标记 plugin 发布](/docs/zh-CN/plugin-dependencies#tag-plugin-releases-for-version-resolution)。

```bash theme={null}
claude plugin tag [options]
```

**选项：**

| 选项            | 描述                   | 默认值 |
| :------------ | :------------------- | :-- |
| `--push`      | 创建标签后将其推送到远程         |     |
| `--dry-run`   | 打印将被标记的内容而不创建标签      |     |
| `-f, --force` | 即使工作树是脏的或标签已存在，也创建标签 |     |
| `-h, --help`  | 显示命令帮助               |     |

***

<h2 id="debugging-and-development-tools">
  调试和开发工具
</h2>

<h3 id="debugging-commands">
  调试命令
</h3>

使用 `claude --debug` 查看 plugin 加载详情：

这显示：

* 正在加载哪些 plugins
* plugin 清单中的任何错误
* Skill、agent 和 hook 注册
* MCP server 初始化

<h3 id="common-issues">
  常见问题
</h3>

| 问题                                  | 原因                         | 解决方案                                                                                                                            |
| :---------------------------------- | :------------------------- | :------------------------------------------------------------------------------------------------------------------------------ |
| Plugin 未加载                          | 无效的 `plugin.json`          | 运行 `claude plugin validate` 或 `/plugin validate` 检查 `plugin.json`、skill/agent/command frontmatter 和 `hooks/hooks.json` 的语法和架构错误 |
| Skills 未出现                          | 目录结构错误                     | 确保 `skills/` 或 `commands/` 在根目录，而不是在 `.claude-plugin/` 中                                                                        |
| Hooks 未触发                           | 脚本不可执行                     | 运行 `chmod +x script.sh`                                                                                                         |
| MCP server 失败                       | 缺少 `${CLAUDE_PLUGIN_ROOT}` | 对所有 plugin 路径使用变量                                                                                                               |
| 路径错误                                | 使用了绝对路径                    | 所有路径必须是相对的，并以 `./` 开头                                                                                                           |
| LSP `Executable not found in $PATH` | 语言服务器未安装                   | 安装二进制文件（例如，`npm install -g typescript-language-server typescript`）                                                              |

<h3 id="example-error-messages">
  示例错误消息
</h3>

**清单验证错误**：

* `Invalid JSON syntax: Unexpected token } in JSON at position 142`：检查缺少的逗号、多余的逗号或未引用的字符串
* `Plugin has an invalid manifest file at .claude-plugin/plugin.json. Validation errors: name: Required`：缺少必需字段
* `Plugin has a corrupt manifest file at .claude-plugin/plugin.json. JSON parse error: ...`：JSON 语法错误

**Plugin 加载错误**：

* `Warning: No commands found in plugin my-plugin custom directory: ./cmds. Expected .md files or SKILL.md in subdirectories.`：命令路径存在但不包含有效的命令文件
* `Plugin directory not found at path: ./plugins/my-plugin. Check that the marketplace entry has the correct path.`：marketplace.json 中的 `source` 路径指向不存在的目录
* `Plugin my-plugin has conflicting manifests: both plugin.json and marketplace entry specify components.`：删除重复的组件定义或删除 marketplace 条目中的 `strict: false`

<h3 id="hook-troubleshooting">
  Hook 故障排除
</h3>

**Hook 脚本未执行**：

1. 检查脚本是否可执行：`chmod +x ./scripts/your-script.sh`
2. 验证 shebang 行：第一行应该是 `#!/bin/bash` 或 `#!/usr/bin/env bash`
3. 检查路径是否使用 `${CLAUDE_PLUGIN_ROOT}`：`"command": "\"${CLAUDE_PLUGIN_ROOT}\"/scripts/your-script.sh"`
4. 手动测试脚本：`./scripts/your-script.sh`

**Hook 未在预期事件上触发**：

1. 验证事件名称是否正确（区分大小写）：`PostToolUse`，而不是 `postToolUse`
2. 检查匹配器模式是否与您的工具匹配：`"matcher": "Write|Edit"` 用于文件操作
3. 确认 hook 类型有效：`command`、`http`、`mcp_tool`、`prompt` 或 `agent`

<h3 id="mcp-server-troubleshooting">
  MCP server 故障排除
</h3>

**Server 未启动**：

1. 检查命令是否存在且可执行
2. 验证所有路径是否使用 `${CLAUDE_PLUGIN_ROOT}` 变量
3. 检查 MCP server 日志：`claude --debug` 显示初始化错误
4. 在 Claude Code 外手动测试 server

**Server 工具未出现**：

1. 确保 server 在 `.mcp.json` 或 `plugin.json` 中正确配置
2. 验证 server 是否正确实现 MCP 协议
3. 检查调试输出中的连接超时

<h3 id="directory-structure-mistakes">
  目录结构错误
</h3>

**症状**：Plugin 加载但组件（skills、agents、hooks）缺失。

**正确结构**：组件必须在 plugin 根目录，而不是在 `.claude-plugin/` 内。只有 `plugin.json` 属于 `.claude-plugin/`。

```text theme={null}
my-plugin/
├── .claude-plugin/
│   └── plugin.json      ← 仅清单在此处
├── commands/            ← 在根级别
├── agents/              ← 在根级别
└── hooks/               ← 在根级别
```

如果您的组件在 `.claude-plugin/` 内，请将它们移到 plugin 根目录。

**调试清单**：

1. 运行 `claude --debug` 并查找"loading plugin"消息
2. 检查每个组件目录是否在调试输出中列出
3. 验证文件权限允许读取 plugin 文件

***

<h2 id="distribution-and-versioning-reference">
  分发和版本管理参考
</h2>

<h3 id="version-management">
  版本管理
</h3>

Claude Code 使用 plugin 的版本作为缓存键，以确定是否有可用的更新。当你运行 `/plugin update` 或自动更新触发时，Claude Code 会计算当前版本，如果与已安装的版本匹配，则跳过更新。

版本从以下第一个设置的字段解析：

1. plugin 的 `plugin.json` 中的 `version` 字段
2. plugin 的 `marketplace.json` 中的市场条目中的 `version` 字段
3. plugin 源的 git 提交 SHA，用于 git 托管市场中的 `github`、`url`、`git-subdir` 和相对路径源
4. `unknown`，用于 `npm` 源或不在 git 仓库内的本地目录

这为你提供了两种方式来对 plugin 进行版本管理：

| 方法            | 如何操作                                     | 更新行为                                                        | 最适合                 |
| :------------ | :--------------------------------------- | :---------------------------------------------------------- | :------------------ |
| **显式版本**      | 在 `plugin.json` 中设置 `"version": "2.1.0"` | 用户仅在你提升此字段时获得更新。推送新提交而不提升它没有效果，`/plugin update` 报告"已是最新版本"。 | 具有稳定发布周期的已发布 plugin |
| **提交 SHA 版本** | 从 `plugin.json` 和市场条目中省略 `version`       | 用户在每次对 plugin 的 git 源进行新提交时获得更新                             | 正在积极开发的内部或团队 plugin |

<Warning>
  如果你在 `plugin.json` 中设置 `version`，你必须在每次想让用户接收更改时提升它。仅推送新提交是不够的，因为 Claude Code 看到相同的版本字符串并保留缓存副本。如果你迭代速度很快，请不设置 `version`，以便改用 git 提交 SHA。
</Warning>

如果你使用显式版本，请遵循[语义版本控制](https://semver.org)（`MAJOR.MINOR.PATCH`）：为破坏性更改提升 MAJOR，为新功能提升 MINOR，为错误修复提升 PATCH。在 `CHANGELOG.md` 中记录更改。

***

<h2 id="see-also">
  另请参阅
</h2>

* [Plugins](/docs/zh-CN/plugins) - 教程和实际用法
* [Plugin marketplaces](/docs/zh-CN/plugin-marketplaces) - 创建和管理市场
* [Skills](/docs/zh-CN/skills) - Skill 开发详情
* [Subagents](/docs/zh-CN/sub-agents) - Agent 配置和功能
* [Hooks](/docs/zh-CN/hooks) - 事件处理和自动化
* [MCP](/docs/zh-CN/mcp) - 外部工具集成
* [Settings](/docs/zh-CN/settings) - Plugins 的配置选项