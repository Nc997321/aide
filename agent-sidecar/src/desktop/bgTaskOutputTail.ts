import { existsSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { ChatEvent } from "../types.js";

/** 单次 tick 的读上限（1MB）：超限截断、剩余下次续读——防大输出文件一次读爆
 *  内存（sync 全量 allocUnsafe 曾是 OOM 与事件循环卡死的来源，审查 P0-2）。 */
const MAX_TAIL_READ_BYTES = 1024 * 1024;

/**
 * 后台 shell 任务的输出文件 tail（per-SessionWorker 实例，对齐 OutputTail 的管理方式：
 * 实例本身只负责 offset 增量读，Map/定时器由 SessionWorker 持有）。
 *
 * 与子代理 .output 的区别：子代理的是 JSONL 转录（逐行解析成结构化事件），后台命令的
 * 输出文件是纯文本（ANSI 原样），按 offset 增量读、原样以 bg_task_output 增量事件发出
 * （出口过 deltaCoalescer 合并，不会逐字节洪峰）。
 *
 * chunk 边界可能切在 UTF-8 多字节字符中间——用 StringDecoder 把半截字节留到下次补齐，
 * 避免输出里出现 � 替换符。
 */
export class BgTaskTail {
  private offset = 0;
  private readonly decoder = new StringDecoder("utf8");
  private stopped = false;
  /** 在途读的共享 promise：并发 tick 复用同一次读（定时器与 finalFlush 竞态时，
   *  后到者等先到者完成——finalFlush 必须拿到"最后一读之后"的 decoder 状态）。 */
  private ticking: Promise<void> | null = null;
  constructor(
    private readonly id: string,
    private readonly outputFile: string,
    private readonly emit: (e: ChatEvent) => void,
  ) {}

  /** 读自上次 offset 以来的新增字节并 emit。已停止/文件不存在/无增长时安静跳过。
   *  异步增量读（fs/promises，不阻塞事件循环）；单次最多读 MAX_TAIL_READ_BYTES，
   *  超出部分下次续读（审查 P0-2）。读失败由调用方 catch，下次轮询重试。 */
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.ticking) return this.ticking;
    const p = this.doRead().finally(() => { this.ticking = null; });
    this.ticking = p;
    return p;
  }

  private async doRead(): Promise<void> {
    if (!existsSync(this.outputFile)) return; // 命令还没写出第一行
    let fd: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const st = await stat(this.outputFile);
      if (st.size < this.offset) this.offset = 0; // 文件被截断/换新：从头再来
      if (st.size === this.offset) return;
      fd = await open(this.outputFile, "r");
      const want = Math.min(st.size - this.offset, MAX_TAIL_READ_BYTES);
      const buf = Buffer.allocUnsafe(want);
      // 注意：不用 fs/promises 顶层 read()——Node 22.22 无此导出（2026-08-23 实测
      // undefined），用 FileHandle.read 方法（两 API 同语义：位置读，返回 bytesRead）。
      const { bytesRead } = await fd.read(buf, 0, want, this.offset);
      this.offset += bytesRead;
      const text = this.decoder.write(buf.subarray(0, bytesRead));
      if (text) this.emit({ type: "bg_task_output", id: this.id, delta: text });
    } finally {
      if (fd !== undefined) await fd.close();
    }
  }

  /** 停止前最后冲一次——任务结束信号到 stop 之间可能还有未读的尾巴；
   *  decoder 里残留的半截字节（文件本就不完整时）也兜底吐出，不丢内容。
   *  await 在途读（若定时器恰好在读）后再 end decoder，顺序不丢。 */
  async finalFlush(): Promise<void> {
    await this.tick();
    const rest = this.decoder.end();
    if (rest) this.emit({ type: "bg_task_output", id: this.id, delta: rest });
    this.stopped = true;
  }

  stop(): void {
    this.stopped = true;
  }
}
