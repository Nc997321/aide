> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# 使用checkpointing回滚文件更改

> 在agent会话期间跟踪文件更改，并将文件恢复到任何之前的状态

File checkpointing跟踪在agent会话期间通过Write、Edit和NotebookEdit工具进行的文件修改，允许您将文件回滚到任何之前的状态。想要尝试一下？跳转到[交互式示例](#try-it-out)。

使用checkpointing，您可以：

* **撤销不需要的更改**，通过将文件恢复到已知的良好状态
* **探索替代方案**，通过恢复到checkpoint并尝试不同的方法
* **从错误中恢复**，当agent进行不正确的修改时

<Warning>
  只有通过Write、Edit和NotebookEdit工具进行的更改才会被跟踪。通过Bash命令进行的更改（如`echo > file.txt`或`sed -i`）不会被checkpoint系统捕获。
</Warning>

<h2 id="how-checkpointing-works">
  Checkpointing 如何工作
</h2>

启用文件 checkpointing 时，SDK 会在通过 Write、Edit 或 NotebookEdit 工具修改文件之前创建文件备份。响应流中的用户消息包含一个 checkpoint UUID，您可以将其用作恢复点。

Checkpoint 与 agent 用来修改文件的这些内置工具一起工作：

| 工具           | 描述                                    |
| ------------ | ------------------------------------- |
| Write        | 创建新文件或用新内容覆盖现有文件                      |
| Edit         | 对现有文件的特定部分进行有针对性的编辑                   |
| NotebookEdit | 修改 Jupyter notebook（`.ipynb` 文件）中的单元格 |

<Note>
  文件回滚将磁盘上的文件恢复到之前的状态。它不会回滚对话本身。调用 `rewindFiles()`（TypeScript）或 `rewind_files()`（Python）后，对话历史和上下文保持不变。
</Note>

Checkpoint 系统跟踪：

* 会话期间创建的文件
* 会话期间修改的文件
* 修改文件的原始内容

当您回滚到 checkpoint 时，创建的文件被删除，修改的文件被恢复到该点的内容。

<h2 id="implement-checkpointing">
  实现checkpointing
</h2>

要使用文件checkpointing，在您的选项中启用它，从响应流中捕获checkpoint UUID，然后在需要恢复时调用`rewindFiles()`（TypeScript）或`rewind_files()`（Python）。

以下示例显示完整流程：启用checkpointing，从响应流中捕获checkpoint UUID和会话ID，然后稍后恢复会话以回滚文件。下面详细解释了每个步骤。本部分中的示例使用提示"重构身份验证模块"。在包含身份验证模块的项目中运行它们，或更改提示以命名项目中存在的文件，以便您可以观看文件更改并查看回滚如何恢复它们。

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import (
      ClaudeSDKClient,
      ClaudeAgentOptions,
      UserMessage,
      ResultMessage,
  )


  async def main():
      # Step 1: Enable checkpointing
      options = ClaudeAgentOptions(
          enable_file_checkpointing=True,
          permission_mode="acceptEdits",  # Auto-accept file edits without prompting
          extra_args={
              "replay-user-messages": None
          },  # Required to receive checkpoint UUIDs in the response stream
      )

      checkpoint_id = None
      session_id = None

      # Run the query and capture checkpoint UUID and session ID
      async with ClaudeSDKClient(options) as client:
          await client.query("Refactor the authentication module")

          # Step 2: Capture checkpoint UUID from the first user message
          async for message in client.receive_response():
              if isinstance(message, UserMessage) and message.uuid and not checkpoint_id:
                  checkpoint_id = message.uuid
              if isinstance(message, ResultMessage) and not session_id:
                  session_id = message.session_id

      # Step 3: Later, rewind by resuming the session with an empty prompt
      if checkpoint_id and session_id:
          async with ClaudeSDKClient(
              ClaudeAgentOptions(enable_file_checkpointing=True, resume=session_id)
          ) as client:
              await client.query("")  # Empty prompt to open the connection
              async for message in client.receive_response():
                  await client.rewind_files(checkpoint_id)
                  break
          print(f"Rewound to checkpoint: {checkpoint_id}")


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  async function main() {
    // Step 1: Enable checkpointing
    const opts = {
      enableFileCheckpointing: true,
      permissionMode: "acceptEdits" as const, // Auto-accept file edits without prompting
      extraArgs: { "replay-user-messages": null } // Required to receive checkpoint UUIDs in the response stream
    };

    const response = query({
      prompt: "Refactor the authentication module",
      options: opts
    });

    let checkpointId: string | undefined;
    let sessionId: string | undefined;

    // Step 2: Capture checkpoint UUID from the first user message
    for await (const message of response) {
      if (message.type === "user" && message.uuid && !checkpointId) {
        checkpointId = message.uuid;
      }
      if ("session_id" in message && !sessionId) {
        sessionId = message.session_id;
      }
    }

    // Step 3: Later, rewind by resuming the session with an empty prompt
    if (checkpointId && sessionId) {
      const rewindQuery = query({
        prompt: "", // Empty prompt to open the connection
        options: { ...opts, resume: sessionId }
      });

      for await (const msg of rewindQuery) {
        await rewindQuery.rewindFiles(checkpointId);
        break;
      }
      console.log(`Rewound to checkpoint: ${checkpointId}`);
    }
  }

  main();
  ```
</CodeGroup>

<Steps>
  <Step title="启用checkpointing">
    配置您的SDK选项以启用checkpointing并接收checkpoint UUID：

    | 选项                | Python                                      | TypeScript                                    | 描述              |
    | ----------------- | ------------------------------------------- | --------------------------------------------- | --------------- |
    | 启用checkpointing   | `enable_file_checkpointing=True`            | `enableFileCheckpointing: true`               | 跟踪文件更改以便回滚      |
    | 接收checkpoint UUID | `extra_args={"replay-user-messages": None}` | `extraArgs: { 'replay-user-messages': null }` | 需要在流中获取用户消息UUID |

    <CodeGroup>
      ```python Python theme={null}
      options = ClaudeAgentOptions(
          enable_file_checkpointing=True,
          permission_mode="acceptEdits",
          extra_args={"replay-user-messages": None},
      )

      async with ClaudeSDKClient(options) as client:
          await client.query("Refactor the authentication module")
      ```

      ```typescript TypeScript theme={null}
      const response = query({
        prompt: "Refactor the authentication module",
        options: {
          enableFileCheckpointing: true,
          permissionMode: "acceptEdits" as const,
          extraArgs: { "replay-user-messages": null }
        }
      });
      ```
    </CodeGroup>
  </Step>

  <Step title="捕获checkpoint UUID和会话ID">
    设置`replay-user-messages`选项后（如上所示），响应流中的每个用户消息都有一个UUID，用作checkpoint。

    对于大多数用例，捕获第一个用户消息UUID（`message.uuid`）；回滚到它会将所有文件恢复到原始状态。要存储多个checkpoint并回滚到中间状态，请参阅[多个恢复点](#multiple-restore-points)。

    捕获会话ID（`message.session_id`）是可选的；只有在您想在流完成后回滚时才需要它。如果您在处理消息时立即调用`rewindFiles()`（如[Checkpoint before risky operations](#checkpoint-before-risky-operations)中的示例所做的那样），您可以跳过捕获会话ID。

    <CodeGroup>
      ```python Python theme={null}
      checkpoint_id = None
      session_id = None

      async for message in client.receive_response():
          # Capture the first user message UUID as the checkpoint
          if isinstance(message, UserMessage) and message.uuid and checkpoint_id is None:
              checkpoint_id = message.uuid
          # Capture session ID from the result message
          if isinstance(message, ResultMessage):
              session_id = message.session_id
      ```

      ```typescript TypeScript theme={null}
      let checkpointId: string | undefined;
      let sessionId: string | undefined;

      for await (const message of response) {
        // Capture the first user message UUID as the checkpoint
        if (message.type === "user" && message.uuid && !checkpointId) {
          checkpointId = message.uuid;
        }
        // Capture session ID from any message that has it
        if ("session_id" in message) {
          sessionId = message.session_id;
        }
      }
      ```
    </CodeGroup>
  </Step>

  <Step title="回滚文件">
    要在流完成后回滚，使用空提示恢复会话，并使用您的checkpoint UUID调用`rewind_files()`（Python）或`rewindFiles()`（TypeScript）。您也可以在流期间回滚；有关该模式，请参阅[Checkpoint before risky operations](#checkpoint-before-risky-operations)。

    <CodeGroup>
      ```python Python theme={null}
      async with ClaudeSDKClient(
          ClaudeAgentOptions(enable_file_checkpointing=True, resume=session_id)
      ) as client:
          await client.query("")  # Empty prompt to open the connection
          async for message in client.receive_response():
              await client.rewind_files(checkpoint_id)
              break
      ```

      ```typescript TypeScript theme={null}
      const rewindQuery = query({
        prompt: "", // Empty prompt to open the connection
        options: { ...opts, resume: sessionId }
      });

      for await (const msg of rewindQuery) {
        await rewindQuery.rewindFiles(checkpointId);
        break;
      }
      ```
    </CodeGroup>

    如果您捕获了会话ID和checkpoint ID，您也可以从CLI回滚。此命令需要`claude`可执行文件，该文件来自[安装Claude Code](/docs/zh-CN/setup)，不由SDK包安装。SDK为您启用checkpointing，但当您直接运行`claude -p`时，您必须设置`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`环境变量：

    ```bash theme={null}
    CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true claude -p --resume <session-id> --rewind-files <checkpoint-uuid>
    ```

    `--rewind-files`标志不会出现在`claude --help`输出中，但CLI接受它如上所示。
  </Step>
</Steps>

<h2 id="common-patterns">
  常见模式
</h2>

这些模式显示了根据您的用例捕获和使用checkpoint UUID的不同方式。

<h3 id="checkpoint-before-risky-operations">
  Checkpoint before risky operations
</h3>

此模式仅保留最新的checkpoint UUID，在每个agent轮次之前更新它。如果处理过程中出现问题，您可以立即回滚到最后的安全状态并跳出循环。

运行此示例之前，请将`your_revert_condition`（Python）或`yourRevertCondition`（TypeScript）替换为您自己的检查，例如错误检测或验证失败；该占位符在示例中未定义。

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions, UserMessage


  async def main():
      options = ClaudeAgentOptions(
          enable_file_checkpointing=True,
          permission_mode="acceptEdits",
          extra_args={"replay-user-messages": None},
      )

      safe_checkpoint = None

      async with ClaudeSDKClient(options) as client:
          await client.query("Refactor the authentication module")

          async for message in client.receive_response():
              # Update checkpoint before each agent turn starts
              # This overwrites the previous checkpoint. Only keep the latest
              if isinstance(message, UserMessage) and message.uuid:
                  safe_checkpoint = message.uuid

              # Decide when to revert based on your own logic
              # For example: error detection, validation failure, or user input
              if your_revert_condition and safe_checkpoint:
                  await client.rewind_files(safe_checkpoint)
                  # Exit the loop after rewinding, files are restored
                  break


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  async function main() {
    const response = query({
      prompt: "Refactor the authentication module",
      options: {
        enableFileCheckpointing: true,
        permissionMode: "acceptEdits" as const,
        extraArgs: { "replay-user-messages": null }
      }
    });

    let safeCheckpoint: string | undefined;

    for await (const message of response) {
      // Update checkpoint before each agent turn starts
      // This overwrites the previous checkpoint. Only keep the latest
      if (message.type === "user" && message.uuid) {
        safeCheckpoint = message.uuid;
      }

      // Decide when to revert based on your own logic
      // For example: error detection, validation failure, or user input
      if (yourRevertCondition && safeCheckpoint) {
        await response.rewindFiles(safeCheckpoint);
        // Exit the loop after rewinding, files are restored
        break;
      }
    }
  }

  main();
  ```
</CodeGroup>

<h3 id="multiple-restore-points">
  多个恢复点
</h3>

如果Claude在多个轮次中进行更改，您可能想回滚到特定点而不是一直回滚。例如，如果Claude在第一轮重构文件，在第二轮添加测试，您可能想保留重构但撤销测试。

此模式将所有checkpoint UUID存储在带有元数据的数组中。会话完成后，您可以回滚到任何之前的checkpoint：

<CodeGroup>
  ```python Python theme={null}
  import asyncio
  from dataclasses import dataclass
  from datetime import datetime
  from claude_agent_sdk import (
      ClaudeSDKClient,
      ClaudeAgentOptions,
      UserMessage,
      ResultMessage,
  )


  # Store checkpoint metadata for better tracking
  @dataclass
  class Checkpoint:
      id: str
      description: str
      timestamp: datetime


  async def main():
      options = ClaudeAgentOptions(
          enable_file_checkpointing=True,
          permission_mode="acceptEdits",
          extra_args={"replay-user-messages": None},
      )

      checkpoints = []
      session_id = None

      async with ClaudeSDKClient(options) as client:
          await client.query("Refactor the authentication module")

          async for message in client.receive_response():
              if isinstance(message, UserMessage) and message.uuid:
                  checkpoints.append(
                      Checkpoint(
                          id=message.uuid,
                          description=f"After turn {len(checkpoints) + 1}",
                          timestamp=datetime.now(),
                      )
                  )
              if isinstance(message, ResultMessage) and not session_id:
                  session_id = message.session_id

      # Later: rewind to any checkpoint by resuming the session
      if checkpoints and session_id:
          target = checkpoints[0]  # Pick any checkpoint
          async with ClaudeSDKClient(
              ClaudeAgentOptions(enable_file_checkpointing=True, resume=session_id)
          ) as client:
              await client.query("")  # Empty prompt to open the connection
              async for message in client.receive_response():
                  await client.rewind_files(target.id)
                  break
          print(f"Rewound to: {target.description}")


  asyncio.run(main())
  ```

  ```typescript TypeScript theme={null}
  import { query } from "@anthropic-ai/claude-agent-sdk";

  // Store checkpoint metadata for better tracking
  interface Checkpoint {
    id: string;
    description: string;
    timestamp: Date;
  }

  async function main() {
    const opts = {
      enableFileCheckpointing: true,
      permissionMode: "acceptEdits" as const,
      extraArgs: { "replay-user-messages": null }
    };

    const response = query({
      prompt: "Refactor the authentication module",
      options: opts
    });

    const checkpoints: Checkpoint[] = [];
    let sessionId: string | undefined;

    for await (const message of response) {
      if (message.type === "user" && message.uuid) {
        checkpoints.push({
          id: message.uuid,
          description: `After turn ${checkpoints.length + 1}`,
          timestamp: new Date()
        });
      }
      if ("session_id" in message && !sessionId) {
        sessionId = message.session_id;
      }
    }

    // Later: rewind to any checkpoint by resuming the session
    if (checkpoints.length > 0 && sessionId) {
      const target = checkpoints[0]; // Pick any checkpoint
      const rewindQuery = query({
        prompt: "", // Empty prompt to open the connection
        options: { ...opts, resume: sessionId }
      });

      for await (const msg of rewindQuery) {
        await rewindQuery.rewindFiles(target.id);
        break;
      }
      console.log(`Rewound to: ${target.description}`);
    }
  }

  main();
  ```
</CodeGroup>

<h2 id="try-it-out">
  尝试一下
</h2>

此完整示例创建一个小实用程序文件，让agent添加文档注释，向您显示更改，然后询问您是否想回滚。

在开始之前，请确保您已[安装Claude Agent SDK](/docs/zh-CN/agent-sdk/quickstart)。

<Steps>
  <Step title="创建测试文件">
    创建一个名为`utils.py`（Python）或`utils.ts`（TypeScript）的新文件，并粘贴以下代码：

    <CodeGroup>
      ```python utils.py theme={null}
      def add(a, b):
          return a + b


      def subtract(a, b):
          return a - b


      def multiply(a, b):
          return a * b


      def divide(a, b):
          if b == 0:
              raise ValueError("Cannot divide by zero")
          return a / b
      ```

      ```typescript utils.ts theme={null}
      export function add(a: number, b: number): number {
        return a + b;
      }

      export function subtract(a: number, b: number): number {
        return a - b;
      }

      export function multiply(a: number, b: number): number {
        return a * b;
      }

      export function divide(a: number, b: number): number {
        if (b === 0) {
          throw new Error("Cannot divide by zero");
        }
        return a / b;
      }
      ```
    </CodeGroup>
  </Step>

  <Step title="运行交互式示例">
    在与您的实用程序文件相同的目录中创建一个名为`try_checkpointing.py`（Python）或`try_checkpointing.ts`（TypeScript）的新文件，并粘贴以下代码。

    此脚本要求Claude向您的实用程序文件添加doc注释，然后为您提供回滚和恢复原始文件的选项。

    <CodeGroup>
      ```python try_checkpointing.py theme={null}
      import asyncio
      from claude_agent_sdk import (
          ClaudeSDKClient,
          ClaudeAgentOptions,
          UserMessage,
          ResultMessage,
      )


      async def main():
          # Configure the SDK with checkpointing enabled
          # - enable_file_checkpointing: Track file changes for rewinding
          # - permission_mode: Auto-accept file edits without prompting
          # - extra_args: Required to receive user message UUIDs in the stream
          options = ClaudeAgentOptions(
              enable_file_checkpointing=True,
              permission_mode="acceptEdits",
              extra_args={"replay-user-messages": None},
          )

          checkpoint_id = None  # Store the user message UUID for rewinding
          session_id = None  # Store the session ID for resuming

          print("Running agent to add doc comments to utils.py...\n")

          # Run the agent and capture checkpoint data from the response stream
          async with ClaudeSDKClient(options) as client:
              await client.query("Add doc comments to utils.py")

              async for message in client.receive_response():
                  # Capture the first user message UUID - this is our restore point
                  if isinstance(message, UserMessage) and message.uuid and not checkpoint_id:
                      checkpoint_id = message.uuid
                  # Capture the session ID so we can resume later
                  if isinstance(message, ResultMessage):
                      session_id = message.session_id

          print("Done! Open utils.py to see the added doc comments.\n")

          # Ask the user if they want to rewind the changes
          if checkpoint_id and session_id:
              response = input("Rewind to remove the doc comments? (y/n): ")

              if response.lower() == "y":
                  # Resume the session with an empty prompt, then rewind
                  async with ClaudeSDKClient(
                      ClaudeAgentOptions(enable_file_checkpointing=True, resume=session_id)
                  ) as client:
                      await client.query("")  # Empty prompt opens the connection
                      async for message in client.receive_response():
                          await client.rewind_files(checkpoint_id)  # Restore files
                          break

                  print(
                      "\n✓ File restored! Open utils.py to verify the doc comments are gone."
                  )
              else:
                  print("\nKept the modified file.")


      asyncio.run(main())
      ```

      ```typescript try_checkpointing.ts theme={null}
      import { query } from "@anthropic-ai/claude-agent-sdk";
      import * as readline from "readline";

      async function main() {
        // Configure the SDK with checkpointing enabled
        // - enableFileCheckpointing: Track file changes for rewinding
        // - permissionMode: Auto-accept file edits without prompting
        // - extraArgs: Required to receive user message UUIDs in the stream
        const opts = {
          enableFileCheckpointing: true,
          permissionMode: "acceptEdits" as const,
          extraArgs: { "replay-user-messages": null }
        };

        let sessionId: string | undefined; // Store the session ID for resuming
        let checkpointId: string | undefined; // Store the user message UUID for rewinding

        console.log("Running agent to add doc comments to utils.ts...\n");

        // Run the agent and capture checkpoint data from the response stream
        const response = query({
          prompt: "Add doc comments to utils.ts",
          options: opts
        });

        for await (const message of response) {
          // Capture the first user message UUID - this is our restore point
          if (message.type === "user" && message.uuid && !checkpointId) {
            checkpointId = message.uuid;
          }
          // Capture the session ID so we can resume later
          if ("session_id" in message) {
            sessionId = message.session_id;
          }
        }

        console.log("Done! Open utils.ts to see the added doc comments.\n");

        // Ask the user if they want to rewind the changes
        if (checkpointId && sessionId) {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });

          const answer = await new Promise<string>((resolve) => {
            rl.question("Rewind to remove the doc comments? (y/n): ", resolve);
          });
          rl.close();

          if (answer.toLowerCase() === "y") {
            // Resume the session with an empty prompt, then rewind
            const rewindQuery = query({
              prompt: "", // Empty prompt opens the connection
              options: { ...opts, resume: sessionId }
            });

            for await (const msg of rewindQuery) {
              await rewindQuery.rewindFiles(checkpointId); // Restore files
              break;
            }

            console.log("\n✓ File restored! Open utils.ts to verify the doc comments are gone.");
          } else {
            console.log("\nKept the modified file.");
          }
        }
      }

      main();
      ```
    </CodeGroup>

    此示例演示了完整的checkpointing工作流：

    1. **启用checkpointing**：使用`enable_file_checkpointing=True`和`permission_mode="acceptEdits"`配置SDK以自动批准文件编辑
    2. **捕获checkpoint数据**：当agent运行时，存储第一个用户消息UUID（您的恢复点）和会话ID
    3. **提示回滚**：agent完成后，检查您的实用程序文件以查看doc注释，然后决定是否要撤销更改
    4. **恢复和回滚**：如果是，使用空提示恢复会话并调用`rewind_files()`以恢复原始文件
  </Step>

  <Step title="运行示例">
    从与您的实用程序文件相同的目录运行脚本。

    <Tip>
      在运行脚本之前，在您的IDE或编辑器中打开您的实用程序文件（`utils.py`或`utils.ts`）。当agent添加doc注释时，您将看到文件实时更新，然后当您选择回滚时恢复到原始状态。
    </Tip>

    <Tabs>
      <Tab title="Python">
        ```bash theme={null}
        python try_checkpointing.py
        ```
      </Tab>

      <Tab title="TypeScript">
        ```bash theme={null}
        npx tsx try_checkpointing.ts
        ```
      </Tab>
    </Tabs>

    您将看到agent添加doc注释，然后出现一个提示，询问您是否想回滚。如果您选择是，文件将恢复到其原始状态。
  </Step>
</Steps>

<h2 id="limitations">
  限制
</h2>

文件checkpointing有以下限制：

| 限制                         | 描述                    |
| -------------------------- | --------------------- |
| 仅Write/Edit/NotebookEdit工具 | 通过Bash命令进行的更改不被跟踪     |
| 相同会话                       | Checkpoint与创建它们的会话相关联 |
| 仅文件内容                      | 创建、移动或删除目录不会通过回滚撤销    |
| 本地文件                       | 远程或网络文件不被跟踪           |

<h2 id="troubleshooting">
  故障排除
</h2>

<h3 id="checkpointing-options-not-recognized">
  Checkpointing选项未被识别
</h3>

如果`enableFileCheckpointing`或`rewindFiles()`不可用，您可能使用的是较旧的SDK版本。

**解决方案**：更新到最新的SDK版本：

* **Python**：`pip install --upgrade claude-agent-sdk`
* **TypeScript**：`npm install @anthropic-ai/claude-agent-sdk@latest`

<h3 id="user-messages-don’t-have-uuids">
  用户消息没有UUID
</h3>

如果`message.uuid`是`undefined`或缺失，您没有接收checkpoint UUID。

**原因**：未设置`replay-user-messages`选项。

**解决方案**：将`extra_args={"replay-user-messages": None}`（Python）或`extraArgs: { 'replay-user-messages': null }`（TypeScript）添加到您的选项中。

<h3 id="no-file-checkpoint-found-for-message-error">
  "No file checkpoint found for message"错误
</h3>

当指定的用户消息UUID的checkpoint数据不存在时，会发生此错误。

**常见原因**：

* 文件checkpointing在原始会话上未启用（`enable_file_checkpointing`或`enableFileCheckpointing`未设置为`true`）
* 会话在尝试恢复和回滚之前未正确完成

**解决方案**：确保在原始会话上设置了`enable_file_checkpointing=True`（Python）或`enableFileCheckpointing: true`（TypeScript），然后使用示例中显示的模式：捕获第一个用户消息UUID，完全完成会话，然后使用空提示恢复并调用`rewindFiles()`一次。

<h3 id="file-rewinding-is-not-enabled-error">
  "File rewinding is not enabled"错误
</h3>

当您尝试在未启用checkpointing的情况下执行非交互式回滚时，会发生此错误：运行不带`--rewind-files`的裸`claude -p`，或运行SDK会话（包括已恢复的会话），其选项未启用checkpointing。SDK仅在启用了`enable_file_checkpointing`（Python）或`enableFileCheckpointing`（TypeScript）的会话执行回滚时，才在内部设置`CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`环境变量；裸CLI永远不会设置它。

**解决方案**：对于裸CLI，在运行命令时设置环境变量：

```bash theme={null}
CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true claude -p --resume <session-id> --rewind-files <checkpoint-uuid>
```

对于SDK，在已恢复的会话上设置`enable_file_checkpointing=True`（Python）或`enableFileCheckpointing: true`（TypeScript），如本页的示例所示。

<h3 id="processtransport-is-not-ready-for-writing-error">
  "ProcessTransport is not ready for writing"错误
</h3>

当您在完成响应迭代后调用`rewindFiles()`或`rewind_files()`时，会发生此错误。当循环完成时，与CLI进程的连接关闭。

**解决方案**：使用空提示恢复会话，然后在新查询上调用rewind：

<CodeGroup>
  ```python Python theme={null}
  # Resume session with empty prompt, then rewind
  async with ClaudeSDKClient(
      ClaudeAgentOptions(enable_file_checkpointing=True, resume=session_id)
  ) as client:
      await client.query("")
      async for message in client.receive_response():
          await client.rewind_files(checkpoint_id)
          break
  ```

  ```typescript TypeScript theme={null}
  // Resume session with empty prompt, then rewind
  const rewindQuery = query({
    prompt: "",
    options: { ...opts, resume: sessionId }
  });

  for await (const msg of rewindQuery) {
    await rewindQuery.rewindFiles(checkpointId);
    break;
  }
  ```
</CodeGroup>

<h2 id="next-steps">
  后续步骤
</h2>

* **[Sessions](/docs/zh-CN/agent-sdk/sessions)**：了解如何恢复会话，这是在流完成后回滚所必需的。涵盖会话ID、恢复对话和会话分叉。
* **[Permissions](/docs/zh-CN/agent-sdk/permissions)**：配置Claude可以使用哪些工具以及如何批准文件修改。如果您想更好地控制何时进行编辑，这很有用。
* **[TypeScript SDK reference](/docs/zh-CN/agent-sdk/typescript)**：完整的API参考，包括`query()`和`rewindFiles()`方法的所有选项。
* **[Python SDK reference](/docs/zh-CN/agent-sdk/python)**：完整的API参考，包括`ClaudeAgentOptions`和`rewind_files()`方法的所有选项。