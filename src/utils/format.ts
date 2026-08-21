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

/**
 * 文件内容格式化（JSON / JSONL）。
 *
 * - .json：JSON.parse + 2 空格缩进美化，结尾补 \n。
 * - .jsonl：逐行 JSON.parse + 紧凑重序列化，保持一行一条记录——
 *   会话文件是每行一条记录，SDK/CLI 按行读取，展开成多行 pretty 后
 *   保存会导致 Claude 无法再读该会话（无法 --resume）。
 * - 其他扩展名：不支持（调用方按扩展名决定是否显示入口，这里是兜底）。
 */

export type FormatResult = { ok: true; text: string } | { ok: false; error: string };

export function formatContent(content: string, ext: string): FormatResult {
  if (ext === "jsonl") return formatJsonl(content);
  if (ext === "json") return formatJson(content);
  return { ok: false, error: `暂不支持格式化 .${ext} 文件` };
}

function formatJson(content: string): FormatResult {
  const trimmed = content.trim();
  if (!trimmed) return { ok: true, text: "" };
  try {
    const value = JSON.parse(trimmed);
    return { ok: true, text: JSON.stringify(value, null, 2) + "\n" };
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${(e as Error).message}` };
  }
}

function formatJsonl(content: string): FormatResult {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.stringify(JSON.parse(line)));
    } catch (e) {
      return { ok: false, error: `第 ${i + 1} 行 JSON 解析失败：${(e as Error).message}` };
    }
  }
  return { ok: true, text: out.length ? out.join("\n") + "\n" : "" };
}
