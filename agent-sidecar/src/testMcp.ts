// MCP 探活：被 Rust test_mcp_connection spawn 调用（agent-runtime test-mcp <config-json>）。
// 入参 config: JSON string { transport, command?, args?, env?, url?, headers? }
// 出参：stdout 一行 JSON { status, tools, error }，退出码 0。
// 握手只读（initialize + tools/list），不调任何工具，无副作用——这是能做"测试"的前提。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TIMEOUT_MS = 10_000;

function emit(result: { status: string; tools: string[]; error?: string }): void {
  process.stdout.write(JSON.stringify(result) + "\n");
}

/**
 * 探活一个 MCP server。按 config.transport 选 transport 握手（initialize + tools/list），
 * 拿工具清单后关闭进程。超时/连接/握手错误分别回传不同 status。
 */
export async function runTestMcp(configStr: string): Promise<void> {
  let cfg: any;
  try {
    cfg = JSON.parse(configStr);
  } catch (e: any) {
    emit({ status: "handshake_error", tools: [], error: `bad config json: ${e?.message ?? e}` });
    return;
  }

  const client = new Client({ name: "aide-test-mcp", version: "1.0" }, { capabilities: {} });
  let transport: any;
  try {
    if (cfg.transport === "stdio") {
      transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: cfg.env,
      });
    } else if (cfg.transport === "sse") {
      transport = new SSEClientTransport(new URL(cfg.url));
    } else if (cfg.transport === "http") {
      transport = new StreamableHTTPClientTransport(
        new URL(cfg.url),
        cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined,
      );
    } else {
      emit({ status: "handshake_error", tools: [], error: `unknown transport: ${cfg.transport}` });
      return;
    }
  } catch (e: any) {
    emit({ status: "handshake_error", tools: [], error: String(e?.message ?? e) });
    return;
  }

  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS),
  );
  try {
    await Promise.race([client.connect(transport), timer]);
    const { tools } = await Promise.race([client.listTools(), timer]);
    emit({ status: "ok", tools: (tools ?? []).map((t: any) => t.name) });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const status =
      msg === "timeout"
        ? "timeout"
        : /spawn|ENOENT/i.test(msg)
          ? "spawn_error"
          : /connect|ECONNREFUSED|fetch|refused/i.test(msg)
            ? "connect_error"
            : "handshake_error";
    emit({ status, tools: [], error: msg });
  } finally {
    try {
      await client.close();
    } catch {
      // 关闭失败不影响结果已写出
    }
  }
}