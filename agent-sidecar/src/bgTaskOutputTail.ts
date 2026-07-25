import { existsSync, openSync, readSync, statSync, closeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { ChatEvent } from "./types.js";

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
  constructor(
    private readonly id: string,
    private readonly outputFile: string,
    private readonly emit: (e: ChatEvent) => void,
  ) {}

  /** 读自上次 offset 以来的新增字节并 emit。已停止/文件不存在/无增长时安静跳过。 */
  tick(): void {
    if (this.stopped) return;
    if (!existsSync(this.outputFile)) return; // 命令还没写出第一行
    let fd: number | undefined;
    try {
      const st = statSync(this.outputFile);
      if (st.size < this.offset) this.offset = 0; // 文件被截断/换新：从头再来
      if (st.size === this.offset) return;
      fd = openSync(this.outputFile, "r");
      const buf = Buffer.allocUnsafe(st.size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = st.size;
      const text = this.decoder.write(buf);
      if (text) this.emit({ type: "bg_task_output", id: this.id, delta: text });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** 停止前最后冲一次——任务结束信号到 stop 之间可能还有未读的尾巴；
   *  decoder 里残留的半截字节（文件本就不完整时）也兜底吐出，不丢内容。 */
  finalFlush(): void {
    this.tick();
    const rest = this.decoder.end();
    if (rest) this.emit({ type: "bg_task_output", id: this.id, delta: rest });
    this.stopped = true;
  }

  stop(): void {
    this.stopped = true;
  }
}
