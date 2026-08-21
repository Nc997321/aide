// 端到端实测：场景 B「400 → 回滚 → resume + 注入 continue → 模型自动继续」全链路，
// 模拟 aide session-worker 的共享 MessageQueue 结构（不是独立 generator）：
// 会话 1 与注入共用同一个 queue——abort 后旧迭代器还挂在 resolveNext 上，
// 这正是 2026-08-21 用户现场「注入丢失 → 无自动继续」的竞态根因。
// 验证两种注入路径：
//   legacy（默认）＝ queue.push → 注入被旧迭代器吞 → 模型不自动继续（复现 bug）
//   AIDE_INJECT_SLOT=1  → 预置槽 → 注入由下一轮私有迭代器首条 yield → 模型自动继续
// 用法（agent-sidecar 目录）：
//   先起 mock：npx tsx mock-vision-server.ts
//   npx tsx smoke-rollback-continue.ts          （legacy：预期 FAIL 复现丢注入）
//   AIDE_INJECT_SLOT=1 npx tsx smoke-rollback-continue.ts（预置槽：预期 PASS）
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { detectImageUnsupported, findSessionJsonl, rollbackImageMessage } from "./src/imageRollback.js";
import { MessageQueue } from "./src/generator.js";

const req = createRequire(import.meta.url);
const exe = req.resolve("@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe");
const IMG = "C:/Users/<user>/Pictures/Saved Pictures/head_portrait.jpg";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const useSlot = process.env.AIDE_INJECT_SLOT === "1";
  console.log(`── 模式：${useSlot ? "预置槽（修复后）" : "queue.push（旧代码）"} ──`);

  // 共享 MessageQueue（模拟 worker 的 this.queue）+ 预置槽（修复后）
  const queue = new MessageQueue();
  let injection: any = null;

  // ── 会话 1：真实 400（prompt 走共享 queue，模拟 worker 首轮）──
  console.log("── 阶段 1：触发真实 400 ──");
  queue.push({
    type: "user",
    message: { role: "user", content: `用 Read 工具读取图片文件：${IMG}，然后告诉我里面是什么。只做这一步。` },
    parent_tool_use_id: null,
  } as any);
  const ctl1 = new AbortController();
  const q1 = query({
    prompt: queue[Symbol.asyncIterator](),
    options: {
      pathToClaudeCodeExecutable: exe,
      settingSources: [],
      permissionMode: "bypassPermissions",
      abortController: ctl1,
    },
  });
  let sid = "";
  let saw400 = false;
  try {
    for await (const e of q1 as any) {
      if (e?.type === "system" && e?.subtype === "init") sid = e.session_id as string;
      console.log("s1:", e?.type, e?.subtype ?? "", e?.message?.role ?? "");
      if (detectImageUnsupported(e)) {
        saw400 = true;
        console.log("  → detectImageUnsupported 命中，abort 杀 CLI——不 break，模拟 worker 继续迭代");
        ctl1.abort();
        // worker 不 break：abort 后继续迭代，直到 SDK 抛 error_result 进 catch
      }
    }
  } catch (err: any) {
    console.log("  s1 迭代抛错（worker 的 catch 点）:", String(err?.message ?? err).slice(0, 160), "| errorClass:", err?.errorClass);
    if (err?.message?.includes("does not support image input")) {
      saw400 = true;
      ctl1.abort();
    }
  }
  if (!saw400 || !sid) {
    console.log("FAIL: 未捕获 400（模型支持图片？），sid=", sid);
    return 1;
  }
  console.log("会话 sid =", sid);
  // abort 是异步的：worker 无 sleep（abort 后立即 catch→回滚），CLI 可能还在收尾
  // 写 jsonl——这是与 smoke 原版的最大差异。AIDE_NO_WAIT=1 模拟 worker 的真实时序。
  if (!process.env.AIDE_NO_WAIT) await sleep(2000);

  // ── 阶段 2：真实回滚 ──
  console.log("── 阶段 2：rollbackImageMessage 回滚 ──");
  const projectsRoot = join(homedir(), ".aide", "claude", "projects");
  const jsonl = findSessionJsonl(projectsRoot, sid);
  if (!jsonl) { console.log("❌ 找不到 jsonl"); return 1; }
  const result = rollbackImageMessage(jsonl);
  console.log("回滚结果:", JSON.stringify(result));
  if (!result.removed) { console.log("❌ 回滚未发生"); return 1; }

  // ── 阶段 3：注入 continue（按模式走 queue.push 或预置槽）──
  console.log(`── 阶段 3：注入 continue（${useSlot ? "预置槽" : "queue.push（会触发旧迭代器竞态）"}）──`);
  const CONTINUE =
    "请继续处理用户的问题。刚才读取图片文件未获得可用内容，请忽略该次操作。" +
    "若该文件内容确实无法读取，可自然地向用户说明无法查看该文件并继续，不要提及任何技术细节。";
  const injectMsg = {
    type: "user",
    message: { role: "user", content: CONTINUE },
    parent_tool_use_id: null,
  };
  if (useSlot) {
    injection = injectMsg;
  } else {
    // legacy：走共享 queue——上一轮迭代器还挂着 resolveNext，会把这消息吞掉
    queue.push(injectMsg as any);
  }

  // 下一轮 query：包装生成器（先 yield 预置槽注入，再 yield* 共享 queue）
  const promptIter = (async function* () {
    if (injection) yield injection;
    yield* queue;
  })();
  const q2 = query({
    prompt: promptIter as any,
    options: {
      pathToClaudeCodeExecutable: exe,
      settingSources: [],
      permissionMode: "bypassPermissions",
      resume: sid,
    },
  });
  let assistantReplies = 0;
  let finished = false;
  const timeout = setTimeout(() => { console.log("⏰ 90s 超时——模型没有自动回复"); }, 90_000);
  try {
    for await (const e of q2 as any) {
      console.log("s2:", e?.type, e?.subtype ?? "", e?.message?.role ?? "");
      if (e?.type === "assistant" && !e?.parent_tool_use_id) {
        const text = (e?.message?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
        if (text.trim()) {
          assistantReplies++;
          console.log("  → 模型自动回复（前 200 字）：", text.trim().slice(0, 200));
        }
      }
      if (e?.type === "result") { finished = true; break; }
    }
  } catch (e: any) {
    console.log("s2 error:", String(e?.message ?? e).slice(0, 200));
  }
  clearTimeout(timeout);
  if (!finished) { console.log("⚠️ 未等到 result（CLI 可能 0 事件退出）"); return 1; }
  if (assistantReplies === 0) { console.log(`❌ 模型没有任何自动回复（${useSlot ? "预置槽模式下不应发生" : "legacy queue.push 竞态复现 ✓"}）`); return useSlot ? 1 : 0; }
  console.log(`✅ 注入生效：模型自动回复了 ${assistantReplies} 条（${useSlot ? "预置槽" : "queue.push"} 路径）`);
  return useSlot ? 0 : 1;
}

main().then((code) => process.exit(code));
