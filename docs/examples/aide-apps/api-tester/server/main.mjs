// 接口调试的后端：一个不带任何依赖的 stdio MCP server（按行分隔的 JSON-RPC）。
// 界面（aide.tools.call）和 agent 会话（mcp__app-api-tester__*）调的是同一组工具，
// 但各起各的进程——所以历史记录落在 AIDE_APP_DATA 里，不放内存。
// 只往 stdout 写协议消息；日志写 stderr。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const DATA = process.env.AIDE_APP_DATA || ".";
const HISTORY = join(DATA, "history.json");
const MAX_HISTORY = 50;
const MAX_BODY = 200_000;

const readHistory = () => {
  try { return JSON.parse(readFileSync(HISTORY, "utf8")); } catch { return []; }
};

const TOOLS = [
  {
    name: "send_request",
    description: "Send an HTTP request from this machine and return the status, headers and body. The request is recorded in the API tester's history.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "GET, POST, PUT, PATCH, DELETE… Default GET." },
        url: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "string" },
      },
      required: ["url"],
    },
  },
  {
    name: "list_history",
    description: "List the most recent requests sent through the API tester, newest first.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
];

async function sendRequest({ method = "GET", url, headers = {}, body }) {
  const started = Date.now();
  const verb = String(method).toUpperCase();
  const res = await fetch(url, { method: verb, headers, body: verb === "GET" || verb === "HEAD" ? undefined : body });
  const text = (await res.text()).slice(0, MAX_BODY);
  const entry = {
    at: new Date().toISOString(),
    method: verb,
    url,
    status: res.status,
    ms: Date.now() - started,
  };
  mkdirSync(DATA, { recursive: true });
  writeFileSync(HISTORY, JSON.stringify([entry, ...readHistory()].slice(0, MAX_HISTORY)));
  return { ...entry, statusText: res.statusText, headers: Object.fromEntries(res.headers), body: text };
}

async function callTool(name, args) {
  if (name === "send_request") return sendRequest(args ?? {});
  if (name === "list_history") return readHistory();
  throw new Error(`unknown tool: ${name}`);
}

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const fail = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");

createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // 通知（notifications/initialized）不用答
  try {
    switch (msg.method) {
      case "initialize":
        return reply(msg.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "api-tester", version: "0.1.0" },
        });
      case "tools/list":
        return reply(msg.id, { tools: TOOLS });
      case "tools/call": {
        try {
          const out = await callTool(msg.params?.name, msg.params?.arguments);
          return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(out) }] });
        } catch (e) {
          // 工具自己的失败（连不上、地址不对）是一次「出错的结果」，不是协议错误
          return reply(msg.id, { content: [{ type: "text", text: String(e?.cause?.message || e?.message || e) }], isError: true });
        }
      }
      default:
        return fail(msg.id, `method not found: ${msg.method}`);
    }
  } catch (e) {
    console.error(e);
    fail(msg.id, String(e?.message || e));
  }
});
