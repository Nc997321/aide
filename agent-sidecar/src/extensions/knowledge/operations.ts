// 多步写操作：返回**给模型看的文本**（成功与失败都是文本），与 knowledgeTools.ts 的
// kbCall 同属「失败也返回文本」这条红线。
//
// 为什么这些操作要多一步 GET：知识库的 PUT 是整篇替换且**没有乐观锁**，只有 300s
// 同作者合并窗口与文档行锁兜底。所以凡改已有文档，必须先把当前正文读回来再拼，
// 否则并发下静默覆盖别人的修改（设计 spec §4.2）。
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import {
  docPath,
  type KbClient,
  type KbDeleteResult,
  type KbDocument,
  type KbIngestResult,
  type KbSaveResult,
  type KbSpace,
  type KbUpload,
} from "./client.js";
import { decideSpace, type SpaceDecision } from "./space.js";
import { applySelectionEdit, type KbScopeStore } from "./scope.js";
import {
  KB_CONTENT_MAX_BYTES,
  KB_DOC_MAX_BYTES,
  KB_INGEST_MAX_BYTES,
  formatDeletedDocument,
  formatFailure,
  formatIngestResult,
  formatSavedDocument,
  formatTooLarge,
  warnTruncatedSource,
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

export interface DeleteArgs {
  documentId: string;
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

export interface NewFolder {
  spaceId: string;
  title: string;
  parentId?: string;
}

export interface MoveArgs {
  documentId: string;
  /** 省略 = 移到根 */
  parentId?: string;
}

/**
 * 建文件夹。与 `createDocument` 分开而不是加个 `kind` 开关：两者的入参不同
 * （文件夹没有 content）、给模型看的工具描述也不同，塞进一个函数只会让两边的
 * 差异藏进分支里。
 */
export async function createFolder(client: KbClient, args: NewFolder): Promise<string> {
  const saved = await client.sendJson<KbSaveResult>("/api/documents", "POST", {
    spaceId: args.spaceId,
    title: args.title,
    kind: "folder",
    ...(args.parentId ? { parentId: args.parentId } : {}),
  });
  return saved.ok
    ? `Created the knowledge base folder "${args.title}". documentId ${saved.data.documentId} — pass it as parentId to create_document or ingest_file to file things inside it.`
    : formatFailure(saved.failure);
}

/**
 * 移动节点。
 *
 * **先读一跳**，与 `deleteDocument` 同一条理由：回执要点名搬的是哪一个（用户得
 * 核对），且 404/403 必须在这一步就如实返回。读回来的 `parentId` 还让「已经在
 * 目标位置」能被识别成空操作——否则模型会以为搬成功了，而服务端那边其实什么
 * 都没发生。
 */
export async function moveDocument(client: KbClient, args: MoveArgs): Promise<string> {
  const cur = await client.getJson<KbDocument>(docPath(args.documentId));
  if (!cur.ok) return formatFailure(cur.failure);

  const target = args.parentId ?? null;
  if ((cur.data.parentId ?? null) === target) {
    return `"${cur.data.title}" is already ${target ? `under ${target}` : "at the top level"} — nothing moved.`;
  }

  // ⚠️ 必须显式发 parentId（null 也算发）：服务端用 double_option 三态区分
  // 「字段缺省 = 不动」与「null = 移到根」，省掉这个键就变成前者了。
  const res = await client.sendJson<unknown>(docPath(args.documentId), "PATCH", {
    parentId: target,
  });
  if (!res.ok) return formatFailure(res.failure);

  const where = target ? `under folder ${target}` : "to the top level of the space";
  return `Moved "${cur.data.title}" ${where} (documentId ${args.documentId}).`;
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

  // 旧文比 read_document 能展示的还长 → 回执里点明（警告不阻断）。形状不对（非串）时
  // 跳过警告并照常写：整篇替换不会丢「我们看不见的东西」，为一句提示拒绝一次用户已
  // 批准的重写是过度收紧（append 的守卫是另一回事——那里非串会真的删掉别人的正文）。
  const carriedOver = typeof cur.data.content === "string" ? warnTruncatedSource(cur.data.content) : "";

  const saved = await client.sendJson<KbSaveResult>(docPath(args.documentId), "PUT", {
    title: args.title ?? cur.data.title,
    content: args.content,
    ...(args.changeNote ? { changeNote: args.changeNote } : {}),
  });
  return saved.ok ? formatSavedDocument(saved.data, "Updated") + carriedOver : formatFailure(saved.failure);
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

/**
 * 软删（服务端删父文档会连整棵子树一起置 `deleted_at`）。
 *
 * 先读一跳的理由：回执要点名删掉的是哪一篇（`formatDeletedDocument` 要标题），
 * 且 404/403 必须在这一步就如实返回——**读不到的文档不许走到 DELETE**，
 * 否则用户收到的是"已删除"，而真相是他给错了 id。
 */
export async function deleteDocument(client: KbClient, args: DeleteArgs): Promise<string> {
  const cur = await client.getJson<KbDocument>(docPath(args.documentId));
  if (!cur.ok) return formatFailure(cur.failure);

  const res = await client.sendJson<KbDeleteResult>(docPath(args.documentId), "DELETE");
  if (!res.ok) return formatFailure(res.failure);

  return formatDeletedDocument(cur.data.title, args.documentId, res.data.deletedCount);
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

export interface EditSelectionArgs {
  selectionId: string;
  newText: string;
  changeNote?: string;
}

/** 变更说明默认值：把用户的意见带进版本历史，谁看都知道这次为什么改。 */
function selectionChangeNote(comment: string): string {
  const c = comment.trim().replace(/\s+/g, " ");
  return `AI edited the user's selection${c ? `: ${c.length > 160 ? `${c.slice(0, 160)}…` : c}` : ""}`;
}

/**
 * 只改用户圈选的那一段（edit_selection）。
 *
 * 范围来自 KbScopeStore（用户消息的 kbref 块登记的），**不来自 agent 的参数**——agent 只能给
 * 「替换成什么」。写入前校验选区原文仍在原位（文档在圈选之后被改过就拒绝，让用户重新圈）；
 * 新正文 = 原文前缀 + 新文本 + 原文后缀，所以选区之外是构造性不变；写入后再读回一次核对
 * 前后缀，并发改动导致的漂移如实报出来（PUT 没有乐观锁，这是能做到的最强保证）。
 */
export async function editSelection(client: KbClient, scopes: KbScopeStore, args: EditSelectionArgs): Promise<string> {
  const scope = scopes.get(args.selectionId);
  if (!scope) {
    const known = scopes.list().map((s) => s.id);
    return known.length
      ? `Refused: there is no selection "${args.selectionId}". Selections available this turn: ${known.join(", ")}.`
      : "Refused: the user has not selected anything in a knowledge base document this turn, so there is no selection to edit.";
  }
  if (!withinLimit(args.newText, KB_CONTENT_MAX_BYTES)) {
    return formatTooLarge("newText", KB_CONTENT_MAX_BYTES);
  }

  const cur = await client.getJson<KbDocument>(docPath(scope.documentId));
  if (!cur.ok) return formatFailure(cur.failure);
  const content = cur.data.content;
  if (typeof content !== "string") {
    return formatFailure({ kind: "bad_response", detail: "document payload has no `content` string" });
  }

  const edit = applySelectionEdit(content, scope, args.newText);
  if (!edit.ok) {
    return `Refused: the selected text is no longer where the user selected it in 《${scope.title}》 (version ${cur.data.versionNo}, the user selected at version ${scope.baseVersion}) — the document was edited after the selection. Nothing was changed. Ask the user to select the text again.`;
  }
  if (!withinLimit(edit.body, KB_DOC_MAX_BYTES)) {
    return formatTooLarge("the document after editing", KB_DOC_MAX_BYTES);
  }

  const saved = await client.sendJson<KbSaveResult>(docPath(scope.documentId), "PUT", {
    title: cur.data.title,
    content: edit.body,
    changeNote: args.changeNote?.trim() || selectionChangeNote(scope.comment),
  });
  if (!saved.ok) return formatFailure(saved.failure);

  // 读回核对：选区之外的前后缀必须与写入前逐字相同。读回失败不推翻写入成功，只是如实说没核对。
  const prefix = content.slice(0, scope.start);
  const suffix = content.slice(scope.end);
  const after = await client.getJson<KbDocument>(docPath(scope.documentId));
  let verified = "";
  if (after.ok && typeof after.data.content === "string") {
    const intact = after.data.content.startsWith(prefix) && after.data.content.endsWith(suffix);
    verified = intact
      ? " Verified: everything outside the selection is unchanged."
      : " WARNING: after saving, the text outside the selection no longer matches what it was before — someone may have edited the document at the same moment. Tell the user and point them to the version history.";
  } else {
    verified = " (Could not re-read the document to verify the surroundings.)";
  }

  scopes.moveTo(scope.id, {
    start: edit.start,
    end: edit.end,
    text: args.newText,
    baseVersion: saved.data.versionNo,
  });
  return formatSavedDocument(saved.data, "Edited the selection in") + verified;
}
