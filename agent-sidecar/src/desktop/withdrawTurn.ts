// 撤回一条已经开始执行、但模型还没任何输出的消息（Esc / 停止按钮，对齐 Claude Code CLI：
// 打断得够早，消息就像没发过）。
//
// CLI 内存里的历史已经带着这条消息和「[Request interrupted by user]」，只打断不够：
// worker 拆掉 query（杀 CLI）后由这里把 transcript 从这条消息那一行起截掉，再原地
// resume。与「撤回到此处」（revertRound 按字节截断 jsonl）同一个做法——截掉而不是
// 用 resumeSessionAt 分叉，历史加载器按字节顺序读 jsonl，分叉留下的死分支会在重开
// 会话时重新冒出来。
import { readFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { findSessionJsonl } from "../engine/imageRollback.js";

/** 截断点：jsonl 里 `type:"user"` 且 `uuid === messageId` 那一行；它前面若有这条消息的
 *  入队日志（`queue-operation`/`enqueue`，其间没有别的对话行），从入队日志起截——那行带着
 *  消息原文。找不到这条消息 = null。 */
export function messageLineOffset(buf: Buffer, messageId: string): number | null {
  const needle = Buffer.from(messageId);
  let enqueueAt: number | null = null;
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    const line = buf.subarray(start, end);
    let v: { type?: unknown; uuid?: unknown; operation?: unknown } | null = null;
    try {
      v = JSON.parse(line.toString("utf8"));
    } catch {
      v = null; // 半行 / 坏行
    }
    if (v?.type === "user" && v.uuid === messageId && line.includes(needle)) return enqueueAt ?? start;
    if (v?.type === "queue-operation" && v.operation === "enqueue") enqueueAt = start;
    else if (v?.type === "user" || v?.type === "assistant") enqueueAt = null;
    start = end + 1;
  }
  return null;
}

/**
 * 把会话 transcript 从 `messageId` 那条用户消息起截掉。
 * 返回 "truncated" | "not_found"（CLI 还没把这条落盘——历史里本来就没有它，同样算撤回成功）
 * | "no_transcript"。读写失败抛出，由调用方降级为普通打断。
 */
export function truncateTranscriptAt(
  configDir: string,
  sessionId: string,
  messageId: string,
): "truncated" | "not_found" | "no_transcript" {
  const jsonl = findSessionJsonl(join(configDir, "projects"), sessionId);
  if (!jsonl) return "no_transcript";
  const offset = messageLineOffset(readFileSync(jsonl), messageId);
  if (offset === null) return "not_found";
  truncateSync(jsonl, offset);
  return "truncated";
}
