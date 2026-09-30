// 冒烟脚本共用的结果台账：逐条 check 打印 PASS/FAIL，report 收尾汇总。

interface CheckRow { name: string; ok: boolean; note: string }
const ledger: CheckRow[] = [];

export function check(name: string, ok: boolean, note = ""): void {
  ledger.push({ name, ok, note });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${note ? ` — ${note}` : ""}`);
}

/** 台账收尾：打印汇总、复位 exitCode 供脚本决定去留。返回失败数。 */
export function report(): number {
  const bad = ledger.filter((r) => !r.ok);
  console.log(`\n[ledger] ${ledger.length - bad.length}/${ledger.length} passed`);
  for (const r of bad) console.log(`[ledger] FAILED: ${r.name} ${r.note}`);
  return bad.length;
}
