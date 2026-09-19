#!/usr/bin/env node
/**
 * Minimal LSP client — a throwaway spike harness for the 2026-09-19
 * "agent doesn't use LSP" investigation.
 *
 * Why raw: we need to drive a language server *exactly* the way the CLI's
 * built-in LSP tool does (same initialize params, same position encoding),
 * so the measurement reflects the agent's real experience. Using a library
 * would insert its own opinions between us and the server.
 *
 * Usage:
 *   node probe.mjs --server <cmd> [--args a,b] --root <dir> \
 *                  --file <relpath> --line 80 --col 15 \
 *                  [--op references|documentSymbol] [--poll-ms 5000] [--poll-timeout 300000] \
 *                  [--init-options '<json>'] [--settings '<json>'] [--language <id>]
 *
 * Positions on the command line are 1-based (as editors show them); they are
 * converted to LSP's 0-based before being sent.
 *
 * Exit codes: 0 = got a non-empty result, 1 = empty after timeout, 2 = error.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const LANGUAGE_BY_EXT = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".vue": "vue",
  ".rs": "rust",
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`unexpected arg: ${key}`);
    const next = argv[i + 1];
    // 裸开关（后一个 token 又是 --flag，或已到末尾）→ true。
    // 键值对形式照旧。注意：值本身以 `--` 开头时要用键值对写法就得合并成一个 token
    // （如 --args "a,--stdio"），否则会被当成裸开关——spike 工具可接受。
    if (next === undefined || next.startsWith("--")) {
      out[key.slice(2)] = true;
    } else {
      out[key.slice(2)] = next;
      i++;
    }
  }
  return out;
}

/** JSON-RPC over stdio with LSP's Content-Length framing. */
function makeTransport(child) {
  let buf = Buffer.alloc(0);
  const pending = new Map();
  const onRequest = new Map();
  let nextId = 1;
  let onExit = () => {};

  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buf.subarray(0, headerEnd).toString("ascii");
      const len = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
      if (!Number.isFinite(len)) throw new Error(`bad header: ${header}`);
      const start = headerEnd + 4;
      if (buf.length < start + len) return;
      const body = buf.subarray(start, start + len).toString("utf8");
      buf = buf.subarray(start + len);
      dispatch(JSON.parse(body));
    }
  });
  child.on("exit", (code) => onExit(code));

  function send(msg) {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  }

  function dispatch(msg) {
    // Server → client request: we must answer or the server may block.
    if (msg.id !== undefined && msg.method) {
      const handler = onRequest.get(msg.method);
      const result = handler ? handler(msg.params) : null;
      send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    if (msg.id !== undefined) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
      return;
    }
    // Notifications ($/progress, window/logMessage, …) are ignored.
  }

  return {
    request(method, params, timeoutMs) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = timeoutMs
          ? setTimeout(() => {
              pending.delete(id);
              reject(new Error(`timeout after ${timeoutMs}ms: ${method}`));
            }, timeoutMs)
          : null;
        pending.set(id, (msg) => {
          if (timer) clearTimeout(timer);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        });
        send({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      send({ jsonrpc: "2.0", method, params });
    },
    onRequest(method, handler) {
      onRequest.set(method, handler);
    },
    onExit(fn) {
      onExit = fn;
    },
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const root = path.resolve(a.root);
  const file = path.resolve(root, a.file);
  const line = Number(a["line"] ?? 1);
  const col = Number(a["col"] ?? 1);
  const op = a.op ?? "references";
  const language = a.language ?? LANGUAGE_BY_EXT[path.extname(file)] ?? "plaintext";
  const initOptions = a["init-options"] ? JSON.parse(a["init-options"]) : undefined;
  const settings = a.settings ? JSON.parse(a.settings) : {};
  const pollMs = Number(a["poll-ms"] ?? 5000);
  const pollTimeout = Number(a["poll-timeout"] ?? 300000);

  const child = spawn(a.server, a.args ? a.args.split(",") : [], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: root,
    shell: false,
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server stderr] ${d}`));

  const t = makeTransport(child);
  // A dead server must abort the poll loop immediately — retrying a process
  // that has already exited just burns the whole timeout.
  let died = null;
  const fatal = new Promise((_, rej) => {
    t.onExit((code) => {
      died = new Error(`server exited (code ${code})`);
      rej(died);
    });
  });

  // A generic configuration responder: servers that ask for settings must get
  // an answer, or they stall before reaching index-ready.
  //
  // Shape matters more than it looks: the server asks per section (RA sends
  // `{section: "rust-analyzer"}`) and expects the section's VALUE. Handing back
  // the wrapped `{"rust-analyzer": {...}}` blob makes RA silently ignore every
  // setting — it then falls back to auto-discovery and the experiment measures
  // nothing. Verified the hard way: a deliberately wrong `linkedProjects` was
  // honoured only after this unwrapping.
  const sectionValue = settings["rust-analyzer"] ?? settings;
  t.onRequest("workspace/configuration", (params) =>
    (params?.items ?? []).map(() => sectionValue)
  );

  const rootUri = pathToFileURL(root).href;
  const started = Date.now();
  await Promise.race([
    t.request(
      "initialize",
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
        capabilities: {
          textDocument: {
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            definition: {},
          },
          workspace: { symbol: {}, configuration: true },
        },
        initializationOptions: initOptions,
      },
      120000
    ),
    fatal,
  ]);
  t.notify("initialized", {});
  if (Object.keys(settings).length > 0) {
    t.notify("workspace/didChangeConfiguration", { settings });
  }

  const text = readFileSync(file, "utf8");
  const uri = pathToFileURL(file).href;
  // `--no-did-open` measures whether a server answers for a document it was never
  // told about. Used to decide whether the agent path needs on-demand didOpen.
  if (!a["no-did-open"]) {
    t.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: language, version: 1, text },
    });
  }

  const params =
    op === "documentSymbol"
      ? { textDocument: { uri } }
      : {
          textDocument: { uri },
          position: { line: line - 1, character: col - 1 },
          context: { includeDeclaration: true },
        };

  const deadline = started + pollTimeout;
  for (let attempt = 1; ; attempt++) {
    let result;
    try {
      result = await Promise.race([
        t.request(op === "documentSymbol" ? "textDocument/documentSymbol" : "textDocument/references", params, 60000),
        fatal,
      ]);
    } catch (err) {
      if (died) {
        console.log(
          JSON.stringify({ ok: false, op, file: a.file, attempt, reason: died.message })
        );
        process.exit(2);
      }
      process.stderr.write(`attempt ${attempt}: ${err.message}\n`);
      result = [];
    }
    const items = Array.isArray(result) ? result : [];
    const elapsed = Date.now() - started;
    if (items.length > 0) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            op,
            file: a.file,
            attempt,
            elapsedMs: elapsed,
            count: items.length,
            items: items.slice(0, 40).map((r) => ({
              uri: r.uri ?? r.location?.uri,
              line: (r.range ?? r.location?.range)?.start.line + 1,
              col: (r.range ?? r.location?.range)?.start.character + 1,
              name: r.name,
              kind: r.kind,
            })),
          },
          null,
          2
        )
      );
      child.kill();
      process.exit(0);
    }
    if (Date.now() > deadline) {
      console.log(
        JSON.stringify({
          ok: false,
          op,
          file: a.file,
          attempt,
          elapsedMs: Date.now() - started,
          count: 0,
        })
      );
      child.kill();
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
