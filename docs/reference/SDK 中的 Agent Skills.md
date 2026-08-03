 ## Documentation Index
 Fetch the complete documentation index at httpscode.claude.comdocsllms.txt
 Use this file to discover all available pages before exploring further.

# SDK 中的 Agent Skills

 使用 Claude Agent SDK 中的 Agent Skills 扩展 Claude 的专业能力

h2 id=overview
  概述
h2

Agent Skills 通过专业能力扩展 Claude，Claude 会在相关时自动调用这些能力。Skills 被打包为 `SKILL.md` 文件，包含说明、描述和可选的支持资源。

有关 Skills 的全面信息，包括优势、架构和编写指南，请参阅 [Agent Skills 概述](httpsplatform.claude.comdocszh-CNagents-and-toolsagent-skillsoverview)。

h2 id=how-skills-work-with-the-sdk
  Skills 如何与 SDK 配合使用
h2

使用 Claude Agent SDK 时，Skills 的工作方式如下：

1. 定义为文件系统工件：在特定目录（`.claudeskills`）中创建为 `SKILL.md` 文件
2. 从文件系统加载：Skills 从由 `settingSources`（TypeScript）或 `setting_sources`（Python）管理的文件系统位置加载
3. 自动发现：加载文件系统设置后，在启动时从用户和项目目录发现 Skill 元数据；触发时加载完整内容
4. 由模型调用：Claude 根据上下文自动选择何时使用它们
5. 通过 `skills` 选项过滤：发现的 Skills 默认启用。传递 Skill 名称列表、`all` 或 `[]` 来控制会话中可用的 Skills

与子代理（可以通过编程方式定义）不同，Skills 必须创建为文件系统工件。SDK 不提供用于注册 Skills 的编程 API。

Note
  Skills 通过文件系统设置源发现。使用默认 `query()` 选项时，SDK 加载用户和项目源，因此 `~.claudeskills`、`cwd.claudeskills` 和 `cwd` 到存储库根目录之间任何父目录中的 `.claudeskills` 中的 Skills 可用。如果显式设置 `settingSources`，请包含 `'user'` 或 `'project'` 以保持 Skill 发现，或使用 [`plugins` 选项](docszh-CNagent-sdkplugins) 从特定路径加载 Skills。
Note

h2 id=using-skills-with-the-sdk
  在 SDK 中使用 Skills
h2

在 `query()` 上设置 `skills` 选项以控制会话中可用的 Skills。省略时，发现的 Skills 启用且 Skill 工具可用，与 CLI 行为匹配。传递 `all` 以启用每个发现的 Skill，传递 Skill 名称列表以仅启用那些，或传递 `[]` 以禁用所有。设置 `skills` 时，SDK 自动将 Skill 工具添加到 `allowedTools`。如果您还传递显式 `tools` 列表，请在该列表中包含 `Skill`，以便 Claude 可以调用 skills。

配置后，Claude 自动从文件系统发现 Skills 并在与用户请求相关时调用它们。

CodeGroup
  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import query, ClaudeAgentOptions


  async def main()
      options = ClaudeAgentOptions(
          cwd=pathtoproject,  # Project with .claudeskills
          setting_sources=[user, project],  # Load Skills from filesystem
          skills=all,  # Enable every discovered Skill
          allowed_tools=[Read, Write, Bash],
      )

      async for message in query(
          prompt=Help me process this PDF document, options=options
      )
          print(message)


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query } from @anthropic-aiclaude-agent-sdk;

  for await (const message of query({
    prompt Help me process this PDF document,
    options {
      cwd pathtoproject,  Project with .claudeskills
      settingSources [user, project],  Load Skills from filesystem
      skills all,  Enable every discovered Skill
      allowedTools [Read, Write, Bash]
    }
  })) {
    console.log(message);
  }
  ```
CodeGroup

要仅启用特定 Skills，请传递它们的名称。名称与 `SKILL.md` 中的 `name` 字段或 Skill 的目录名称匹配。对于插件提供的 Skills，使用 `pluginskill`。

CodeGroup
  ```python Python theme={null}
  options = ClaudeAgentOptions(skills=[pdf, docx])
  ```

  ```typescript TypeScript theme={null}
  const options = { skills [pdf, docx] };
  ```
CodeGroup

`skills` 选项是上下文过滤器，不是沙箱。未列出的 Skills 对模型隐藏，并被 Skill 工具拒绝，但它们的文件仍在磁盘上，可通过 Read 和 Bash 访问。

h2 id=skill-locations
  Skill 位置
h2

Skills 根据您的 `settingSources``setting_sources` 配置从文件系统目录加载：

 项目 Skills（`.claudeskills`）：通过 git 与您的团队共享 - 当 `setting_sources` 包含 `project` 时加载
 用户 Skills（`~.claudeskills`）：跨所有项目的个人 Skills - 当 `setting_sources` 包含 `user` 时加载
 插件 Skills：与已安装的 Claude Code 插件捆绑

h2 id=creating-skills
  创建 Skills
h2

Skills 定义为包含带有 YAML frontmatter 和 Markdown 内容的 `SKILL.md` 文件的目录。`description` 字段确定 Claude 何时调用您的 Skill。

示例目录结构：

```bash theme={null}
.claudeskillsprocessing-pdfs
└── SKILL.md
```

有关创建 Skills 的完整指导，包括 SKILL.md 结构、多文件 Skills 和示例，请参阅：

 [Claude Code 中的 Agent Skills](docszh-CNskills)：包含示例的完整指南
 [Agent Skills 最佳实践](httpsplatform.claude.comdocsenagents-and-toolsagent-skillsbest-practices)：编写指南和命名约定

h2 id=tool-restrictions
  工具限制
h2

Note
  SKILL.md 中的 `allowed-tools` frontmatter 字段仅在直接使用 Claude Code CLI 时受支持。通过 SDK 使用 Skills 时不适用。

  使用 SDK 时，通过查询配置中的主 `allowedTools` 选项控制工具访问。
Note

要在 SDK 应用程序中控制 Skills 的工具访问，使用 `allowedTools` 预先批准特定工具。没有 `canUseTool` 回调时，列表中没有的任何内容都被拒绝：

Note
  假设第一个示例中的导入语句在以下代码片段中。
Note

CodeGroup
  ```python Python theme={null}
  options = ClaudeAgentOptions(
      setting_sources=[user, project],  # Load Skills from filesystem
      skills=all,
      allowed_tools=[Read, Grep, Glob],
  )

  async for message in query(prompt=Analyze the codebase structure, options=options)
      print(message)
  ```

  ```typescript TypeScript theme={null}
  for await (const message of query({
    prompt Analyze the codebase structure,
    options {
      settingSources [user, project],  Load Skills from filesystem
      skills all,
      allowedTools [Read, Grep, Glob],
      permissionMode dontAsk  Deny anything not in allowedTools
    }
  })) {
    console.log(message);
  }
  ```
CodeGroup

h2 id=discovering-available-skills
  发现可用的 Skills
h2

要查看 SDK 应用程序中可用的 Skills，只需询问 Claude：

CodeGroup
  ```python Python theme={null}
  options = ClaudeAgentOptions(
      setting_sources=[user, project],  # Load Skills from filesystem
      skills=all,
  )

  async for message in query(prompt=What Skills are available, options=options)
      print(message)
  ```

  ```typescript TypeScript theme={null}
  for await (const message of query({
    prompt What Skills are available,
    options {
      settingSources [user, project],  Load Skills from filesystem
      skills all
    }
  })) {
    console.log(message);
  }
  ```
CodeGroup

Claude 将根据您当前的工作目录和已安装的插件列出可用的 Skills。

h2 id=testing-skills
  测试 Skills
h2

通过提出与其描述匹配的问题来测试 Skills：

CodeGroup
  ```python Python theme={null}
  options = ClaudeAgentOptions(
      cwd=pathtoproject,
      setting_sources=[user, project],  # Load Skills from filesystem
      skills=all,
      allowed_tools=[Read, Bash],
  )

  async for message in query(prompt=Extract text from invoice.pdf, options=options)
      print(message)
  ```

  ```typescript TypeScript theme={null}
  for await (const message of query({
    prompt Extract text from invoice.pdf,
    options {
      cwd pathtoproject,
      settingSources [user, project],  Load Skills from filesystem
      skills all,
      allowedTools [Read, Bash]
    }
  })) {
    console.log(message);
  }
  ```
CodeGroup

如果描述与您的请求匹配，Claude 会自动调用相关的 Skill。

h2 id=troubleshooting
  故障排除
h2

h3 id=skills-not-found
  找不到 Skills
h3

检查 settingSources 配置：Skills 通过 `user` 和 `project` 设置源发现。如果显式设置 `settingSources``setting_sources` 并省略这些源，Skills 不会加载：

CodeGroup
  ```python Python theme={null}
  # Skills not loaded setting_sources excludes user and project
  options = ClaudeAgentOptions(setting_sources=[], skills=all)

  # Skills loaded user and project sources included
  options = ClaudeAgentOptions(
      setting_sources=[user, project],
      skills=all,
  )
  ```

  ```typescript TypeScript theme={null}
   Skills not loaded settingSources excludes user and project
  const options = {
    settingSources [],
    skills all
  };

   Skills loaded user and project sources included
  const options = {
    settingSources [user, project],
    skills all
  };
  ```
CodeGroup

有关 `settingSources``setting_sources` 的更多详情，请参阅 [TypeScript SDK 参考](docszh-CNagent-sdktypescript#settingsource) 或 [Python SDK 参考](docszh-CNagent-sdkpython#settingsource)。

检查工作目录：SDK 从 `cwd` 选项中的 `.claudeskills` 以及直到仓库根目录的每个父目录加载 Skills。确保 `cwd` 指向包含 `.claudeskills` 的目录或其下方目录，且在同一仓库内：

CodeGroup
  ```python Python theme={null}
  # Ensure your cwd points to the directory containing .claudeskills
  options = ClaudeAgentOptions(
      cwd=pathtoproject,  # .claudeskills here or in a parent directory
      setting_sources=[user, project],  # Loads skills from these sources
      skills=all,
  )
  ```

  ```typescript TypeScript theme={null}
   Ensure your cwd points to the directory containing .claudeskills
  const options = {
    cwd pathtoproject,  .claudeskills here or in a parent directory
    settingSources [user, project],  Loads skills from these sources
    skills all
  };
  ```
CodeGroup

有关完整模式，请参阅上面的在 SDK 中使用 Skills部分。

验证文件系统位置：

```bash theme={null}
# Check project Skills
ls .claudeskillsSKILL.md

# Check personal Skills
ls ~.claudeskillsSKILL.md
```

h3 id=skill-not-being-used
  Skill 未被使用
h3

检查 `skills` 选项：如果传递了 `skills` 列表，确认 Skill 的名称已包含。传递 `[]` 会禁用所有 Skills。

检查描述：确保它具体且包含相关关键字。有关编写有效描述的指导，请参阅 [Agent Skills 最佳实践](httpsplatform.claude.comdocsenagents-and-toolsagent-skillsbest-practices#writing-effective-descriptions)。

h3 id=additional-troubleshooting
  其他故障排除
h3

有关一般 Skills 故障排除（YAML 语法、调试等），请参阅 [Claude Code Skills 故障排除部分](docszh-CNskills#troubleshooting)。

h2 id=related-documentation
  相关文档
h2

h3 id=skills-guides
  Skills 指南
h3

 [Claude Code 中的 Agent Skills](docszh-CNskills)：包含创建、示例和故障排除的完整 Skills 指南
 [Agent Skills 概述](httpsplatform.claude.comdocsenagents-and-toolsagent-skillsoverview)：概念概述、优势和架构
 [Agent Skills 最佳实践](httpsplatform.claude.comdocsenagents-and-toolsagent-skillsbest-practices)：有效 Skills 的编写指南
 [Agent Skills 食谱](httpsplatform.claude.comcookbookskills-notebooks-01-skills-introduction)：示例 Skills 和模板

h3 id=sdk-resources
  SDK 资源
h3

 [SDK 中的子代理](docszh-CNagent-sdksubagents)：具有编程选项的类似文件系统代理
 [SDK 中的 Slash Commands](docszh-CNagent-sdkslash-commands)：用户调用的命令
 [SDK 概述](docszh-CNagent-sdkoverview)：常规 SDK 概念
 [TypeScript SDK 参考](docszh-CNagent-sdktypescript)：完整 API 文档
 [Python SDK 参考](docszh-CNagent-sdkpython)：完整 API 文档
