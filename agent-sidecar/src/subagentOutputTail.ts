import { existsSync, openSync, readSync, statSync, closeSync } from "node:fs";
import type { ChatEvent } from "./types.js";
import { emitSubagentBlocks } from "./mapper.js";

/** 解析 .output 的一行 JSONL → 子代理事件。空行/非法 JSON 安静丢弃（.output 尾部可能有半行）。 */
export function parseOutputLine(line: string, id: string, emit: (e: ChatEvent) => void, claimModel: () => boolean): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: any;
  try { msg = JSON.parse(trimmed); } catch { return; } // 半行/损坏：等下次轮询补全
  emitSubagentBlocks(msg, id, emit, claimModel);
}

/** 一个 async 子代理的 .output tail：从上次 offset 读新增的完整行，逐行解析转发。 */
class OutputTail {
  private offset = 0;
  private leftover = "";
  private modelClaimed = false;
  private stopped = false;
  constructor(
    private readonly id: string,
    private readonly outputFile: string,
    private readonly emit: (e: ChatEvent) => void,
    private readonly onStop: (id: string) => void,
  ) {}
  tick(): void {
    if (this.stopped) return;
    if (!existsSync(this.outputFile)) return; // 子代理还没开始写
    let fd: number | undefined;
    try {
      const st = statSync(this.outputFile);
      if (st.size < this.offset) { this.offset = 0; this.leftover = ""; } // 文件被截断/换新
      if (st.size === this.offset) return;
      fd = openSync(this.outputFile, "r");
      const buf = Buffer.allocUnsafe(st.size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = st.size;
      const data = this.leftover + buf.toString("utf8");
      const lines = data.split(/\r?\n/);
      this.leftover = lines.pop() ?? ""; // 最后一段可能是不完整行，留给下次
      const claimModel = () => (this.modelClaimed ? false : (this.modelClaimed = true));
      for (const line of lines) parseOutputLine(line, this.id, this.emit, claimModel);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  stop(): void { this.stopped = true; }
}

const tails = new Map<string, OutputTail>();
let timer: NodeJS.Timeout | undefined;

/** 启动一个 .output tail，加入全局轮询。幂等：同 id 重复启动忽略。 */
export function startOutputTail(id: string, outputFile: string, emit: (e: ChatEvent) => void, onStop: (id: string) => void): void {
  if (tails.has(id)) return;
  tails.set(id, new OutputTail(id, outputFile, emit, onStop));
  ensureTimer();
}

export function stopOutputTail(id: string): void {
  const t = tails.get(id);
  if (t) { t.stop(); tails.delete(id); }
  if (tails.size === 0 && timer) { clearInterval(timer); timer = undefined; }
}

export function stopAllOutputTails(): void {
  for (const t of tails.values()) t.stop();
  tails.clear();
  if (timer) { clearInterval(timer); timer = undefined; }
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => {
    for (const t of tails.values()) {
      try { t.tick(); } catch { /* 单条 tail 出错不影响其它 */ }
    }
  }, 600); // 600ms：肉眼「实时」又不至于 IO 洪峰（每 tail 一个 stat+read）
  if (typeof (timer as any).unref === "function") (timer as any).unref(); // 不挡进程退出
}
