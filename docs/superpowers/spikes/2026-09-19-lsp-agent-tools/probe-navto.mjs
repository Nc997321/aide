#!/usr/bin/env node
/**
 * `workspace/symbol`（tsserver 侧即 `navto`）探针 —— 回答一个具体问题：
 *
 *   **tsserver 的按名查询，凭什么回空？**
 *
 * 真机现象（2026-09-19 日志）：agent 的每一次 `lsp_symbols {name}` 都回
 * `no symbol named X`，而同一个会话里拿坐标查 references 却精确命中——说明
 * server 活着、符号也在，**只有按名这条路是死的**。
 *
 * 候选解释两条，本探针分开测：
 *   A. navto 的索引只覆盖「服务器已加载的工程」——没 didOpen 过任何文件时回空
 *      （与 spike §6「tsserver 只回答它打开过的文档」同一族）。
 *   B. TLS 这一版压根没实现 / 没转发 `workspace/symbol`——那么无论开不开文件都回空。
 *
 * 判据顺序（同一次进程、同一个 initialize，只变 didOpen 这一个变量）：
 *   1. 开文件**之前**问一次
 *   2. didOpen 目标文件 + 等 `--settle-ms` 再问
 *   3. 再等一轮（工程异步加载）再问
 *   4. 对照组：问一个**不存在**的名字（区分「能力有但没有匹配」与「一律回空」）
 *
 * Usage:
 *   node probe-navto.mjs --server node --args "<tls>/lib/cli.mjs,--stdio" \
 *        --root <dir> --query useInlineMention \
 *        [--file <relpath>] [--open a.ts,b.vue,c.ts] \
 *        [--init-options '<json>'] [--settle-ms 8000] [--dump-notify]
 *
 * `--open` 逐个打开并**每开一个问一次**：navto 只认「已加载的工程」，而加载哪个工程
 * 取决于打开的是哪个文件——这正是 2026-09-19 那次假否定的机制（预热打开了
 * tsconfig.node.json 里的 vite.config.ts，`src/` 的符号一个也看不见）。
 *
 * 退出码：0 = 某一步拿到了非空结果，1 = 全程空，2 = 装置错误。
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const LANGUAGE_BY_EXT = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".vue": "vue",
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith("--")) throw new Error(`unexpected arg: ${key}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key.slice(2)] = true;
    } else {
      out[key.slice(2)] = next;
      i++;
    }
  }
  return out;
}

/** JSON-RPC over stdio，LSP 的 Content-Length 分帧（与 probe.mjs 同款，故意不引库）。 */
function makeTransport(child, opts = {}) {
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
    if (msg.id !== undefined && msg.method) {
      // 服务器反向请求（workspace/configuration）：不回它就直接卡死在准备阶段。
      const handler = onRequest.get(msg.method);
      send({ jsonrpc: "2.0", id: msg.id, result: handler ? handler(msg.params) : null });
      return;
    }
    if (msg.id !== undefined) {
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
      return;
    }
    if (opts.dumpNotify && !String(msg.method ?? "").startsWith("$/")) {
      process.stderr.write(`[notify] ${msg.method} ${JSON.stringify(msg.params)}\n`);
    }
  }

  return {
    request(method, params, timeoutMs = 60000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout after ${timeoutMs}ms: ${method}`));
        }, timeoutMs);
        pending.set(id, (msg) => {
          clearTimeout(timer);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一次 navto 查询的摘要。**把「答了空」和「没答上」分开**：两者在这里都是 0 条，
 *  但前者是 `[]`、后者是 error/timeout——修法完全不同（spike 的老教训）。 */
async function askNavto(t, query) {
  try {
    const r = await t.request("workspace/symbol", { query }, 60000);
    const items = Array.isArray(r) ? r : [];
    return {
      query,
      shape: Array.isArray(r) ? "array" : typeof r,
      count: items.length,
      names: items.slice(0, 10).map((x) => x.name),
      uris: items.slice(0, 5).map((x) => x.location?.uri ?? x.uri),
    };
  } catch (e) {
    return { query, shape: "error", count: 0, error: e.message };
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const root = path.resolve(a.root);
  const opens = a.open ? String(a.open).split(",").map((s) => s.trim()) : [a.file];
  if (!opens[0]) throw new Error("--file or --open is required");
  const file = path.resolve(root, opens[0]);
  const query = a.query;
  if (!query) throw new Error("--query is required");
  const control = a.control ?? "zzzNoSuchSymbolInThisRepoXyz";
  const settleMs = Number(a["settle-ms"] ?? 8000);
  const initOptions = a["init-options"] ? JSON.parse(a["init-options"]) : undefined;
  const language = LANGUAGE_BY_EXT[path.extname(file)] ?? "plaintext";

  const child = spawn(a.server, a.args ? a.args.split(",") : [], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: root,
    shell: false,
  });
  child.stderr.on("data", (d) => process.stderr.write(`[server stderr] ${d}`));

  const t = makeTransport(child, { dumpNotify: !!a["dump-notify"] });
  let died = null;
  const fatal = new Promise((_, rej) => t.onExit((code) => { died = new Error(`server exited (code ${code})`); rej(died); }));
  t.onRequest("workspace/configuration", (params) => (params?.items ?? []).map(() => ({})));

  const rootUri = pathToFileURL(root).href;
  await Promise.race([
    t.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
      capabilities: {
        textDocument: { references: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true } },
        workspace: { symbol: {}, configuration: true },
      },
      initializationOptions: initOptions,
    }, 120000),
    fatal,
  ]);
  t.notify("initialized", {});

  const steps = [];
  // 1. 没开过任何文件就问
  steps.push({ step: "before-any-didOpen", ...(await askNavto(t, query)) });

  // 2. 逐个打开 --open 的文件，**每开一个问一次**：加载的是哪个工程由打开的文件决定。
  for (const rel of opens) {
    const abs = path.resolve(root, rel);
    t.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(abs).href,
        languageId: LANGUAGE_BY_EXT[path.extname(abs)] ?? "typescript",
        version: 1,
        text: readFileSync(abs, "utf8"),
      },
    });
    await sleep(settleMs);
    steps.push({ step: `after-open:${rel}+${settleMs}ms`, ...(await askNavto(t, query)) });
  }

  // 3. 对照组：不存在的名字。**它回非空 = 装置坏了**；它回空说明不了任何事
  steps.push({ step: "control(absent-name)", ...(await askNavto(t, control)) });

  // 4. `--peek <relpath>`：对一个**从没 didOpen 过**的文件问 documentSymbol。
  //    这是「工程加载好了没有」的候选判据：工程没加载时 tsserver 对它一律回空，
  //    加载完才作答——**与「这个文件没有符号」是两件事**。
  if (a.peek) {
    const abs = path.resolve(root, String(a.peek));
    let r;
    try {
      r = await t.request(
        "textDocument/documentSymbol",
        { textDocument: { uri: pathToFileURL(abs).href } },
        60000
      );
    } catch (e) {
      r = { __error: e.message };
    }
    steps.push({
      step: `peek(documentSymbol on never-opened):${a.peek}`,
      shape: Array.isArray(r) ? "array" : "error",
      count: Array.isArray(r) ? r.length : 0,
      error: r?.__error,
    });
  }

  const found = steps.some((s) => s.count > 0);
  console.log(JSON.stringify({ ok: found, file: a.file, query, steps }, null, 2));
  child.kill();
  process.exit(found ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
