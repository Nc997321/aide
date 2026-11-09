/** AIDE_BROWSER_ACCEPTANCE=1 pnpm exec vitest run agent-sidecar/src/extensions/browser/act/acceptance.test.ts
 * 独立 headless profile + 环回夹具 + 真实 CDP 输入。不是 Aide/WebView2 端到端，不调用模型。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { cancelAllBrowserQueries } from "../../browserClient.js";
import { performFill } from "../act.js";
import { waitForBrowser } from "../wait.js";
import { FixtureHost } from "./acceptance/host.js";
import { startFixtureBrowser, type FixtureBrowser } from "./acceptance/browser.js";

const VIEW = "fixture-view";
let server: Server | undefined;
let browser: FixtureBrowser | undefined;
let host: FixtureHost | undefined;
let baseUrl = "";

function fixture(): FixtureHost {
  if (!host) throw new Error("Fixture browser not initialized");
  return host;
}

function fill(selector: string, value: string) {
  return { action: "fill", selector, value };
}

function batch(steps: unknown[]) {
  return fixture().tool("browser_act", { action: "batch", view_id: VIEW, steps, scope: "main" });
}

async function startServer(): Promise<string> {
  const page = await readFile(new URL("../../../../../docs/testing/browser-operation-fixture.html", import.meta.url), "utf8");
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(page);
  });
  const listener = server;
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no TCP port");
  return `http://127.0.0.1:${address.port}`;
}

describe.skipIf(process.env.AIDE_BROWSER_ACCEPTANCE !== "1")("browser_act 隔离真实浏览器固定验收", () => {
  beforeAll(async () => {
    baseUrl = await startServer();
    browser = await startFixtureBrowser();
    host = new FixtureHost(browser.cdp);
  }, 30_000);
  beforeEach(async () => { await fixture().reset(`${baseUrl}/`); });
  afterEach(() => cancelAllBrowserQueries("fixture case finished"));
  afterAll(async () => {
    try { await browser?.close(); }
    finally {
      const listener = server;
      if (listener) await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("普通表单：一次 batch 三字段，input/change 都到达，反馈无需额外 read", async () => {
    const text = await batch([fill("#name", "泵-01"), fill("#note", "正常"), fill("#code", "P-001")]);
    const state = await fixture().state();
    expect(state).toMatchObject({ name: "泵-01", note: "正常", code: "P-001", changes: ["name", "note", "code"] });
    expect(text).toContain("Executed 3/3");
    expect(text).toContain("泵-01");
    expect(text).toContain("P-001");
    expect(fixture().toolCalls).toBe(1);
    expect(state["events"]).toEqual([{ id: "name", type: "input" }, { id: "note", type: "input" }, { id: "code", type: "input" }]);
  });

  it("异步联动：条件确认后才能填写具体设备", async () => {
    const text = await batch([
      { ...fill("#category", "pump"), wait_for: { condition: "!document.querySelector('#device').disabled && document.querySelector('#device').options.length === 2" } },
      fill("#device", "pump-01"),
    ]);
    expect(await fixture().state()).toMatchObject({ category: "pump", device: "pump-01", changes: ["category", "device"] });
    expect(text).toContain("Expected result CONFIRMED");
    expect(text).toContain("泵-01");
  });

  it("真实点击打开弹窗，当前批次可继续填写新字段", async () => {
    const text = await batch([
      { action: "click", text: "打开弹窗", wait_for: { condition: "!document.querySelector('#dialog').hidden" } },
      fill("#dialog-name", "弹窗设备"),
    ]);
    expect(await fixture().state()).toMatchObject({ dialog: true, dialogName: "弹窗设备", clicks: ["open"], trusted: [true] });
    expect(text).toContain("弹窗设备");
    expect(text).toContain("via CDP");
  });

  it("单步点击返回同页文字变化，不再只有 URL unchanged", async () => {
    const text = await fixture().tool("browser_act", { view_id: VIEW, action: "click", selector: "#update" });
    expect(await fixture().state()).toMatchObject({ status: "说明已更新", clicks: ["update"], trusted: [true] });
    expect(text).toContain("说明已更新");
  });

  it("真实 hover 事件及变化可见", async () => {
    const text = await batch([{ action: "hover", selector: "#hover", wait_for: { condition: "document.querySelector('#status').textContent === '悬停已确认'" } }]);
    expect(text).toContain("悬停已确认");
    expect(text).toContain("CONFIRMED");
  });

  it("真实 Enter/Tab 到达原焦点，observer 不抢焦点", async () => {
    const text = await batch([
      fill("#name", "键盘设备"), { action: "press", key: "Enter" },
      { action: "press", key: "Tab", wait_for: { condition: "document.activeElement.id === 'note'" } },
    ]);
    expect(await fixture().state()).toMatchObject({ name: "键盘设备", commits: 1, active: "note", keys: [{ key: "Enter", trusted: true }, { key: "Tab", trusted: true }] });
    expect(text).toContain("CONFIRMED");
  });

  it("跨文档导航：确认新页加载后再填写", async () => {
    const text = await batch([
      { action: "click", selector: "#next", wait_for: { until: "load" } }, fill("#name", "新页设备"),
    ]);
    expect(await fixture().state()).toMatchObject({ name: "新页设备", url: `${baseUrl}/next` });
    expect(text).toContain("document replaced");
    expect(text).toContain("CONFIRMED");
  });

  it("旧文档 ready 不能放过未发生的导航", async () => {
    const text = await batch([
      { action: "click", selector: "#no-op", wait_for: { until: "load", timeout_ms: 100 } }, fill("#name", "不应填写"),
    ]);
    expect(await fixture().state()).toMatchObject({ name: "", url: `${baseUrl}/` });
    expect(text).toContain("NOT CONFIRMED");
    expect(text).toContain("Stopped at step 1");
  });

  it("真实 selector 歧义拒绝，前一步保留、后一步不派发", async () => {
    const text = await batch([fill("#name", "保留"), fill(".ambiguous", "不应填写"), fill("#note", "不应填写")]);
    expect(await fixture().state()).toMatchObject({ name: "保留", note: "", changes: ["name"] });
    expect(text).toContain("matched 2 elements");
    expect(text).toContain("Stopped at step 2");
  });

  it("目标被真实点击移除，停止而不继续写别处", async () => {
    const text = await batch([{ action: "click", selector: "#remove" }, fill("#note", "不存在"), fill("#name", "不应填写")]);
    expect(await fixture().state()).toMatchObject({ note: null, name: "", clicks: ["remove"] });
    expect(text).toContain("Stopped at step 2");
  });

  it("框架回退输入不报成功、不填写下一字段", async () => {
    const text = await batch([fill("#controlled", "会回退"), fill("#name", "不应填写")]);
    expect(await fixture().state()).toMatchObject({ controlled: "", name: "", changes: ["controlled"] });
    expect(text).toContain("reads back");
    expect(text).toContain("Stopped at step 1");
  });

  it("条件超时停步，已经填写的字段不回滚", async () => {
    const text = await batch([{ ...fill("#name", "保留"), wait_for: { condition: "false", timeout_ms: 50 } }, fill("#note", "不应填写")]);
    expect(await fixture().state()).toMatchObject({ name: "保留", note: "" });
    expect(text).toContain("NOT CONFIRMED");
  });

  it("真实点击已发生但回包丢失：恰好提交一次，无合成重放", async () => {
    fixture().fault = "release-result-lost";
    const text = await batch([{ action: "click", selector: "#send" }, fill("#name", "不应填写")]);
    expect(await fixture().state()).toMatchObject({ commits: 1, name: "", clicks: ["send"], trusted: [true] });
    expect(text).toContain("[uncertain]");
    expect(text).not.toContain("SYNTHETIC");
  });

  it("明确 Input 不可用才合成降级，并通过条件确认其真实页面效果", async () => {
    fixture().fault = "input-unavailable";
    const text = await batch([{ action: "click", selector: "#open", wait_for: { condition: "!document.querySelector('#dialog').hidden" } }]);
    expect(await fixture().state()).toMatchObject({ dialog: true, clicks: ["open"], trusted: [false] });
    expect(text).toContain("SYNTHETIC");
    expect(text).toContain("CONFIRMED");
  });

  it("read → act → since_last：动作反馈没有挪走 read 的底稿", async () => {
    await fixture().tool("browser_read", { view_id: VIEW, scope: "main" });
    await batch([fill("#name", "read基准")]);
    const diff = await fixture().tool("browser_read", { view_id: VIEW, scope: "main", since_last: true });
    expect(diff).toContain("read基准");
    expect(diff).not.toContain("No changes since");
  });

  it("默认变化反馈不泄漏页面上的密码值", async () => {
    const text = await batch([fill("#name", "正常")]);
    expect(text).not.toContain("fixture-only-secret");
  });

  it("固定脚本往返实测：旧单步计划与新批次分别计工具和本地桥", async () => {
    const form = [fill("#name", "泵-01"), fill("#note", "正常"), fill("#code", "P-001")];
    const ordinary = await comparePlan(form);
    const linked = await comparePlan([
      { ...fill("#category", "pump"), wait_for: { condition: "!document.querySelector('#device').disabled" } }, fill("#device", "pump-01"),
    ]);
    expect(ordinary.before.tools).toBe(4);
    expect(ordinary.after.tools).toBe(1);
    expect(linked.before.tools).toBe(4);
    expect(linked.after.tools).toBe(1);
    process.stdout.write(`BROWSER_OPERATION_ACCEPTANCE ${JSON.stringify({ ordinary, linked })}\n`);
  });
});

type FillPlan = { action: string; selector: string; value: string; wait_for?: { condition: string } };

async function comparePlan(plan: FillPlan[]) {
  const before = await measurePlan({ mode: "legacy-single", plan });
  const after = await measurePlan({ mode: "batch", plan });
  expect(after.state).toMatchObject(before.state);
  return { before: before.metrics, after: after.metrics };
}

async function measurePlan(input: { mode: "legacy-single" | "batch"; plan: FillPlan[] }) {
  const host = fixture();
  await host.reset(`${baseUrl}/`);
  await host.tool("browser_read", { view_id: VIEW, scope: "main" });
  host.toolCalls = 0; host.bridgeCalls = 0; host.cdp.calls = 0;
  const started = Date.now();
  if (input.mode === "batch") await batch(input.plan);
  else await legacyPlan(input.plan);
  const metrics = { tools: host.toolCalls, bridge: host.bridgeCalls, cdp: host.cdp.calls, elapsedMs: Date.now() - started };
  const state = await host.state();
  return { metrics, state: { name: state["name"], note: state["note"], code: state["code"], category: state["category"], device: state["device"] } };
}

/** 基线回放只走原单步执行核心 + 独立 wait/read，不把新增单步 observer 的成本算到旧版头上。 */
async function legacyPlan(plan: FillPlan[]): Promise<void> {
  const host = fixture();
  for (const step of plan) {
    host.toolCalls += 1;
    const result = await performFill(VIEW, { selector: step.selector }, step.value, host.emit);
    expect(result.status).toBe("done");
    if (step.wait_for) {
      host.toolCalls += 1;
      const wait = await waitForBrowser({ viewId: VIEW, mode: "condition", condition: step.wait_for.condition, timeoutMs: 5000, intervalMs: 200 }, host.emit);
      expect(wait).toContain("Condition met");
    }
  }
  await host.tool("browser_read", { view_id: VIEW, scope: "main" });
}
