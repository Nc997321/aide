import { spawn } from "node:child_process";
import { join } from "node:path";
import { freePort } from "./fixture.mjs";

export const delay = (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds));

export async function waitFor(check, label, timeout = 20000) {
  const until = Date.now() + timeout;
  let last;
  let lastError;
  while (Date.now() < until) {
    try { last = await check(); if (last) return last; }
    catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await delay(100);
  }
  const detail = typeof last === "object" ? JSON.stringify(last) : String(last);
  throw new Error(`timed out waiting for ${label}: ${detail}${lastError ? `; last error: ${lastError}` : ""}`);
}

export async function launch(fixture) {
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const child = spawn(fixture.executable, [fixture.root, ...fixture.files], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(fixture.root, "profile"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}` },
  });
  const runtime = { child, endpoint, output: "", clients: [] };
  child.stdout.on("data", (chunk) => { runtime.output = (runtime.output + chunk).slice(-8000); });
  child.stderr.on("data", (chunk) => { runtime.output = (runtime.output + chunk).slice(-8000); });
  child.on("error", (error) => { runtime.output += error.message; });
  return runtime;
}

export async function targets(runtime) {
  if (runtime.child.exitCode !== null) throw new Error(`probe exited ${runtime.child.exitCode}: ${runtime.output}`);
  const response = await fetch(`${runtime.endpoint}/json/list`);
  if (!response.ok) throw new Error(`CDP discovery failed: ${response.status}`);
  return response.json();
}

export async function connect(runtime, predicate) {
  let target;
  try { target = await waitFor(async () => (await targets(runtime)).find(predicate), "probe webview", 20000); }
  catch (error) {
    const observed = await targets(runtime).catch(() => []);
    const pages = observed.map((page) => ({ type: page.type, title: page.title, url: page.url.replace(/\/media\/[a-f0-9]+\//g, "/media/<redacted>/") }));
    throw new Error(`${error.message}; targets=${JSON.stringify(pages)}; process=${runtime.output}`);
  }
  const client = await Cdp.connect(target.webSocketDebuggerUrl);
  runtime.clients.push(client);
  return client;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.sequence = 0;
    socket.addEventListener("message", ({ data }) => this.receive(JSON.parse(data)));
    socket.addEventListener("close", () => {
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error("probe target closed")); }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((accept, reject) => { socket.addEventListener("open", accept, { once: true }); socket.addEventListener("error", reject, { once: true }); });
    return new Cdp(socket);
  }
  receive(message) {
    const item = this.pending.get(message.id);
    if (!item) return;
    this.pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message));
    else item.accept(message.result);
  }
  call(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 20000);
      this.pending.set(id, { accept, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const value = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  }
  close() { this.socket.close(); }
}

export async function stop(runtime) {
  for (const client of runtime.clients) client.close();
  if (runtime.child.exitCode === null) {
    runtime.child.kill();
    await Promise.race([new Promise((accept) => runtime.child.once("exit", accept)), delay(3000)]);
  }
}
