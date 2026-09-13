// 多步写操作：返回**给模型看的文本**（成功与失败都是文本），与 knowledgeTools.ts 的
// kbCall 同属「失败也返回文本」这条红线（codegraphTools.ts:50 先例）。
//
// 为什么这些操作要多一步 GET：知识库的 PUT 是整篇替换且**没有乐观锁**，只有 300s
// 同作者合并窗口与文档行锁兜底。所以凡改已有文档，必须先把当前正文读回来再拼，
// 否则并发下静默覆盖别人的修改（设计 spec §4.2）。
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import {
  docPath,
  type KbClient,
  type KbDocument,
  type KbIngestResult,
  type KbSaveResult,
  type KbSpace,
  type KbUpload,
} from "./client.js";
import { decideSpace, type SpaceDecision } from "./space.js";
import {
  KB_CONTENT_MAX_BYTES,
  KB_DOC_MAX_BYTES,
  KB_INGEST_MAX_BYTES,
  formatFailure,
  formatIngestResult,
  formatSavedDocument,
  formatTooLarge,
} from "./format.js";

/** 新建文档的载荷（domain DTO：一个概念，不是杂物 options 袋）。 */
export interface NewDocument {
  spaceId: string;
  title: string;
  content: string;
  parentId?: string;
}

export interface UpdateArgs {
  documentId: string;
  content: string;
  title?: string;
  changeNote?: string;
}

export interface AppendArgs {
  documentId: string;
  content: string;
  changeNote?: string;
}

/** 正文是否在字节上限内（用 UTF-8 字节数，不用 JS 的 UTF-16 长度）。 */
function withinLimit(content: string, maxBytes: number): boolean {
  return Buffer.byteLength(content, "utf8") <= maxBytes;
}

/**
 * 写目标空间：显式传入直接用；省略 → 拉可见空间交给 decideSpace 决策
 * （多空间/零空间都回「问用户」的文本，绝不替用户挑）。
 */
export async function resolveWriteTarget(client: KbClient, requested?: string): Promise<SpaceDecision> {
  if (requested) return { kind: "ok", id: requested };
  const spaces = await client.getJson<KbSpace[]>("/api/spaces");
  if (!spaces.ok) return { kind: "ask", text: formatFailure(spaces.failure) };
  return decideSpace(undefined, spaces.data);
}

/** 新建文档。空间由调用方先经 resolveWriteTarget 解析好。 */
export async function createDocument(client: KbClient, doc: NewDocument): Promise<string> {
  if (!withinLimit(doc.content, KB_CONTENT_MAX_BYTES)) {
    return formatTooLarge("content", KB_CONTENT_MAX_BYTES);
  }
  const saved = await client.sendJson<KbSaveResult>("/api/documents", "POST", {
    spaceId: doc.spaceId,
    title: doc.title,
    content: doc.content,
    ...(doc.parentId ? { parentId: doc.parentId } : {}),
  });
  return saved.ok ? formatSavedDocument(saved.data, "Created") : formatFailure(saved.failure);
}

/** 整篇替换。先读当前版本：既拿到沿用用的 title，也让 404/403 在读这一跳就如实返回。 */
export async function updateDocument(client: KbClient, args: UpdateArgs): Promise<string> {
  // 只查「单次正文」上限——**刻意不查 KB_DOC_MAX_BYTES**：replace 的正文就是整篇，
  // 256 KiB 的单次上限已经蕴含 1 MiB 的整篇上限（spec §4.2 把整篇上限写成
  // 「append / update 共用」，对 update 而言那条是冗余臂：真加进来会是一条永远
  // 走不到的分支）。整篇上限真正拦得住的是 append 的**累积**。
  if (!withinLimit(args.content, KB_CONTENT_MAX_BYTES)) {
    return formatTooLarge("content", KB_CONTENT_MAX_BYTES);
  }
  const cur = await client.getJson<KbDocument>(docPath(args.documentId));
  if (!cur.ok) return formatFailure(cur.failure);

  const saved = await client.sendJson<KbSaveResult>(docPath(args.documentId), "PUT", {
    title: args.title ?? cur.data.title,
    content: args.content,
    ...(args.changeNote ? { changeNote: args.changeNote } : {}),
  });
  return saved.ok ? formatSavedDocument(saved.data, "Updated") : formatFailure(saved.failure);
}

/** 追加 = 读当前正文 → 拼在末尾 → 整篇写回。沉淀类内容的默认写法。 */
export async function appendToDocument(client: KbClient, args: AppendArgs): Promise<string> {
  // 单次段落闸：与 create / update 同一条（spec §4.2 的常量表写明「append 只算新增段落」）。
  // 少了它，一次 append 能塞进近 1 MiB 新正文——而这段正文会**整段铺在权限弹窗里**让用户
  // 读（§9 第 7 条），且「单次调用」的语义在写侧三件里就它没有约束。
  if (!withinLimit(args.content, KB_CONTENT_MAX_BYTES)) {
    return formatTooLarge("content", KB_CONTENT_MAX_BYTES);
  }

  const cur = await client.getJson<KbDocument>(docPath(args.documentId));
  if (!cur.ok) return formatFailure(cur.failure);

  // 读回的正文必须是串：形态漂移（服务端换版本 / 中间代理）时若照 `?? ""` 拼，
  // 写回的是「只有新段落」的文档 = 静默删掉别人的正文。**宁可不写**（spec 附录 B
  // 记过这条：P1 删掉 `?? ""` 防御臂正是因为这个后果）。
  const current = cur.data.content;
  if (typeof current !== "string") {
    return formatFailure({ kind: "bad_response", detail: "document payload has no `content` string" });
  }

  const body = `${current}\n\n${args.content}`;
  if (!withinLimit(body, KB_DOC_MAX_BYTES)) {
    return formatTooLarge("the document after appending", KB_DOC_MAX_BYTES);
  }

  const saved = await client.sendJson<KbSaveResult>(docPath(args.documentId), "PUT", {
    title: cur.data.title,
    content: body,
    ...(args.changeNote ? { changeNote: args.changeNote } : {}),
  });
  return saved.ok ? formatSavedDocument(saved.data, "Appended to") : formatFailure(saved.failure);
}

export interface IngestArgs {
  filePath: string;
  spaceId?: string;
  parentId?: string;
}

/**
 * 导入磁盘文件（md/txt/docx/pdf，服务端按扩展名分派解析器）。
 *
 * 路径规则沿 `buildDocxTools(cwd)` 先例：相对路径按会话 cwd 解析，绝对路径直接用。
 * 扩展名**不在客户端预判**——服务端 `/api/ingest/formats` 是唯一权威，不支持的
 * 类型由它 400 + 中文 message，我们原样透出（避免两处格式清单漂移）。
 * 尺寸在**读文件之前**用 stat 挡掉，避免为了报错把 32 MiB 读进内存。
 */
export async function ingestFile(client: KbClient, cwd: string, args: IngestArgs): Promise<string> {
  const abs = isAbsolute(args.filePath) ? args.filePath : resolve(cwd, args.filePath);

  let size: number;
  try {
    const st = statSync(abs);
    if (!st.isFile()) {
      return `Not a file: ${args.filePath}. Pass a path to a regular file on disk.`;
    }
    size = st.size;
  } catch {
    return `File not found: ${args.filePath}. Check the path (relative paths resolve against the session working directory).`;
  }

  if (size > KB_INGEST_MAX_BYTES) return formatTooLarge("the file", KB_INGEST_MAX_BYTES);

  let data: Buffer;
  try {
    data = readFileSync(abs);
  } catch (e) {
    return `Could not read ${args.filePath}: ${e instanceof Error ? e.message : String(e)}`;
  }

  const upload: KbUpload = { filename: basename(abs), data };
  const r = await client.sendFile<KbIngestResult>(
    "/api/ingest",
    { spaceId: args.spaceId, parentId: args.parentId },
    upload,
  );
  return r.ok ? formatIngestResult(r.data) : formatFailure(r.failure);
}
