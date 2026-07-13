# Agent SDK 中的 Plugins（官方文档本地副本）

> 来源：https://code.claude.com/docs/en/agent-sdk/plugins （中文版，2026-07-13 抓取）
>
> **为何 vendored**：Aide 的插件市场架构依赖一个关键事实——Agent SDK 的 `options.plugins` **只加载显式传入的本地路径**（`type:"local"` 是 SDK 接受的唯一类型），**不自动扫描** `~/.claude/plugins/`、**不读** CLI 的 `installed_plugins.json`。这决定了：
> - Aide 把插件装在自己目录 `~/.claude-code-desktop/claude-agent-sdk/plugins/cache/<市场>/<插件>/<版本>/` 是可行的——SDK 读的是 Aide 经 `options.plugins` 注入的绝对路径，不关心目录位置。`claude-agent-sdk/` 命名空间收拢 Claude 专属产物（插件、市场缓存、启用清单），为后续接入其他 agent 打底。
> - 不存在「SDK 自动加载 CLI 装的插件」造成的双加载：Aide 会话里加载哪些插件，完全由 Aide 的 `enabled-plugins.json` 清单（`~/.claude-code-desktop/claude-agent-sdk/enabled-plugins.json`，sidecar `buildPluginsOption()` 每次 query() 重读）决定。
> - `settingSources:["user","project"]` 和 `skills:"all"` 加载的是散装 skills/settings/agents，**不加载 plugin 包**；plugin 内的 skills 只有把整个 plugin 目录经 `options.plugins` 注入才出现（自动加 `plugin-name:` 前缀）。
>
> 关键证据是文中「使用 plugin skills」节末的 Note：CLI 安装的 plugin 必须手动提供其安装路径才能在 SDK 里用——若 SDK 会自动扫描，这条 Note 就不存在。详见 [marketplace 设计](../superpowers/specs/2026-07-13-marketplace-extension-design.md) 与 `agent-sidecar/src/index.ts` 的 `buildPluginsOption()`。

---

# SDK 中的 Plugins

> 通过 Agent SDK 加载自定义 plugins，以向 agent 会话添加 skills、agents、hooks 和 MCP servers

Plugins 允许你使用可在项目间共享的自定义功能来扩展 Claude Code。通过 Agent SDK，你可以以编程方式从本地目录加载 plugins，以便向 agent 会话添加 skills、agents、hooks 和 MCP servers。

## 什么是 plugins？

Plugins 是 Claude Code 扩展的包，可以包括：

* **Skills**：Claude 自主使用的模型调用功能（也可以使用 `/skill-name` 调用）
* **Agents**：用于特定任务的专门子 agents
* **Hooks**：响应工具使用和其他事件的事件处理程序
* **MCP servers**：通过 Model Context Protocol 的外部工具集成

> `commands/` 目录是旧版格式。对于新 plugins，请使用 `skills/`。Claude Code 继续支持两种格式以实现向后兼容。

有关 plugin 结构和如何创建 plugins 的完整信息，请参阅 [Plugins](https://code.claude.com/docs/zh-CN/plugins)。

## 加载 plugins

通过在选项配置中提供本地文件系统路径来加载 plugins。`type` 字段必须是 `"local"`，**这是 SDK 接受的唯一值**。要使用通过 [marketplace](https://code.claude.com/docs/zh-CN/plugin-marketplaces) 或远程存储库分发的 plugin，请先下载它并提供本地目录路径。SDK 支持从不同位置加载多个 plugins。

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Hello",
  options: {
    plugins: [
      { type: "local", path: "./my-plugin" },
      { type: "local", path: "/absolute/path/to/another-plugin" }
    ]
  }
})) {
  // Plugin commands, agents, and other features are now available
}
```

```python
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions


async def main():
    async for message in query(
        prompt="Hello",
        options=ClaudeAgentOptions(
            plugins=[
                {"type": "local", "path": "./my-plugin"},
                {"type": "local", "path": "/absolute/path/to/another-plugin"},
            ]
        ),
    ):
        # Plugin commands, agents, and other features are now available
        pass


asyncio.run(main())
```

### 路径规范

Plugin 路径可以是：

* **相对路径**：相对于你的当前工作目录解析（例如，`"./plugins/my-plugin"`）
* **绝对路径**：完整文件系统路径（例如，`"/home/user/plugins/my-plugin"`）

> 路径应指向 plugin 的根目录：`skills/`、`agents/`、`hooks/`、`commands/`（旧版）或 `.claude-plugin/` 的父目录，而不是子目录。

## 验证 plugin 安装

当 plugins 成功加载时，它们会出现在系统初始化消息中。你可以验证你的 plugins 是否可用：

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Hello",
  options: {
    plugins: [{ type: "local", path: "./my-plugin" }]
  }
})) {
  if (message.type === "system" && message.subtype === "init") {
    // 检查已加载的 plugins
    console.log("Plugins:", message.plugins);
    // 示例: [{ name: "my-plugin", path: "./my-plugin" }]

    // Plugin skills 出现时带有 plugin 名称作为前缀
    console.log("Skills:", message.skills);
    // 示例: ["my-plugin:greet"]

    // Plugin 命令使用相同的前缀，skills 也会出现在这里
    console.log("Commands:", message.slash_commands);
    // 示例: ["compact", "context", "my-plugin:custom-command", "my-plugin:greet"]
  }
}
```

```python
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions, SystemMessage


async def main():
    async for message in query(
        prompt="Hello",
        options=ClaudeAgentOptions(
            plugins=[{"type": "local", "path": "./my-plugin"}]
        ),
    ):
        if isinstance(message, SystemMessage) and message.subtype == "init":
            # 检查已加载的 plugins
            print("Plugins:", message.data.get("plugins"))
            # 示例: [{"name": "my-plugin", "path": "./my-plugin"}]

            # Plugin skills 出现时带有 plugin 名称作为前缀
            print("Skills:", message.data.get("skills"))
            # 示例: ["my-plugin:greet"]

            # Plugin 命令使用相同的前缀，skills 也会出现在这里
            print("Commands:", message.data.get("slash_commands"))
            # 示例: ["compact", "context", "my-plugin:custom-command", "my-plugin:greet"]


asyncio.run(main())
```

## 使用 plugin skills

来自 plugins 的 skills 会自动使用 plugin 名称进行命名空间划分，以避免冲突。要直接调用一个，请在提示中发送 `/plugin-name:skill-name`。

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Load a plugin with a custom /greet skill
for await (const message of query({
  prompt: "/my-plugin:greet", // Use plugin skill with namespace
  options: {
    plugins: [{ type: "local", path: "./my-plugin" }]
  }
})) {
  // Claude executes the custom greeting skill from the plugin
  if (message.type === "assistant") {
    console.log(message.message.content);
  }
}
```

```python
import asyncio
from claude_agent_sdk import query, ClaudeAgentOptions, AssistantMessage, TextBlock


async def main():
    # Load a plugin with a custom /greet skill
    async for message in query(
        prompt="/demo-plugin:greet",  # Use plugin skill with namespace
        options=ClaudeAgentOptions(
            plugins=[{"type": "local", "path": "./plugins/demo-plugin"}]
        ),
    ):
        # Claude executes the custom greeting skill from the plugin
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(f"Claude: {block.text}")


asyncio.run(main())
```

> **如果你通过 CLI 安装了 plugin**（例如，`/plugin install my-plugin@marketplace`），你仍然可以通过提供其安装路径在 SDK 中使用它。检查 `~/.claude/plugins/` 以查找 CLI 安装的 plugins。

## 完整示例

这是一个演示 plugin 加载和使用的完整示例：

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as path from "path";

async function runWithPlugin() {
  const pluginPath = path.join(__dirname, "plugins", "my-plugin");

  console.log("Loading plugin from:", pluginPath);

  for await (const message of query({
    prompt: "What custom commands do you have available?",
    options: {
      plugins: [{ type: "local", path: pluginPath }],
      maxTurns: 3
    }
  })) {
    if (message.type === "system" && message.subtype === "init") {
      console.log("Loaded plugins:", message.plugins);
      console.log("Available skills:", message.skills);
      console.log("Available commands:", message.slash_commands);
    }

    if (message.type === "assistant") {
      console.log("Assistant:", message.message.content);
    }
  }
}

runWithPlugin().catch(console.error);
```

```python
#!/usr/bin/env python3
"""Example demonstrating how to use plugins with the Agent SDK."""

from pathlib import Path
import anyio
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    SystemMessage,
    TextBlock,
    query,
)


async def run_with_plugin():
    """Example using a custom plugin."""
    plugin_path = Path(__file__).parent / "plugins" / "demo-plugin"

    print(f"Loading plugin from: {plugin_path}")

    options = ClaudeAgentOptions(
        plugins=[{"type": "local", "path": str(plugin_path)}],
        max_turns=3,
    )

    async for message in query(
        prompt="What custom commands do you have available?", options=options
    ):
        if isinstance(message, SystemMessage) and message.subtype == "init":
            print(f"Loaded plugins: {message.data.get('plugins')}")
            print(f"Available skills: {message.data.get('skills')}")
            print(f"Available commands: {message.data.get('slash_commands')}")

        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(f"Assistant: {block.text}")


if __name__ == "__main__":
    anyio.run(run_with_plugin)
```

## Plugin 结构参考

Plugin 目录通常包含一个 `.claude-plugin/plugin.json` 清单文件。清单是可选的。省略时，Claude Code 会从目录布局自动发现组件。该目录可以包括：

```text
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # Plugin 清单（可选，不需要它也能自动发现组件）
├── skills/                   # Agent Skills（自主调用或通过 /skill-name）
│   └── my-skill/
│       └── SKILL.md
├── commands/                 # 旧版：改用 skills/ 代替
│   └── custom-cmd.md
├── agents/                   # 自定义 agents
│   └── specialist.md
├── hooks/                    # 事件处理程序
│   └── hooks.json
└── .mcp.json                # MCP 服务器定义
```

有关创建 plugins 的详细信息，请参阅：

* [Plugins](https://code.claude.com/docs/zh-CN/plugins) - 完整的 plugin 开发指南
* [Plugins reference](https://code.claude.com/docs/zh-CN/plugins-reference) - 技术规范和架构

## 常见用例

### 开发和测试

在开发期间加载 plugins，无需全局安装它们：

```typescript
plugins: [{ type: "local", path: "./dev-plugins/my-plugin" }];
```

### 项目特定的扩展

在你的项目存储库中包含 plugins，以实现团队范围的一致性：

```typescript
plugins: [{ type: "local", path: "./project-plugins/team-workflows" }];
```

### 多个 plugin 源

组合来自不同位置的 plugins：

```typescript
plugins: [
  { type: "local", path: "./local-plugin" },
  { type: "local", path: "~/.claude/custom-plugins/shared-plugin" }
];
```

## 故障排除

### Plugin 未加载

如果你的 plugin 未出现在初始化消息中：

1. **检查路径**：确保路径指向 plugin 根目录，即 `skills/`、`agents/`、`hooks/`、`commands/`（旧版）或 `.claude-plugin/` 的父目录
2. **验证 plugin.json**：如果你的 plugin 包含清单文件，确保它具有有效的 JSON 语法
3. **检查文件权限**：确保 plugin 目录可读

### Skills 未出现

如果 plugin skills 不起作用：

1. **使用命名空间**：调用 plugin skills 时使用 `/plugin-name:skill-name` 格式
2. **检查初始化消息**：验证 skill 是否以正确的命名空间出现在 `skills` 列表中
3. **验证 skill 文件**：确保每个 skill 在 `skills/` 下的自己的子目录中都有一个 `SKILL.md` 文件，例如 `skills/my-skill/SKILL.md`

### 路径解析问题

如果相对路径不起作用：

1. **检查工作目录**：相对路径从你的当前工作目录解析
2. **使用绝对路径**：为了可靠性，考虑使用绝对路径
3. **规范化路径**：使用路径实用程序正确构造路径

## 另请参阅

* [Plugins](https://code.claude.com/docs/zh-CN/plugins) - 完整的 plugin 开发指南
* [Plugins reference](https://code.claude.com/docs/zh-CN/plugins-reference) - 技术规范
* [Commands](https://code.claude.com/docs/zh-CN/agent-sdk/slash-commands) - 在 SDK 中使用 slash commands
* [Subagents](https://code.claude.com/docs/zh-CN/agent-sdk/subagents) - 使用专门的 agents
* [Skills](https://code.claude.com/docs/zh-CN/agent-sdk/skills) - 使用 Agent Skills