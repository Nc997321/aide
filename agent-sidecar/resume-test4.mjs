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

const sid = "899216a6-bd81-474d-982d-48c9ad901124";
const jsonl = findJsonl(sid);
const lines = readFileSync(jsonl, "utf8").split(/\r?\n/).filter(Boolean);

// 模拟场景 B 回滚：
// 1. tool_result content → 错误文本 + is_error:true
// 2. 删除最后的 assistant thinking + text（模型没来得及回复）
const kept = [];
for (const l of lines) {
  const m = JSON.parse(l);
  const isToolResult = m.type === "user" && Array.isArray(m.message?.content) && m.message.content.some(b => b.type === "tool_result");
  const isAssistant = m.type === "assistant";
  if (isToolResult) {
    for (const b of m.message.content) {
      if (b.type === "tool_result") {
        b.content = "图片输入不可用：当前模型不支持图片输入（API 返回 400 this model does not support image input）。请改读该文件的文本内容（如 OCR / 文本提取），或跳过该文件。";
        b.is_error = true;
      }
    }
    kept.push(JSON.stringify(m));
  } else if (isAssistant) {
    continue; // 删除模型回复
  } else {
    kept.push(l);
  }
}
writeFileSync(jsonl, kept.join("\n"));
console.log("jsonl rewritten, lines:", kept.length);

// resume + 无输入
const it2 = (async function* () {})();
const q2 = query({ prompt: it2, options: { pathToClaudeCodeExecutable: exe, resume: sid } });
let events = 0;
try {
  for await (const e of q2) {
    events++;
    console.log("session2 event:", e.type, e.subtype ?? "", e.message?.role ?? "");
    if (e.type === "result") break;
  }
} catch (e) {
  console.log("session2 error:", String(e?.message ?? e).slice(0, 200));
}
console.log("session2 total events:", events);
