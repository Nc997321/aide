import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { ChatEvent } from "./types.js";
import { emitSubagentBlocks } from "./mapper.js";

/** 单次 tick 的读上限（1MB）：超限截断、剩余下次续读——防大输出文件一次读爆
 *  内存（sync 全量 allocUnsafe 曾是 OOM 与事件循环卡死的来源，审查 P0-2）。 */
const MAX_TAIL_READ_BYTES = 1024 * 1024;

/** 解析 .output 的一行 JSONL → 子代理事件。空行/非法 JSON 安静丢弃（.output 尾部可能有半行）。 */
export function parseOutputLine(line: string, id: string, emit: (e: ChatEvent) => void, claimModel: () => boolean): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: any;
  try { msg = JSON.parse(trimmed); } catch { return; } // 半行/损坏：等下次轮询补全
  emitSubagentBlocks(msg, id, emit, claimModel);
}

/** 一个 async 子代理的 .output tail：从上次 offset 读新增的完整行，逐行解析转发。 */
/** 一个 async 子代理的 .output tail：从上次 offset 读新增的完整行，逐行解析转发。
 *  两种宿主共用本类：模块级全局池（下方 legacy 路径，mapper 缺省走它）与
 *  SessionWorker 的 per-instance TailPool（engine/tailPool.ts）。 */
export class OutputTail {
  private offset = 0;
  private leftover = "";
  private modelClaimed = false;
  private stopped = false;
  /** 在途读守卫：异步 tick 与定时器下轮互斥，防并发重复读同一区间。 */
  private ticking = false;
  constructor(
    private readonly id: string,
    private readonly outputFile: string,
    private readonly emit: (e: ChatEvent) => void,
  ) {}
  /** 异步增量读（fs/promises，不阻塞事件循环）；单次最多读 MAX_TAIL_READ_BYTES，
   *  超出部分下次 tick 续读——大输出文件不再一次 allocUnsafe 全量 + 同步 readSync
   *  卡死事件循环（审查 P0-2）。读失败/文件消失由调用方 catch，下次轮询重试。 */
  async tick(): Promise<void> {
    if (this.stopped || this.ticking) return;
    if (!existsSync(this.outputFile)) return; // 子代理还没开始写
    this.ticking = true;
    let fd: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const st = await stat(this.outputFile);
      if (st.size < this.offset) { this.offset = 0; this.leftover = ""; } // 文件被截断/换新
      if (st.size === this.offset) return;
      fd = await open(this.outputFile, "r");
      const want = Math.min(st.size - this.offset, MAX_TAIL_READ_BYTES);
      const buf = Buffer.allocUnsafe(want);
      // 注意：不用 fs/promises 顶层 read()——Node 22.22 无此导出（2026-08-23 实测
      // undefined），用 FileHandle.read 方法（两 API 同语义：位置读，返回 bytesRead）。
      const { bytesRead } = await fd.read(buf, 0, want, this.offset);
      this.offset += bytesRead;
      const data = this.leftover + buf.subarray(0, bytesRead).toString("utf8");
      const lines = data.split(/\r?\n/);
      this.leftover = lines.pop() ?? ""; // 最后一段可能是不完整行，留给下次
      const claimModel = () => (this.modelClaimed ? false : (this.modelClaimed = true));
      for (const line of lines) parseOutputLine(line, this.id, this.emit, claimModel);
    } finally {
      this.ticking = false;
      if (fd !== undefined) await fd.close();
    }
  }
  stop(): void { this.stopped = true; }
}

const tails = new Map<string, OutputTail>();
let timer: NodeJS.Timeout | undefined;

/** 启动一个 .output tail，加入全局轮询。幂等：同 id 重复启动忽略。 */
export function startOutputTail(id: string, outputFile: string, emit: (e: ChatEvent) => void): void {
  if (tails.has(id)) return;
  tails.set(id, new OutputTail(id, outputFile, emit));
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
      // fire-and-forget：异步读不阻塞事件循环；单条 tail 出错（文件被删/读失败）
      // 不影响其它 tail，下次轮询自动重试。
      void t.tick().catch(() => { /* 单条 tail 出错不影响其它 */ });
    }
  }, 600); // 600ms：肉眼「实时」又不至于 IO 洪峰（每 tail 一个 stat+read）
  timer.unref(); // 不挡进程退出
}
