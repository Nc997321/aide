// 知识库服务（knowledge-server）的 REST 客户端。
//
// ⚠️ 刻意**不走 aide-sdk 的 transport**（`invoke("xxx")` 那套）：SDK 的通道后端是
// aide 桌面 app 的 Rust 命令，而知识库是**独立进程**，直连它才符合"独立服务"的定位。
// 这里只沿用了 SDK 的工程约定（DTO 镜像 Rust serde camelCase、门面平铺方法），
// 运行时通道是自己走的 fetch。
//
// 鉴权用 Bearer token 而不是 cookie，原因在服务端 extract.rs 里写清楚了：
// Tauri v2 的 WebView origin 是 http://tauri.localhost，与本服务不同源，
// 跨站 cookie 会被 SameSite=Lax 挡掉——那是死结，不是配置问题。

const BASE_KEY = "aide.kb.baseUrl";
const TOKEN_KEY = "aide.kb.token";

/** 默认指向本机 knowledge-server 的端口，与 knowledge-server/.env.example 一致。 */
const DEFAULT_BASE = "http://127.0.0.1:8788";

// ── 连接配置（localStorage，切换环境不用改代码）──

export function getBaseUrl(): string {
  return localStorage.getItem(BASE_KEY) || DEFAULT_BASE;
}

export function setBaseUrl(url: string): void {
  localStorage.setItem(BASE_KEY, url.replace(/\/+$/, ""));
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string | null): void {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

// ── 邀请链接 ──
//
// 链接形态：`http://host:8788/join#<token>`。
// 用 hash 而不是 query 是有意的：hash **不会发到服务端**，
// 一条邀请链接被贴进工单系统时，token 不会出现在服务的访问日志里。
// 解析时两种输入都收：整条链接，或同事从聊天窗口里单独复制出来的裸 token。

export function inviteLink(token: string): string {
  return `${getBaseUrl()}/join#${token}`;
}

export function parseInviteToken(input: string): string {
  const s = input.trim();
  if (!s) return "";
  // 裸 token：不含 / 与 #，也不含空格
  if (!s.includes("/") && !s.includes("#")) return s;

  try {
    const u = new URL(s);
    return u.hash.replace(/^#/, "").trim() || u.searchParams.get("token")?.trim() || "";
  } catch {
    // 不是合法 URL（比如只贴了后半段），退回按 # 切
    return s.slice(s.indexOf("#") + 1).trim();
  }
}

// ── DTO（镜像 knowledge-server 的 serde camelCase）──

export interface KbUser {
  id: string;
  /** 登录名。邀请制下没人填邮箱，用户名才是主身份标识。 */
  username: string;
  email: string | null;
  displayName: string;
  isAdmin: boolean;
}

export interface KbLoginResult {
  token: string;
  user: KbUser;
}

/** 实例有没有初始化过。空库 = false → 前端显示「创建管理员」引导页。 */
export interface KbStatus {
  initialized: boolean;
}

/** 邀请链接。明文 token **只在这一次响应里出现**，服务端只存哈希。 */
export interface KbInvite {
  token: string;
  username: string;
  expiresAt: string;
}

export interface KbUserRow {
  id: string;
  username: string;
  email: string | null;
  displayName: string;
  isAdmin: boolean;
  isActive: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

export type KbRole = "owner" | "admin" | "editor" | "viewer";

export interface KbSpace {
  id: string;
  key: string;
  name: string;
  description: string | null;
  visibility: "private" | "internal" | "public";
  /** 非成员时为 null */
  role: KbRole | null;
}

export interface KbDocumentSummary {
  id: string;
  parentId: string | null;
  slug: string;
  title: string;
  versionNo: number;
  status: string;
  updatedAt: string;
}

export interface KbDocument extends KbDocumentSummary {
  spaceId: string;
  content: string;
}

export interface KbSearchHit {
  documentId: string;
  spaceId: string;
  title: string;
  versionNo: number;
  rank: number;
  /** 带 <mark> 的摘要片段，后端 ts_headline 产出 */
  snippet: string;
}

export interface KbSearchResult {
  query: string;
  hits: KbSearchHit[];
}

export interface KbHealth {
  status: string;
  service: string;
  parsers: string[];
  tokenizer: string;
}

/** 服务端错误体：{ error, message }。message 是中文，直接给用户看。 */
export class KbError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "KbError";
  }
}

// ── 请求内核 ──

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  let url = `${getBaseUrl()}${path}`;
  if (query) {
    const qs = Object.entries(query)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // fetch 只在网络层失败（连不上 / DNS / CORS 被拦）才走到这里。
    // 最常见的成因是 knowledge-server 没起，提示要能直接指到这一点。
    throw new KbError(
      "network",
      `连不上知识库服务（${getBaseUrl()}）。确认 knowledge-server 已启动`,
      0,
    );
  }

  if (resp.status === 401) {
    // 令牌过期或被吊销：清掉本地 token，让上层回落到登录界面
    setToken(null);
  }

  const text = await resp.text();
  const data: unknown = text ? JSON.parse(text) : null;

  if (!resp.ok) {
    const d = data as { error?: string; message?: string } | null;
    throw new KbError(
      d?.error ?? "http_error",
      d?.message ?? `请求失败（HTTP ${resp.status}）`,
      resp.status,
    );
  }

  return data as T;
}

// ── API 门面（与 packages/aide-sdk/src/api.ts 同款平铺形态）──

export const kb = {
  health(): Promise<KbHealth> {
    return request<KbHealth>("GET", "/api/health");
  },

  // 认证（邀请制，没有自助注册入口）
  status(): Promise<KbStatus> {
    return request<KbStatus>("GET", "/api/auth/status");
  },
  /** 创建第一个管理员。只在库里一个用户都没有时可用，口令可选。 */
  async bootstrap(input: {
    username: string;
    displayName: string;
    password?: string;
    email?: string;
  }): Promise<KbUser> {
    const r = await request<KbLoginResult>("POST", "/api/auth/bootstrap", input);
    setToken(r.token);
    return r.user;
  },
  /** account 可以是用户名或邮箱。没设过口令的账号（凭邀请进来的）会被拒绝。 */
  async login(account: string, password: string): Promise<KbUser> {
    const r = await request<KbLoginResult>("POST", "/api/auth/login", { account, password });
    setToken(r.token);
    return r.user;
  },
  /** 凭管理员发的一次性邀请令牌领取账号。 */
  async join(token: string): Promise<KbUser> {
    const r = await request<KbLoginResult>("POST", "/api/auth/join", { token });
    setToken(r.token);
    return r.user;
  },
  logout(): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>("POST", "/api/auth/logout");
  },
  me(): Promise<KbUser> {
    return request<KbUser>("GET", "/api/auth/me");
  },

  // 用户管理（仅管理员）
  invite(input: {
    username: string;
    displayName: string;
    isAdmin?: boolean;
    spaceId?: string;
    spaceRole?: "owner" | "admin" | "editor" | "viewer";
  }): Promise<KbInvite> {
    return request<KbInvite>("POST", "/api/users/invite", input);
  },
  listUsers(): Promise<KbUserRow[]> {
    return request<KbUserRow[]>("GET", "/api/users");
  },
  revokeUser(id: string): Promise<{ ok: boolean }> {
    return request<{ ok: boolean }>("POST", `/api/users/${id}/revoke`);
  },

  // 空间
  listSpaces(): Promise<KbSpace[]> {
    return request<KbSpace[]>("GET", "/api/spaces");
  },
  createSpace(input: {
    key: string;
    name: string;
    description?: string | null;
    visibility?: "private" | "internal" | "public";
  }): Promise<KbSpace> {
    return request<KbSpace>("POST", "/api/spaces", input);
  },
  listDocuments(spaceId: string): Promise<KbDocumentSummary[]> {
    return request<KbDocumentSummary[]>("GET", `/api/spaces/${spaceId}/documents`);
  },

  // 文档
  getDocument(id: string): Promise<KbDocument> {
    return request<KbDocument>("GET", `/api/documents/${id}`);
  },
  createDocument(input: {
    spaceId: string;
    parentId?: string | null;
    title: string;
    content?: string;
  }): Promise<{ documentId: string; revisionId: string; versionNo: number; merged: boolean }> {
    return request("POST", "/api/documents", input);
  },
  updateDocument(
    id: string,
    input: { title: string; content: string; changeNote?: string | null },
  ): Promise<{ documentId: string; revisionId: string; versionNo: number; merged: boolean }> {
    return request("PUT", `/api/documents/${id}`, input);
  },

  // 版本
  revisions(id: string): Promise<
    {
      id: string;
      versionNo: number;
      title: string;
      authorId: string;
      authorName: string | null;
      changeNote: string | null;
      createdAt: string;
    }[]
  > {
    return request("GET", `/api/documents/${id}/revisions`);
  },
  revert(
    id: string,
    versionNo: number,
  ): Promise<{ documentId: string; revisionId: string; versionNo: number; merged: boolean }> {
    return request("POST", `/api/documents/${id}/revert`, { versionNo });
  },

  // 检索
  search(
    q: string,
    opts?: { spaceId?: string; limit?: number },
  ): Promise<KbSearchResult> {
    return request<KbSearchResult>("GET", "/api/search", undefined, {
      q,
      spaceId: opts?.spaceId,
      limit: opts?.limit,
    });
  },

  // 摄取
  formats(): Promise<{ extensions: string[] }> {
    return request("GET", "/api/ingest/formats");
  },
};
