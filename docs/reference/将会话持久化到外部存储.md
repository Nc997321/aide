> ## Documentation Index
> Fetch the complete documentation index at: https://code.claude.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# 将会话持久化到外部存储

> 将会话记录镜像到 S3、Redis 或您自己的后端，以便任何主机都可以恢复它们。

默认情况下，SDK 将会话记录写入本地文件系统上 `~/.claude/projects/` 下的 JSONL 文件。`SessionStore` 适配器允许您将这些记录镜像到您自己的后端，例如 S3、Redis 或数据库，以便在一个主机上创建的会话可以在另一个主机上恢复。

使用会话存储的常见原因：

* **多主机部署。** 无服务器函数、自动扩展的工作进程和 CI 运行器不共享文件系统。共享存储允许任何副本恢复任何会话。
* **持久性。** 本地容器是临时的。由 S3 或数据库支持的存储可以在重启和重新部署后继续存在。
* **合规性和审计。** 将记录保存在您已经管理的存储中，使用您自己的保留规则、加密和访问控制。

<h2 id="the-sessionstore-interface">
  `SessionStore` 接口
</h2>

`SessionStore` 是一个对象，具有两个必需的方法 `append` 和 `load`，以及三个可选方法。SDK 调用 `append` 在查询期间写入记录条目，调用 `load` 读取它们以便恢复。

<CodeGroup>
  ```typescript TypeScript theme={null}
  // Exported from @anthropic-ai/claude-agent-sdk as
  // SessionStore, SessionKey, SessionStoreEntry.

  type SessionKey = {
    projectKey: string;
    sessionId: string;
    subpath?: string;
  };

  type SessionStore = {
    // Required
    append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
    load(key: SessionKey): Promise<SessionStoreEntry[] | null>;

    // Optional
    listSessions?(
      projectKey: string,
    ): Promise<Array<{ sessionId: string; mtime: number }>>;
    delete?(key: SessionKey): Promise<void>;
    listSubkeys?(key: {
      projectKey: string;
      sessionId: string;
    }): Promise<string[]>;
  };
  ```

  ```python Python theme={null}
  # Exported from claude_agent_sdk as
  # SessionStore, SessionKey, SessionStoreEntry.

  class SessionKey(TypedDict):
      project_key: str
      session_id: str
      subpath: NotRequired[str]

  class SessionStore(Protocol):
      # Required
      async def append(
          self, key: SessionKey, entries: list[SessionStoreEntry]
      ) -> None: ...
      async def load(self, key: SessionKey) -> list[SessionStoreEntry] | None: ...

      # Optional — omit or raise NotImplementedError
      async def list_sessions(
          self, project_key: str
      ) -> list[SessionStoreListEntry]: ...
      async def delete(self, key: SessionKey) -> None: ...
      async def list_subkeys(self, key: SessionListSubkeysKey) -> list[str]: ...
  ```
</CodeGroup>

`SessionKey` 寻址一个记录。`projectKey` 是工作目录的稳定的、文件系统安全的编码，`sessionId` 是会话 UUID，`subpath` 在条目属于子代理记录或边车文件而不是主对话时设置。将 `subpath` 视为不透明的密钥后缀；它遵循磁盘上的布局，例如 `subagents/agent-<id>`。当 `subpath` 未定义时，密钥指的是主记录。

| 方法             | 必需 | 调用时机                                                                                              |
| :------------- | :- | :------------------------------------------------------------------------------------------------ |
| `append`       | 是  | 在每批记录条目本地写入后。条目是 JSON 安全的对象，本地 JSONL 中每行一个。                                                       |
| `load`         | 是  | 在子进程生成之前一次，当设置 `resume` 时。如果会话未知，返回 `null`。                                                       |
| `listSessions` | 否  | 由 `listSessions({ sessionStore })` 和 `query()`/`startup()` 与 `continue: true` 调用。如果未定义，这些调用会抛出异常。 |
| `delete`       | 否  | 由 `deleteSession({ sessionStore })` 调用。删除主密钥（无 `subpath`）必须级联到该会话的所有子密钥。如果未定义，删除是无操作的，这适合仅追加的后端。  |
| `listSubkeys`  | 否  | 在恢复期间，发现子代理记录。如果未定义，仅恢复主记录。                                                                       |

<h2 id="quick-start">
  快速开始
</h2>

SDK 附带一个 `InMemorySessionStore` 用于开发和测试。下面的示例使用附加的存储运行查询，从结果消息中捕获会话 ID，然后在第二个 `query()` 调用中从存储恢复。第二个调用传递相同的存储实例加上 `resume`，因此 SDK 从存储而不是本地文件系统加载记录：

<CodeGroup>
  ```typescript TypeScript theme={null}
  import { query, InMemorySessionStore } from "@anthropic-ai/claude-agent-sdk";

  const store = new InMemorySessionStore();

  let sessionId: string | undefined;
  for await (const message of query({
    prompt: "List the TypeScript files under src/",
    options: { sessionStore: store },
  })) {
    if (message.type === "result") {
      sessionId = message.session_id;
    }
  }

  // Resume from the store. The agent has full context from the first call.
  for await (const message of query({
    prompt: "Summarize what those files do",
    options: { sessionStore: store, resume: sessionId },
  })) {
    if (message.type === "result" && message.subtype === "success") {
      console.log(message.result);
    }
  }
  ```

  ```python Python theme={null}
  import asyncio
  from claude_agent_sdk import (
      ClaudeAgentOptions,
      InMemorySessionStore,
      ResultMessage,
      query,
  )

  store = InMemorySessionStore()


  async def main():
      session_id = None
      async for message in query(
          prompt="List the Python files under src/",
          options=ClaudeAgentOptions(session_store=store),
      ):
          if isinstance(message, ResultMessage):
              session_id = message.session_id

      # Resume from the store. The agent has full context from the first call.
      async for message in query(
          prompt="Summarize what those files do",
          options=ClaudeAgentOptions(session_store=store, resume=session_id),
      ):
          if isinstance(message, ResultMessage) and message.subtype == "success":
              print(message.result)


  asyncio.run(main())
  ```
</CodeGroup>

第二个查询打印来自第一个查询的文件摘要，这表明代理从存储中恢复了完整的上下文。

<h2 id="write-your-own-adapter">
  编写您自己的适配器
</h2>

针对您的后端实现 `append` 和 `load`。如果您希望 `listSessions()`、`deleteSession()` 和子代理恢复针对存储工作，请添加 `listSessions`、`delete` 和 `listSubkeys`。

传递给 `append` 的条目类型为 `SessionStoreEntry`（一个 `{ type: string; ... }` 对象）。将它们视为不透明的 JSON 安全值：按顺序持久化它们，并从 `load` 以相同的顺序返回它们。`load` 必须返回与追加的条目深度相等的条目；不需要字节相等的序列化，因此像 Postgres `jsonb` 这样重新排序对象键的后端是可以的。

<h2 id="reference-implementations">
  参考实现
</h2>

TypeScript SDK 存储库在 [`examples/session-stores/`](https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores) 下包含 S3、Redis 和 Postgres 的可运行参考适配器。它们未发布到 npm；将您需要的 `src/` 文件复制到您的项目中并安装相应的后端客户端。

| 适配器                                                                                                                            | 后端客户端                | 存储模型                                           |
| :----------------------------------------------------------------------------------------------------------------------------- | :------------------- | :--------------------------------------------- |
| [`S3SessionStore`](https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores/s3)             | `@aws-sdk/client-s3` | 每个 `append()` 一个 JSONL 部分文件；`load()` 列出、排序和连接。 |
| [`RedisSessionStore`](https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores/redis)       | `ioredis`            | 每个记录的 `RPUSH`/`LRANGE` 列表，加上排序集会话索引。           |
| [`PostgresSessionStore`](https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores/postgres) | `pg`                 | `jsonb` 表中每个条目一行，按 `BIGSERIAL` 排序。             |

每个适配器都采用预配置的客户端实例，因此您可以控制凭证、TLS、区域和池。例如，使用 S3：

```typescript TypeScript theme={null}
import { query } from "@anthropic-ai/claude-agent-sdk";
import { S3Client } from "@aws-sdk/client-s3";
import { S3SessionStore } from "./S3SessionStore"; // copied from examples/session-stores/s3

const store = new S3SessionStore({
  bucket: "my-claude-sessions",
  prefix: "transcripts",
  client: new S3Client({ region: "us-east-1" }),
});

for await (const message of query({
  prompt: "Hello!",
  options: { sessionStore: store },
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}

// Later, possibly on a different host:
for await (const message of query({
  prompt: "Continue where we left off",
  options: { sessionStore: store, resume: "previous-session-id" },
})) {
  // ...
}
```

<h3 id="validate-your-adapter">
  验证您的适配器
</h3>

两个 SDK 都附带一个一致性套件，该套件断言 `append`、`load` 和可选方法必须满足的行为契约。当未实现这些方法时，可选方法的测试会自动跳过。

在 TypeScript 中，从示例目录将 [`shared/conformance.ts`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/examples/session-stores/shared/conformance.ts) 复制到您的测试套件中。在 Python 中，该套件在包中提供：

```python Python theme={null}
import pytest
from claude_agent_sdk.testing import run_session_store_conformance


@pytest.mark.asyncio
async def test_my_store_conformance():
    await run_session_store_conformance(MyRedisStore)
```

<h2 id="behavior-notes">
  行为说明
</h2>

<h3 id="dual-write-architecture">
  双写架构
</h3>

存储是镜像，不是替代品。Claude Code 子进程始终首先写入本地磁盘；SDK 然后将每批转发到 `append()`。如果您希望本地副本是临时的，请在 `options.env` 中将 `CLAUDE_CONFIG_DIR` 指向临时目录。因为镜像依赖于本地写入，`sessionStore` 不能与 `persistSession: false` 结合；如果您同时设置两者，SDK 会抛出异常。如果与 `enableFileCheckpointing` 结合，它也会抛出异常，因为文件历史备份 blob 直接写入本地磁盘，不会镜像到存储。

<h3 id="mirror-writes-are-best-effort">
  镜像写入是尽力而为的
</h3>

如果 `append()` 拒绝，SDK 会以短退避重试该批次最多两次，总共最多三次尝试。超时的调用不会重试，因为原始调用可能仍然会成功。如果批次仍然失败，错误会被记录，一个 `{ type: "system", subtype: "mirror_error" }` 消息被发出到迭代器中，批次被丢弃，查询继续。本地记录已经在磁盘上持久化，所以存储中断不会中断代理或在本地丢失数据。监视 `mirror_error` 如果您需要检测存储数据丢失。因为重试的批次可以重新传递已经成功的条目，请在您的 `append()` 实现中按 `entry.uuid` 进行去重。

<h3 id="getsessionmessages-returns-the-post-compaction-chain">
  `getSessionMessages` 返回后压缩链
</h3>

`getSessionMessages({ sessionStore })` 返回代理在恢复时会看到的链接消息链。自动压缩后，早期的轮次被摘要替换，因此存储中包含 503 个原始条目的会话可能从 `getSessionMessages` 返回 18 条消息。对于完整的原始历史记录，包括压缩前的轮次和元数据条目，直接调用 `store.load(key)`。

<h3 id="forksession-is-not-a-byte-copy">
  `forkSession` 不是字节副本
</h3>

`forkSession({ sessionStore })` 读取源条目，重写每个 `sessionId` 字段并重新映射消息 UUID，然后在新密钥下追加转换后的条目。适配器级别的副本或 `CopyObject` 快捷方式会产生仍然引用旧会话 ID 的记录，因此 SDK 不使用它。

<h3 id="subagent-transcripts">
  子代理记录
</h3>

子代理记录在 `subpath: "subagents/agent-<id>"` 下镜像。`listSubagents({ sessionStore })` 要求适配器实现 `listSubkeys`；`getSubagentMessages({ sessionStore })` 在可用时使用它，但在未定义时回退到直接子路径。恢复也调用 `listSubkeys` 来恢复子代理文件；没有它，仅实现主记录。

<h3 id="retention">
  保留
</h3>

SDK 永远不会自行从您的存储中删除。保留是适配器的责任：根据您的合规要求实现 TTL、S3 生命周期策略或计划清理。`CLAUDE_CONFIG_DIR` 下的本地记录由 `cleanupPeriodDays` 设置独立清理。

<h2 id="supported-on">
  支持的功能
</h2>

以下 SDK 函数接受 `sessionStore` 选项，当提供时针对存储而不是本地文件系统操作：

* [`query()`](/docs/zh-CN/agent-sdk/typescript#query)
* [`startup()`](/docs/zh-CN/agent-sdk/typescript#startup)
* [`listSessions()`](/docs/zh-CN/agent-sdk/typescript#listsessions)
* [`getSessionInfo()`](/docs/zh-CN/agent-sdk/typescript#getsessioninfo)
* [`getSessionMessages()`](/docs/zh-CN/agent-sdk/typescript#getsessionmessages)
* [`renameSession()`](/docs/zh-CN/agent-sdk/typescript#renamesession)
* [`tagSession()`](/docs/zh-CN/agent-sdk/typescript#tagsession)
* [`deleteSession()`](/docs/zh-CN/agent-sdk/typescript)
* [`forkSession()`](/docs/zh-CN/agent-sdk/typescript)
* [`listSubagents()`](/docs/zh-CN/agent-sdk/typescript)
* [`getSubagentMessages()`](/docs/zh-CN/agent-sdk/typescript)

<h2 id="related-resources">
  相关资源
</h2>

* [使用会话](/docs/zh-CN/agent-sdk/sessions)：在没有自定义存储的情况下继续、恢复和分叉
* [托管 SDK](/docs/zh-CN/agent-sdk/hosting)：多主机环境的部署模式
* [TypeScript `Options`](/docs/zh-CN/agent-sdk/typescript#options)：完整的选项参考
* [`examples/session-stores/`](https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores)：可运行的 S3、Redis 和 Postgres 参考适配器
