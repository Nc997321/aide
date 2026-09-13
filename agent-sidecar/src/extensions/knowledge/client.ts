// 知识库 REST 薄客户端：baseUrl + Bearer token + 超时 + 错误归一。
// 只做传输，不认识业务语义（工具在 knowledgeTools.ts，文案在 format.ts）。
//
// 失败一律归一成 KbFailure（判别联合），**不抛**——工具层红线是「失败也返回文本」，
// 抛异常会让 agent 卡在错误上（codegraphTools.ts:50 先例）。fetch 可注入，单测不需要
// 真起 HTTP 服务。
import type { KbRuntimeConfig } from "./config.js";

// 配置类型随客户端一并再导出：消费方（工具层/测试）只需依赖本模块就能拿到入参类型。
export type { KbRuntimeConfig };

// ── 失败归一 ──

export type KbFailure =
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "locked"; message: string }
  | { kind: "bad_request"; message: string }
  | { kind: "server"; status: number }
  | { kind: "network"; baseUrl: string; detail: string }
  | { kind: "timeout" }
  | { kind: "bad_response"; detail: string };

export type KbResult<T> = { ok: true; data: T } | { ok: false; failure: KbFailure };

// ── REST DTO（镜像 knowledge-server 的 serde camelCase）──

export interface KbSpace {
  id: string;
  key: string;
  name: string;
  visibility: string;
  role?: string;
}
export interface KbDocumentSummary {
  id: string;
  parentId?: string | null;
  slug: string;
  title: string;
  versionNo: number;
  status: string;
  updatedAt: string;
}
export interface KbDocument {
  id: string;
  spaceId: string;
  parentId?: string | null;
  slug: string;
  title: string;
  content: string;
  versionNo: number;
  status: string;
}
export interface KbSearchHit {
  documentId: string;
  spaceId: string;
  title: string;
  versionNo: number;
  rank: number;
  snippet: string;
}
export interface KbSearchResult {
  query: string;
  hits: KbSearchHit[];
}
export interface KbSaveResult {
  documentId: string;
  revisionId: string;
  versionNo: number;
  merged: boolean;
}
export interface KbIngestResult {
  documentId: string;
  revisionId: string;
  title: string;
  backend: string;
  warnings?: string[];
}

// ── 客户端 ──

export type KbQuery = Record<string, string | number | undefined>;

/** multipart 上传内容：字节由调用方（工具层）读完并做过尺寸校验，这里只负责传。 */
export interface KbUpload {
  filename: string;
  data: Uint8Array;
}

export interface KbClient {
  getJson<T>(path: string, query?: KbQuery): Promise<KbResult<T>>;
  sendJson<T>(path: string, method: "POST" | "PUT", body: unknown): Promise<KbResult<T>>;
  sendFile<T>(path: string, query: KbQuery, file: KbUpload): Promise<KbResult<T>>;
}

export const KB_HTTP_TIMEOUT_MS = 15_000;
export const KB_INGEST_TIMEOUT_MS = 120_000;

type FetchLike = typeof fetch;

/** 编码可能抛 URIError（孤立代理项）——入参来自模型，必须兜住：永不抛是本模块红线。 */
function safeEncode(s: string): string {
  try {
    return encodeURIComponent(s);
  } catch {
    return encodeURIComponent(s.replace(/[\uD800-\uDFFF]/g, "\uFFFD"));
  }
}

/** 查询串：undefined 跳过（可选参数不该出现在 URL 里）。纯函数，测试直接覆盖。 */
export function withQuery(path: string, query?: KbQuery): string {
  if (!query) return path;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    parts.push(`${safeEncode(k)}=${safeEncode(String(v))}`);
  }
  return parts.length > 0 ? `${path}?${parts.join("&")}` : path;
}

/**
 * 文档路径。id 是 uuid，但**必须**编码——编码挡的是拼接手误（如模型传了带 `/` 的
 * 字符串），一旦裸拼就会多出一段路径、打到别的端点上。读写两侧共用这一个构造器。
 */
export function docPath(documentId: string): string {
  return `/api/documents/${safeEncode(documentId)}`;
}

/** HTTP 状态 + 错误体 → 领域失败。错误体形状 `{error, message}`（message 是中文）。 */
export function toFailure(status: number, bodyText: string): KbFailure {
  const message = extractMessage(bodyText);
  if (status === 401) return { kind: "unauthorized" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "not_found" };
  if (status === 409) return { kind: "locked", message };
  if (status >= 500) return { kind: "server", status };
  return { kind: "bad_request", message };
}

/** 错误体 `{error, message}` → message；解析不了就回一段截断原文（永不抛）。 */
function extractMessage(bodyText: string): string {
  try {
    const v: unknown = JSON.parse(bodyText);
    if (typeof v === "object" && v !== null) {
      const m = (v as Record<string, unknown>).message;
      if (typeof m === "string" && m.length > 0) return m;
    }
  } catch {
    // 不是 JSON：退回截断原文（服务端 5xx 时可能是反向代理的 HTML）
  }
  return bodyText.slice(0, 200);
}

/** 原始响应：「拿到了响应」与「没拿到」的分界（拿不到 → KbFailure）。 */
type RawResult = { ok: true; status: number; text: string } | { ok: false; failure: KbFailure };

/** 响应判定：2xx 解析成 data，其余归一成 KbFailure。不引用闭包状态，故放模块作用域。 */
async function finish<T>(r: RawResult): Promise<KbResult<T>> {
  if (!r.ok) return r;
  if (r.status < 200 || r.status >= 300) {
    return { ok: false, failure: toFailure(r.status, r.text) };
  }
  try {
    return { ok: true, data: JSON.parse(r.text) as T };
  } catch {
    return { ok: false, failure: { kind: "bad_response", detail: "response body is not JSON" } };
  }
}

/**
 * 造 raw：cfg/fetchImpl 由这层闭包带进来，返回的闭包仍是 4 个输入。
 * 拆这一层的目的是让 createKbClient 只剩拼装，三者各自都不超 40 行。
 */
function makeRaw(cfg: KbRuntimeConfig, fetchImpl: FetchLike) {
  return async function raw(
    method: string,
    path: string,
    body: RequestInit["body"],
    timeoutMs: number,
  ): Promise<RawResult> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(`${cfg.baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${cfg.token}`,
          ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}),
        },
        ...(body === undefined ? {} : { body }),
        signal: ctl.signal,
      });
      return { ok: true, status: resp.status, text: await resp.text() };
    } catch (e) {
      // abort 只有一种来源：上面那个超时定时器
      if (ctl.signal.aborted) return { ok: false, failure: { kind: "timeout" } };
      return {
        ok: false,
        failure: {
          kind: "network",
          baseUrl: cfg.baseUrl,
          detail: e instanceof Error ? e.message : String(e),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createKbClient(cfg: KbRuntimeConfig, fetchImpl: FetchLike = fetch): KbClient {
  const raw = makeRaw(cfg, fetchImpl);
  return {
    async getJson<T>(path: string, query?: KbQuery): Promise<KbResult<T>> {
      return finish<T>(await raw("GET", withQuery(path, query), undefined, KB_HTTP_TIMEOUT_MS));
    },
    async sendJson<T>(path: string, method: "POST" | "PUT", body: unknown): Promise<KbResult<T>> {
      return finish<T>(await raw(method, path, JSON.stringify(body), KB_HTTP_TIMEOUT_MS));
    },
    async sendFile<T>(path: string, query: KbQuery, file: KbUpload): Promise<KbResult<T>> {
      const form = new FormData();
      form.append("file", new Blob([file.data]), file.filename);
      return finish<T>(await raw("POST", withQuery(path, query), form, KB_INGEST_TIMEOUT_MS));
    },
  };
}
