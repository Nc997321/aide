// 应用隔离实验的执行端（侧栏应用 P0）。Ctrl+Alt+Shift+I 触发，仅在桌面以 AIDE_APP_PROBE=1
// 启动时生效；平时这个模块不会被加载（App.vue 里是动态 import）。
//
// 做法：在主窗口里挂几个 iframe，每个都加载同一张探针页（它扮演恶意应用），对比结局——
//   对照   与主页面同源、不加沙箱：应当调得通 IPC（证明探针有牙）
//   其余   从回环地址加载：应当一条都调不通
// 结论与原始结果显示在屏幕上，并落盘到临时目录。
import { getTransport } from "@aide/sdk";

import { judge, type VariantReport, type VariantSpec } from "./appIsolationVerdict";

interface ProbeInfo {
  port: number;
  token: string;
  os: string;
}

interface Variant extends VariantSpec {
  sandbox?: string;
  /** srcdoc = 继承主页面来源；否则从回环地址加载。 */
  sameOrigin?: boolean;
}

const VARIANTS: Variant[] = [
  { id: "control", label: "对照：同源、无沙箱", control: true, sameOrigin: true },
  { id: "loopback", label: "回环地址、无沙箱" },
  { id: "sandbox", label: "回环地址 + 沙箱", sandbox: "allow-scripts allow-forms allow-pointer-lock" },
  {
    id: "sandbox-csp",
    label: "回环地址 + 沙箱 + CSP（定案方案）",
    sandbox: "allow-scripts allow-forms allow-pointer-lock",
    strictCsp: true,
  },
];

const WAIT_MS = 15_000;
let running = false;

export async function runAppIsolationProbe(): Promise<void> {
  if (running) return;
  let info: ProbeInfo;
  try {
    info = await getTransport().invoke<ProbeInfo>("app_probe_start");
  } catch (e) {
    // 没开实验开关：安静地什么都不做（这个快捷键对普通用户不存在）。
    console.info("[app-probe]", e);
    return;
  }
  running = true;
  const base = `http://127.0.0.1:${info.port}/${info.token}`;
  const panel = buildPanel();
  panel.status.textContent = "正在探测…";

  try {
    const frameHtml = await (await fetch(`${base}/frame.html`, { cache: "no-store" })).text();
    const reports: Record<string, VariantReport> = {};
    await Promise.all(
      VARIANTS.map(async (v) => {
        reports[v.id] = await runVariant(v, base, frameHtml, panel.stage);
      }),
    );

    // 命令到底跑没跑，只认 Host 侧的记录（frame 里的「超时」定不了性）。
    let executed: string[] | null = null;
    try {
      executed = await getTransport().invoke<string[]>("app_probe_hits");
    } catch (e) {
      console.info("[app-probe] hits unavailable", e);
    }
    const judgement = judge(VARIANTS, reports, executed);
    const report = {
      at: new Date().toISOString(),
      os: info.os,
      build: import.meta.env.DEV ? "dev" : "release",
      appOrigin: window.location.origin,
      userAgent: navigator.userAgent,
      judgement,
      executed,
      variants: VARIANTS.map((v) => ({ ...v, report: reports[v.id] })),
    };
    const json = JSON.stringify(report, null, 2);
    console.info("[app-probe]", report);
    let savedTo = "";
    try {
      savedTo = await getTransport().invoke<string>("app_probe_report", { json });
    } catch (e) {
      savedTo = `（落盘失败：${String(e)}）`;
    }
    render(panel, judgement.verdict, judgement.reasons, savedTo, json);
  } catch (e) {
    panel.status.textContent = `实验没跑起来：${String(e)}`;
  } finally {
    running = false;
  }
}

function runVariant(v: Variant, base: string, frameHtml: string, stage: HTMLElement): Promise<VariantReport> {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    // 变体名与回环地址经 window.name 传进去（srcdoc 没有 URL 可带参）。
    frame.name = JSON.stringify({ variant: v.id, ping: `${base}/ping` });
    frame.style.cssText = "width:1px;height:1px;border:0;opacity:0;";
    if (v.sandbox) frame.setAttribute("sandbox", v.sandbox);

    const finish = (report: VariantReport) => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      frame.remove();
      resolve(report);
    };
    const onMessage = (e: MessageEvent) => {
      // 不透明来源没法校验 origin，只认「是不是这个 frame 发的」——正式的桥也这么校验。
      if (e.source !== frame.contentWindow || !e.data?.aideAppProbe) return;
      finish({ origin: String(e.data.origin), results: e.data.results ?? [] });
    };
    const timer = setTimeout(() => finish(null), WAIT_MS);
    window.addEventListener("message", onMessage);

    if (v.sameOrigin) frame.srcdoc = frameHtml;
    else frame.src = `${base}/frame.html${v.strictCsp ? "?csp=1" : ""}`;
    stage.appendChild(frame);
  });
}

interface Panel {
  root: HTMLElement;
  status: HTMLElement;
  body: HTMLElement;
  stage: HTMLElement;
}

function buildPanel(): Panel {
  document.getElementById("aide-app-probe")?.remove();
  const root = document.createElement("div");
  root.id = "aide-app-probe";
  root.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:99999;width:560px;max-height:70vh;overflow:auto;" +
    "padding:12px 14px;border:1px solid var(--aide-border);border-radius:8px;" +
    "background:var(--aide-bg-raised);color:var(--aide-text-primary);font-size:12px;line-height:1.5;";
  const head = document.createElement("div");
  head.style.cssText = "display:flex;justify-content:space-between;align-items:center;font-weight:600;";
  head.textContent = "应用隔离实验";
  const close = document.createElement("button");
  close.textContent = "关闭";
  close.style.cssText = "color:var(--aide-text-primary);";
  close.onclick = () => root.remove();
  head.appendChild(close);
  const status = document.createElement("div");
  const body = document.createElement("div");
  const stage = document.createElement("div");
  root.append(head, status, body, stage);
  document.body.appendChild(root);
  return { root, status, body, stage };
}

const VERDICT_TEXT = { pass: "通过", fail: "失败", inconclusive: "无结论" } as const;
const VERDICT_COLOR = {
  pass: "var(--aide-success)",
  fail: "var(--aide-danger)",
  inconclusive: "var(--aide-text-secondary)",
} as const;

function render(panel: Panel, verdict: keyof typeof VERDICT_TEXT, reasons: string[], savedTo: string, json: string) {
  panel.status.textContent = `结论：${VERDICT_TEXT[verdict]}`;
  panel.status.style.cssText = `font-size:14px;font-weight:600;margin:6px 0;color:${VERDICT_COLOR[verdict]};`;
  panel.body.replaceChildren();
  for (const reason of reasons) {
    const line = document.createElement("div");
    line.textContent = `· ${reason}`;
    panel.body.appendChild(line);
  }
  const saved = document.createElement("div");
  saved.style.cssText = "margin-top:6px;color:var(--aide-text-secondary);user-select:text;";
  saved.textContent = `结果已保存：${savedTo}`;
  const raw = document.createElement("pre");
  raw.style.cssText = "margin-top:6px;white-space:pre-wrap;word-break:break-all;user-select:text;";
  raw.textContent = json;
  panel.body.append(saved, raw);
}
