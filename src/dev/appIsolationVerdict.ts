// 应用隔离实验的判定（纯函数，与 DOM / IPC 无关，便于单测）。
// 探针页（src-tauri/src/commands/app_probe_frame.html）把每条通往 Tauri IPC 的路的结局报上来，
// 这里据此下结论。设计见 docs/superpowers/specs/2026-10-09-sidebar-apps-design.md §4。

export type ProbeOutcome = "reachable" | "blocked" | "absent" | "timeout" | "present";

export interface ProbeResult {
  id: string;
  /** gate = 调通即隔离失败；net = 自行联网；info = 仅供参考。 */
  kind: "gate" | "net" | "info";
  outcome: ProbeOutcome;
  detail: string;
}

/** 一个被测 frame 的回报；`null` = 限时内没收到（页面没加载出来，或脚本没跑）。 */
export type VariantReport = { origin: string; results: ProbeResult[] } | null;

export interface VariantSpec {
  id: string;
  label: string;
  /** 对照组：与主页面同源、不加沙箱，**应当**调得通——证明探针有牙。 */
  control?: boolean;
  /** 带严格 CSP 投递：自行联网应当被拦。 */
  strictCsp?: boolean;
}

export type Verdict = "pass" | "fail" | "inconclusive";

export interface Judgement {
  verdict: Verdict;
  reasons: string[];
}

const reaches = (report: VariantReport, kind: ProbeResult["kind"]) =>
  (report?.results ?? []).filter((r) => r.kind === kind && r.outcome === "reachable");

/**
 * @param executed Host 侧金丝雀实际收到的记号（`<变体 id>:<探针 id>`）；`null` = 没取到。
 *   frame 里「超时」不等于「命令没执行」：postMessage 那条 IPC 的回应送不回子 frame，
 *   所以**命令到底跑没跑只认这份记录**。
 */
export function judge(
  specs: VariantSpec[],
  reports: Record<string, VariantReport>,
  executed: string[] | null,
): Judgement {
  const failures: string[] = [];
  const doubts: string[] = [];
  const ranFor = (id: string) => (executed ?? []).filter((nonce) => nonce.startsWith(`${id}:`));
  if (executed === null) doubts.push("没取到 Host 侧的执行记录，超时的调用无法定性");

  for (const spec of specs) {
    const report = reports[spec.id] ?? null;
    if (spec.control) {
      // 对照组调不通，说明探针测不出东西：其余「调不通」都不能算数。
      if (!report) doubts.push(`${spec.label}：对照页没有回报`);
      else if (reaches(report, "gate").length === 0) doubts.push(`${spec.label}：对照页也调不通 IPC，探针无效`);
      else if (executed !== null && ranFor(spec.id).length === 0)
        doubts.push(`${spec.label}：对照页调通了，Host 侧却没有执行记录，记录不可信`);
      continue;
    }
    for (const nonce of ranFor(spec.id)) {
      failures.push(`${spec.label}：命令在 Host 侧实际执行了（${nonce}），即使 frame 没收到回应`);
    }
    if (!report) {
      failures.push(`${spec.label}：页面没加载出来，这种投递方式不可用`);
      continue;
    }
    for (const hit of reaches(report, "gate")) {
      failures.push(`${spec.label}：${hit.id} 调通了 IPC（${hit.detail}）`);
    }
    if (spec.strictCsp && reaches(report, "net").length > 0) {
      failures.push(`${spec.label}：CSP 没拦住自行联网`);
    }
  }

  if (failures.length > 0) return { verdict: "fail", reasons: [...failures, ...doubts] };
  if (doubts.length > 0) return { verdict: "inconclusive", reasons: doubts };
  return { verdict: "pass", reasons: [] };
}
