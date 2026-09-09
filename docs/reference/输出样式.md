> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# 输出样式

> 将 Claude Code 适配用于软件工程之外的用途

输出样式改变 Claude 的响应方式，而不是 Claude 知道什么。它们修改系统提示以设置角色、语气和输出格式。当你在每个回合中不断重新提示相同的语音或格式时，或者当你希望 Claude 充当软件工程师以外的角色时，请使用一个。

自定义输出样式将你的说明添加到系统提示中，并让你选择是否保留 Claude Code 的内置软件工程说明。当你改变 Claude 的通信方式但仍在编码时（例如总是用图表回答），请保留它们。当 Claude 根本不进行软件工程时（例如写作助手或数据分析师），请省略它们。

有关你的项目、约定或代码库的说明，请改用 [CLAUDE.md](/docs/zh-CN/memory)。

<h2 id="built-in-output-styles">
  内置输出样式
</h2>

Claude Code 的**默认**输出样式是现有的系统提示，旨在帮助你高效地完成软件工程任务。

还有三种额外的内置输出样式：

* **Proactive**：Claude 立即执行，做出合理的假设而不是暂停进行常规决策，并倾向于行动而非规划。这提供了比[自动模式](/docs/zh-CN/permission-modes#eliminate-prompts-with-auto-mode)更强的自主执行指导，并且无需更改你的权限模式即可工作，因此你仍然会在工具运行前看到权限提示。

* **Explanatory**：在帮助你完成软件工程任务的同时提供教育性的"Insights"。帮助你理解实现选择和代码库模式。

* **Learning**：协作式的边学边做模式，Claude 不仅会在编码时分享"Insights"，还会要求你自己贡献小的、战略性的代码片段。Claude Code 将在你的代码中添加 `TODO(human)` 标记供你实现。

<h2 id="change-your-output-style">
  更改你的输出样式
</h2>

运行 `/config` 并选择**输出样式**从菜单中选择一种样式。你的选择会保存到[本地项目级别](/docs/zh-CN/settings)的 `.claude/settings.local.json`。

<Note>独立的 `/output-style` 命令在 v2.1.73 中已弃用，在 v2.1.91 中被移除。使用 `/config` 或直接编辑 `outputStyle` 设置。</Note>

要在不使用菜单的情况下设置样式，直接编辑设置文件中的 `outputStyle` 字段：

```json theme={null}
{
  "outputStyle": "Explanatory"
}
```

输出样式是系统提示的一部分，Claude Code 在会话开始时读取一次。更改将在 `/clear` 或新会话后生效。请参阅[Claude Code 如何使用 prompt caching](/docs/zh-CN/prompt-caching#changing-output-style)了解输出样式更改对缓存的影响。

<h2 id="create-a-custom-output-style">
  创建自定义输出样式
</h2>

自定义输出样式是一个 Markdown 文件：frontmatter 用于元数据，然后是要添加到系统提示的说明。

<Steps>
  <Step title="创建一个 Markdown 文件">
    在三个级别之一保存它。文件名成为样式名称，除非你在 frontmatter 中设置 `name`。

    * 用户：`~/.claude/output-styles`
    * 项目：`.claude/output-styles`
    * 托管策略：[托管设置目录](/docs/zh-CN/settings#settings-files)内的 `.claude/output-styles`

    项目输出样式从工作目录和仓库根目录之间的每个 `.claude/output-styles/` 加载。从 v2.1.178 开始，当多个这样的嵌套目录定义了同名样式时，Claude Code 使用最接近工作目录的那个。
  </Step>

  <Step title="添加 frontmatter 和说明">
    决定是否保留 Claude Code 的软件工程说明。如果你改变 Claude 的通信方式但仍希望它以相同的方式编码，请设置 `keep-coding-instructions: true`。如果 Claude 不会进行软件工程，请省略它。

    此示例在保留 Claude 编码行为的同时，在每个解释前面加上一个图表：

    ```markdown theme={null}
    ---
    name: Diagrams first
    description: Lead every explanation with a diagram
    keep-coding-instructions: true
    ---

    When explaining code, architecture, or data flow, start with a Mermaid diagram showing the structure, then explain in prose.

    ## Diagram conventions

    Use `flowchart TD` for control flow and `sequenceDiagram` for request paths. Keep diagrams under 15 nodes.
    ```
  </Step>

  <Step title="切换到你的样式">
    运行 `/config` 并在**输出样式**下选择你的样式。它将在 `/clear` 后或下次启动会话时生效。
  </Step>
</Steps>

[Plugins](/docs/zh-CN/plugins-reference) 也可以在 `output-styles/` 目录中提供输出样式。

<h3 id="frontmatter">
  Frontmatter
</h3>

输出样式文件支持这些 frontmatter 字段：

| Frontmatter                | 目的                                                                                                             | 默认值     |
| :------------------------- | :------------------------------------------------------------------------------------------------------------- | :------ |
| `name`                     | 输出样式的名称，如果不是文件名                                                                                                | 从文件名继承  |
| `description`              | 输出样式的描述，在 `/config` 选择器中显示                                                                                     | 无       |
| `keep-coding-instructions` | 保留 Claude Code 的内置软件工程说明                                                                                       | `false` |
| `force-for-plugin`         | 仅限 Plugin 输出样式：在启用 plugin 时自动应用此样式，无需要求用户选择它。覆盖用户的 `outputStyle` 设置。如果多个启用的 plugin 设置了此项，Claude Code 使用第一个加载的。 | `false` |

<h2 id="how-output-styles-work">
  输出样式如何工作
</h2>

输出样式直接修改 Claude Code 的系统提示。

* 所有输出样式都在系统提示的末尾添加了自己的自定义说明。
* 所有输出样式都会在对话期间触发提醒，让 Claude 遵守输出样式说明。
* 自定义输出样式排除了 Claude Code 的内置软件工程说明，例如如何限定更改范围、编写注释和验证工作，除非 `keep-coding-instructions` 设置为 `true`。

令牌使用情况取决于样式。向系统提示添加说明会增加输入令牌，尽管 prompt caching 在会话中的第一个请求之后会降低这个成本。内置的 Explanatory 和 Learning 样式在设计上比 Default 产生更长的响应，这会增加输出令牌。对于自定义样式，输出令牌使用情况取决于你的说明告诉 Claude 生成什么。

<h2 id="comparisons-to-related-features">
  与相关功能的比较
</h2>

多个功能自定义 Claude Code 的行为方式。输出样式直接修改系统提示并应用于每个响应。其他功能添加说明而不改变默认系统提示，或将其范围限定为特定任务。

| 功能                          | 工作原理                 | 何时使用                       |
| :-------------------------- | :------------------- | :------------------------- |
| 输出样式                        | 修改系统提示               | 你想要每个回合都有不同的角色、语气或默认响应格式   |
| [CLAUDE.md](/docs/zh-CN/memory)  | 在系统提示之后添加用户消息        | Claude 应该始终了解你的项目约定和代码库上下文 |
| `--append-system-prompt`    | 附加到系统提示而不删除任何内容      | 你想要一次性添加单个调用               |
| [Agents](/docs/zh-CN/sub-agents) | 使用自己的系统提示、模型和工具运行子代理 | 你想要一个单独作用域的辅助工具来完成专注的任务    |
| [Skills](/docs/zh-CN/skills)     | 在调用时或相关时加载特定于任务的说明   | 你有一个可重用的工作流                |

<h2 id="related-resources">
  相关资源
</h2>

* [Settings](/docs/zh-CN/settings)：`outputStyle` 字段所在的位置以及设置优先级的工作原理
* [Permission modes](/docs/zh-CN/permission-modes)：Proactive 样式与自动模式的比较方式
* [Plugins](/docs/zh-CN/plugins)：打包和分发输出样式以及 skills、hooks 和 agents
* [Debug your configuration](/docs/zh-CN/debug-your-config)：诊断为什么输出样式没有生效
