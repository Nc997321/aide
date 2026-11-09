import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asRecord } from "../../format.js";
import { Cdp } from "./cdp.js";

export type FixtureBrowser = { cdp: Cdp; close: () => Promise<void> };

export async function startFixtureBrowser(): Promise<FixtureBrowser> {
  const executable = browserExecutable();
  const profile = await mkdtemp(join(tmpdir(), "aide-browser-operation-"));
  const child = launch(executable, profile);
  try {
    const cdp = await connectPage(await debugEndpoint(child));
    return { cdp, close: () => closeBrowser({ child, profile, cdp }) };
  } catch (error) {
    await closeBrowser({ child, profile });
    throw error;
  }
}

function browserExecutable(): string {
  const override = process.env.AIDE_BROWSER_ACCEPTANCE_BIN;
  if (override) return override;
  const candidates = process.platform === "win32"
    ? [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter((base): base is string => Boolean(base))
      .flatMap((base) => [join(base, "Google", "Chrome", "Application", "chrome.exe"), join(base, "Microsoft", "Edge", "Application", "msedge.exe")])
    : ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("Set AIDE_BROWSER_ACCEPTANCE_BIN to an installed Chromium/Edge executable.");
  return executable;
}

function launch(executable: string, profile: string): ChildProcess {
  return spawn(executable, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--remote-debugging-port=0",
    `--user-data-dir=${profile}`, "about:blank",
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
}

function debugEndpoint(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("headless browser did not publish a debugging endpoint")), 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`headless browser exited early (${code})`)); });
    let output = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-20_000);
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output);
      if (match?.[1]) { clearTimeout(timer); resolve(match[1]); }
    });
  });
}

async function connectPage(endpoint: string): Promise<Cdp> {
  const url = new URL(endpoint);
  const response = await fetch(`http://${url.host}/json/list`);
  const targets: unknown = await response.json();
  if (!Array.isArray(targets)) throw new Error("CDP target list was not an array");
  const target = targets.map(asRecord).find((entry) => entry?.["type"] === "page");
  const socket = target?.["webSocketDebuggerUrl"];
  if (typeof socket !== "string") throw new Error("CDP did not expose the isolated fixture page");
  return Cdp.connect(socket);
}

async function closeBrowser(resource: { child: ChildProcess; profile: string; cdp?: Cdp }): Promise<void> {
  if (resource.cdp) {
    try { await resource.cdp.command("Browser.close"); }
    catch (error) { if (resource.child.exitCode === null) console.warn("Fixture Browser.close:", error); }
    resource.cdp.close();
  }
  await waitForExit(resource.child);
  await rm(resource.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 3_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}
