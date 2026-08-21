import { query } from "@anthropic-ai/claude-agent-sdk";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
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

// 会话 1：让模型 Read 文件（成功）
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

// 读取 jsonl 全部行
const jsonl = findJsonl(sid);
const lines = readFileSync(jsonl, "utf8").split(/\r?\n/).filter(Boolean);
console.log("lines:", lines.length);
for (const l of lines) {
  const m = JSON.parse(l);
  const c = JSON.stringify(m.message?.content ?? m.content ?? "");
  console.log(" ", m.type, m.subtype ?? "", m.message?.role ?? "", c.slice(0, 90));
}
