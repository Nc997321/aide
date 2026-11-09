import { WebSocket } from "undici";
import { asRecord } from "../../format.js";

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** 仅验收用：把真实 Chromium 的 CDP 接到既有 query 桥，绝不连接用户浏览器或用户 profile。 */
export class Cdp {
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  readonly navigation = { state: "ready", url: "about:blank" };
  calls = 0;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => this.failPending(new Error("fixture CDP socket closed")));
    socket.addEventListener("error", () => this.failPending(new Error("fixture CDP socket error")));
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    const client = new Cdp(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture CDP connect timeout")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("fixture CDP connect failed")); }, { once: true });
    });
    await client.command("Page.enable");
    return client;
  }

  command(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    this.calls += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`fixture CDP timeout: ${method}`)); }, 10_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const reply = await this.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply["exceptionDetails"]) throw new Error(`Fixture script threw: ${JSON.stringify(reply["exceptionDetails"])}`);
    return asRecord(reply["result"])?.["value"];
  }

  private receive(text: string): void {
    try {
      const message = asRecord(JSON.parse(text) as unknown);
      if (!message) throw new Error("fixture CDP returned a non-object");
      if (typeof message["id"] !== "number") { this.observeNavigation(message); return; }
      const pending = this.pending.get(message["id"]);
      if (!pending) return;
      this.pending.delete(message["id"]);
      clearTimeout(pending.timer);
      pending.resolve(message["error"] ? { error: message["error"] } : asRecord(message["result"]) ?? {});
    } catch (error) {
      this.failPending(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private observeNavigation(message: Record<string, unknown>): void {
    const method = message["method"];
    if (method === "Page.frameStartedLoading") this.navigation.state = "loading";
    if (method === "Page.frameStoppedLoading") this.navigation.state = "ready";
    if (method === "Page.frameNavigated") {
      const frame = asRecord(asRecord(message["params"])?.["frame"]);
      if (frame && frame["parentId"] === undefined && typeof frame["url"] === "string") this.navigation.url = frame["url"];
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }

  close(): void {
    this.socket.close();
  }
}
