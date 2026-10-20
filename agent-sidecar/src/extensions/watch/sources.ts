// 值守的两种来源怎么读：桌面窗口（经电脑操作的桥，读控件树）/ 只读命令（在 Host 上跑一次取输出）。

import { spawn } from "node:child_process";
import type { ChatEvent } from "../../engine/types.js";
import { queryComputer } from "../computer/client.js";
import { formatRead } from "../computer/format.js";
import { commandLines, windowLines } from "./diff.js";
import type { ReadResult, WatchSource } from "./manager.js";

const MAX_OUTPUT_BYTES = 64 * 1024;

export function makeReader(emit: (e: ChatEvent) => void, cwd: () => string | undefined) {
  return async (source: WatchSource, hint: { label: string; everyMs: number }): Promise<ReadResult> => {
    if (source.kind === "window") {
      const r = await queryComputer(
        {
          op: "read",
          window_id: source.windowId,
          ...(source.scope ? { scope: source.scope } : {}),
          watch: { label: hint.label, every_ms: hint.everyMs },
        },
        emit,
      );
      if (!r.ok) {
        const error = r.error ?? "read failed";
        return { ok: false, error, gone: /no longer exists/i.test(error) };
      }
      return { ok: true, lines: windowLines(formatRead(r.data)) };
    }
    const out = await runCommand(source.command, cwd(), Math.max(5_000, Math.min(30_000, hint.everyMs * 0.8)));
    return out.ok ? { ok: true, lines: commandLines(out.text) } : { ok: false, error: out.text };
  };
}

/** 跑一次命令（系统 shell：Windows 是 cmd.exe，其余 /bin/sh），取合并输出；超时即杀。 */
export function runCommand(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { shell: true, cwd: cwd || undefined, windowsHide: true });
    } catch (e) {
      resolve({ ok: false, text: `cannot start the command: ${String((e as Error)?.message ?? e)}` });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const take = (b: Buffer) => {
      if (size >= MAX_OUTPUT_BYTES) return;
      chunks.push(b.subarray(0, MAX_OUTPUT_BYTES - size));
      size += b.length;
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, text: `the command did not finish within ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `cannot run the command: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8");
      // 非零退出码也算读到了（输出照样比对），只把退出码附在末尾
      resolve({ ok: true, text: code ? `${text}\n[exit code ${code}]` : text });
    });
  });
}
