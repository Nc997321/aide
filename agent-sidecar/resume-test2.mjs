import { query } from "@anthropic-ai/claude-agent-sdk";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const req = createRequire(import.meta.url);
const exe = req.resolve("@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe");
const projectsRoot = join(homedir(), ".aide", "claude", "projects");

function findJsonl(sid) {
  for (const dir of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const p = join(projectsRoot, dir.name, sid + ".jsonl");
    if (existsSync(p)) return p;
  }
  return null;
}

const tf = join(homedir(), "AppData", "Local", "Temp", "aide-resume-target.txt");
writeFileSync(tf, "这是测试文件内容：aide 回滚实验\n");

// 会话 1：让模型 Read 文件
const it = (async function* () {
  yield { type: "user", message: { role: "user", content: [{ type: "text", text: "用 Read 工具读这个文件：" + tf + "，然后告诉我文件内容。只做这一步。" }] } };
})();
const q1 = query({ prompt: it, options: { pathToClaudeCodeExecutable: exe, settingSources: [], permissionMode: "bypassPermissions" } });
let sid = "";
for await (const e of q1) {
  if (e.type === "system" && e.subtype === "init") sid = e.session_id;
  if (e.type === "result") break;
}
console.log("session1 done, sid:", sid);

// 读取 jsonl，打印最后 3 行（看 tool_result 后的状态）
const jsonl = findJsonl(sid);
console.log("jsonl:", jsonl);
const lines = readFileSync(jsonl, "utf8").split(/\r?\n/).filter(Boolean);
console.log("total lines:", lines.length);
for (const l of lines.slice(-2)) {
  const m = JSON.parse(l);
  const c = JSON.stringify(m.message?.content ?? m.content ?? "");
  console.log("  last:", m.type, m.subtype ?? "", c.slice(0, 100));
}

// 模拟场景 B 回滚：删除 result 行 + 把最后一个 user 消息的 tool_result content 替换为错误文本
// （场景 B 真实回滚是替换 tool_result 图片；这里模拟"历史处于 tool_use 挂起"状态）
