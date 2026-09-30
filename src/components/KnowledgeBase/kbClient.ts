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
  /** "doc" | "folder"。老服务端不带这个字段，消费方按 doc 兜底。 */
  kind?: "doc" | "folder";
  /** 内容的存储类型（`text/markdown` / `text/html`）。老服务端不带 → 按 markdown 兜底。 */
  mime?: string;
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
  /** 摘要片段，后端 ts_headline 产出。高亮是 `[[HL]]…[[/HL]]` 哨兵而不是 HTML 标签——
   *  渲染时先整体转义再按哨兵切（见 KbSearchView.renderSnippet）。 */
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

/** 编辑锁的当前持有人（LockHolder 的镜像）。 */
export interface KbLockHolder {
  userId: string;
  displayName: string;
  expiresAt: string;
}

/** 取锁结果。held=true 表示自己拿到了；false 时 holder 是当前持锁人。 */
export interface KbLockView {
  held: boolean;
  holder: KbLockHolder | null;
}

/** 上传结果（IngestResponse 的镜像）。warnings 是解析器自报的降级信息，
 *  要如实显示给用户（「导入后内容少了」得能解释清楚）。 */
export interface KbIngestResult {
  documentId: string;
  revisionId: string;
  title: string;
  /** 实际生效的解析后端，排障用 */
  backend: string;
  warnings: string[];
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
    throw networkError();
  }

  if (resp.status === 401) {
    // 令牌过期或被吊销：清掉本地 token，让上层回落到登录界面
    setToken(null);
  }

  const text = await resp.text();
  const data: unknown = text ? JSON.parse(text) : null;

  if (!resp.ok) throw errorFrom(resp.status, data);

  return data as T;
}

/** fetch 抛异常 = **网络层**失败（连不上 / DNS / CORS 被拦）。最常见的成因是服务没起，
 *  提示要能直接指到这一点。三条自走 fetch 的路径（JSON / 上传 / 取资源）共用它。 */
function networkError(): KbError {
  return new KbError(
    "network",
    `连不上知识库服务（${getBaseUrl()}）。确认 knowledge-server 已启动`,
    0,
  );
}

/** 非 2xx → KbError。服务端的 `{ error, message }` 是中文，直接给用户看。 */
function errorFrom(status: number, data: unknown): KbError {
  const d = data as { error?: string; message?: string } | null;
  return new KbError(
    d?.error ?? "http_error",
    d?.message ?? `请求失败（HTTP ${status}）`,
    status,
  );
}

/**
 * 带进度的 POST。**全文件唯一不走 fetch 的一处**：fetch 没有上传进度事件，
 * 而「传一个 30 MB 的 pdf，界面上一点动静都没有」正是这条要修的事。
 *
 * 进度封顶在 99%：字节传完之后服务端还要解析 + 落库（docx 要几秒），
 * 那段时间不是"还在传"，调用方据此把文案换成「正在处理…」。
 */
function postWithProgress(
  url: string,
  headers: Record<string, string>,
  form: FormData,
  onProgress?: (pct: number) => void,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) {
        onProgress?.(Math.min(99, Math.round((e.loaded / e.total) * 100)));
      }
    };
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(networkError());
    // 取消没有入口（界面上没有中断上传的按钮），但真被取消时要说清楚，
    // 不能伪装成网络故障
    xhr.onabort = () => reject(new KbError("aborted", "上传被中断了，请重试", 0));
    xhr.send(form);
  });
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
  /** 改空间元数据。**只有 name**——key 改了会断链，可见性改动面太大，服务端也不收。 */
  patchSpace(id: string, input: { name: string }): Promise<KbSpace> {
    return request<KbSpace>("PATCH", `/api/spaces/${id}`, input);
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
    /** 缺省 = 普通文档 */
    kind?: "doc" | "folder";
  }): Promise<{ documentId: string; revisionId: string; versionNo: number; merged: boolean }> {
    return request("POST", "/api/documents", input);
  },
  /** 改节点元数据：重命名、移动。**不产生版本**（标题上移之后改名是节点元数据）。
   *
   *  `parentId` 是三态：**缺省 = 不动父级**；`null` = 移到根；有值 = 移到该文件夹。
   *  服务端用 double_option 分档，所以传 `{ title }` 不会误把节点移到根。 */
  patchDocument(
    id: string,
    input: { title?: string; parentId?: string | null },
  ): Promise<{ documentId: string; revisionId: string; versionNo: number; merged: boolean }> {
    return request("PATCH", `/api/documents/${id}`, input);
  },
  updateDocument(
    id: string,
    input: { title: string; content: string; changeNote?: string | null },
  ): Promise<{ documentId: string; revisionId: string; versionNo: number; merged: boolean }> {
    return request("PUT", `/api/documents/${id}`, input);
  },
  /** 软删：服务端把**子文档一并**置为已删，`deletedCount` 是含根在内的总篇数
   *  （与 `docTree.subtreeSize` 同口径——确认弹窗的预估和这里的回执必须说同一个数）。 */
  deleteDocument(id: string): Promise<{ documentId: string; deletedCount: number }> {
    return request("DELETE", `/api/documents/${id}`);
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

  // 编辑锁。取锁 POST / 心跳 POST / 释放 DELETE——路径见 knowledge-server/src/api/mod.rs。
  // 心跳必须以小于 KB_LOCK_TTL_SECONDS（默认 300s）的间隔打，前端约定 30s。
  acquireLock(id: string): Promise<KbLockView> {
    return request("POST", `/api/documents/${id}/lock`);
  },
  lockHeartbeat(id: string): Promise<{ renewed: boolean }> {
    return request("POST", `/api/documents/${id}/lock/heartbeat`);
  },
  releaseLock(id: string): Promise<{ released: boolean }> {
    return request("DELETE", `/api/documents/${id}/lock`);
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

  /** 签一张取件票（预览地址）。要 Bearer——票**只换得来这一份条目**的只读字节，
   *  换不来账号、换不来写。地址形如 `${getBaseUrl()}/p/${token}`，
   *  有效期见服务端 PREVIEW_TTL_SECS（10 分钟），过期重新点一次即可。 */
  previewToken(id: string): Promise<{ token: string; expiresAt: number }> {
    return request("POST", `/api/documents/${id}/preview-token`);
  },

  // 摄取
  formats(): Promise<{ extensions: string[] }> {
    return request("GET", "/api/ingest/formats");
  },

  /** 上传一个文件进来。`spaceId` 必填、`parentId` 可选（缺省进根）。
   *
   *  **认哪些格式由服务端说了算**（`formats()`）：调用方先拿它做 accept 与预检，
   *  不认的当场拒绝——不预判、不硬编格式表。
   *
   *  不复用 `request()`：那个内核只发 JSON，这是 multipart。
   */
  async ingest(input: {
    spaceId: string;
    parentId?: string | null;
    file: File;
    /** 字节上传进度 0..100（**不含**服务端解析落库的时间）。可选。 */
    onProgress?: (pct: number) => void;
  }): Promise<KbIngestResult> {
    const params = new URLSearchParams({ spaceId: input.spaceId });
    if (input.parentId) params.set("parentId", input.parentId);

    const form = new FormData();
    // 字段名按服务端 `next_field()` 的约定（它取第一个字段当文件）
    form.append("file", input.file, input.file.name);

    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    // ⚠️ 不设 Content-Type：multipart 的 boundary 必须由浏览器生成

    const { status, text } = await postWithProgress(
      `${getBaseUrl()}/api/ingest?${params}`,
      headers,
      form,
      input.onProgress,
    );

    if (status === 401) setToken(null);

    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // 413 这类拒绝没有 JSON 体（axum 的 body-limit 拒绝是纯文本），别让解析炸掉
      data = null;
    }

    if (status < 200 || status >= 300) {
      // 服务端的 32 MiB 上限（DefaultBodyLimit，见 knowledge-server/src/api/mod.rs）：
      // 给可读的话，别把裸 413 抛给用户
      if (status === 413) {
        throw new KbError("too_large", "文件太大，单个文件最大 32 MB", 413);
      }
      throw errorFrom(status, data);
    }
    return data as KbIngestResult;
  },

  /** 取资源字节（文档正文里 `asset://<uuid>` 引用的图片）。
   *
   *  为什么不能用 `<img src="/api/assets/xxx">`：浏览器的图片请求**发不出**
   *  `Authorization` 头，而本服务用 Bearer 鉴权，那样必然 401（spec §8.2）。
   *  调用方拿到 Blob 后转 objectURL 交给 img。
   *
   *  不复用上面的 `request()`：那个内核对非 JSON 响应会 JSON.parse 炸掉，
   *  而这里要的是二进制。
   */
  async getAsset(id: string): Promise<Blob> {
    const url = `${getBaseUrl()}/api/assets/${encodeURIComponent(id)}`;
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;

    let resp: Response;
    try {
      resp = await fetch(url, { headers });
    } catch {
      throw networkError();
    }

    if (resp.status === 401) setToken(null);
    if (!resp.ok) {
      // 不能让 403 静默变成一张空图 —— 上层据此决定退化成 alt 文本
      throw new KbError("asset_error", `图片加载失败（HTTP ${resp.status}）`, resp.status);
    }
    return await resp.blob();
  },
};
