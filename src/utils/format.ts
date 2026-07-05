/**
 * 把较大的 token 数量压成「36.1k / 150k / 1.2m」这种一眼扫过去就有量级感的
 * 缩写形式——原始的完整数字（36108、150170）放进 tooltip，不在这里丢失精度。
 * 千位以下原样显示（没必要为个位数也套上 k）。
 */
export function formatCompactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(n);
  if (abs < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(1)}m`;
}
