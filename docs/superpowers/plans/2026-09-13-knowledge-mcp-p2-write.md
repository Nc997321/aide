# 知识库 MCP 插件 P2（写通路）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 P1 读通路之上，让 agent 能把内容写进知识库：新建 / 追加 / 整篇更新 / 导入本地文件，且**每次写入都走用户的权限确认**。

**Architecture:** 全部落在 sidecar 的 `aide-knowledge` server 内（P1 已建好凭据、客户端、格式化器与装配）。新增两个子文件：`knowledge/space.ts`（空间决策，纯函数）与 `knowledge/operations.ts`（多步写操作）。写工具**不进** `allowedTools` 白名单，由既有 `canUseTool` 弹窗把关。

**Tech Stack:** TypeScript（agent-sidecar，Node 20 + vitest）；multipart 用全局 `FormData`/`Blob`（Node 20 自带，已实测 tsconfig `lib: ["ES2022"]` + `@types/node` 下可用）

**Spec:** `docs/superpowers/specs/2026-09-13-knowledge-mcp-design.md`（§4.2 写工具、§7 权限模型、§9 已知代价）
**前置:** `2026-09-13-knowledge-mcp-p1-read.md` 必须已完成并全绿。

## Global Constraints

P1 的全部约束继续有效，另有：

- **写入前必须读**：知识库的 `PUT /api/documents/{id}` 是**整篇替换**且**没有乐观锁**（只有 300s 同作者合并窗口 + 文档行锁，见 `knowledge-server/src/domain/versioning.rs:27-123`）。凡涉及改已有文档的操作，工具内部**先 GET 再 PUT**，绝不凭模型记忆拼正文。
- **空间不猜**：省略 `spaceId` 时，可见空间唯一才自动选；0 个或多个 → 返回文本让模型回头问用户。绝不默认写第一个空间（共享资源）。
- **写工具不进白名单**：`KNOWLEDGE_READ_RULES`（P1）保持只有四条读规则；本期**不得**新增任何放行规则。写操作必须落到权限弹窗。
- **尺寸三道闸**：单次 `content` ≤ `KB_CONTENT_MAX_BYTES`(256 KiB)；append/update 写回后整篇 ≤ `KB_DOC_MAX_BYTES`(1 MiB)；`ingest_file` 文件 ≤ `KB_INGEST_MAX_BYTES`(32 MiB)。超限返回引导文本。
- **输入计数口径**（对 P1 约束的明确解释）：工具的 zod 入参对象按**一个领域 DTO** 看待（它是单层 REST 载荷，不是杂物 options 袋），不计入「≤4 输入」红线；红线守的是**不把不相关的输入塞进同一函数**——本计划的每个 operation 只干一件事，协作者只有 `client`。若评审认为该口径过宽，请在实现前提出，不要在实现后补。
- **不碰**：`allowedTools` 现有条目、remote/headless 协议、`codegraphTools.test.ts.snap` / `docxTools.test.ts.snap`。

## File Structure

| 文件 | 职责 |
|---|---|
| `agent-sidecar/src/extensions/knowledge/space.ts`（新建） | 目标空间决策（纯函数，零依赖） |
| `agent-sidecar/src/extensions/knowledge/space.test.ts`（新建） | 决策四条分支 |
| `agent-sidecar/src/extensions/knowledge/operations.ts`（新建） | 写目标解析 + 四个多步写操作（返回给模型看的文本） |
| `agent-sidecar/src/extensions/knowledge/operations.test.ts`（新建） | 用假 client 覆盖每个操作的成功/失败/超限分支 |
| `agent-sidecar/src/extensions/knowledge/format.ts`（改） | 加写侧格式化器与三个尺寸常量 |
| `agent-sidecar/src/extensions/knowledge/format.test.ts`（改） | 补写侧用例 |
| `agent-sidecar/src/extensions/knowledgeTools.ts`（改） | 加 4 个写工具 + `kbWrite` 壳；`buildKnowledgeTools` 变 8 个 |
| `agent-sidecar/src/extensions/knowledgeTools.test.ts`（改） | 工具清单变 8 个 + 写工具请求断言 |
| `agent-sidecar/src/extensions/knowledgeMcp.ts`（改） | instructions 补写规则 |
| `agent-sidecar/src/extensions/__snapshots__/knowledgeMcp.test.ts.snap`（改） | instructions 变更导致快照更新（**预期变更**） |

---

### Task 1: 空间决策（纯函数）

**Files:**
- Create: `agent-sidecar/src/extensions/knowledge/space.ts`
- Test: `agent-sidecar/src/extensions/knowledge/space.test.ts`

**Interfaces:**
- Produces（给 Task 2/5）：`decideSpace(requested, spaces): SpaceDecision`、类型 `SpaceDecision = {kind:"ok";id} | {kind:"ask";text}`、类型 `KbSpaceBrief = {id: string; name: string}`。

- [ ] **Step 1: 写失败测试**

新建 `agent-sidecar/src/extensions/knowledge/space.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { decideSpace } from "./space.js";

const spaces = [
  { id: "s1", name: "工程" },
  { id: "s2", name: "产品" },
];

describe("decideSpace", () => {
  it("显式传了 spaceId → 直接用（不校验存在性，服务端会 403/404）", () => {
    expect(decideSpace("s9", spaces)).toEqual({ kind: "ok", id: "s9" });
  });

  it("省略 + 恰好一个可见空间 → 用它", () => {
    expect(decideSpace(undefined, [spaces[0]!])).toEqual({ kind: "ok", id: "s1" });
  });

  it("省略 + 零个可见空间 → 让模型去查成员资格（不是「随便挑一个」）", () => {
    const d = decideSpace(undefined, []);
    expect(d.kind).toBe("ask");
    expect(d.kind === "ask" && d.text).toContain("no knowledge base spaces");
  });

  it("省略 + 多个可见空间 → 列出候选并让模型问用户，绝不自动挑", () => {
    const d = decideSpace(undefined, spaces);
    expect(d.kind).toBe("ask");
    const text = d.kind === "ask" ? d.text : "";
    expect(text).toContain("工程");
    expect(text).toContain("s1");
    expect(text).toContain("产品");
    expect(text).toContain("Ask the user");
  });

  it("空串 spaceId 视同省略（模型可能传 \"\"）", () => {
    expect(decideSpace("", spaces).kind).toBe("ask");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledge/space.test.ts`
Expected: FAIL —— `Failed to resolve import "./space.js"`。

- [ ] **Step 3: 实现**

新建 `agent-sidecar/src/extensions/knowledge/space.ts`：

```ts
// 写目标空间决策（纯函数，零依赖、零 IO）。
//
// 为什么单独一个文件：知识库是共享资源，写错空间别人能看到。这条判定是唯一的
// 「敢不敢替用户拿主意」的地方，必须能被单测钉死（设计 spec §4.2）。

export interface KbSpaceBrief {
  id: string;
  name: string;
}

export type SpaceDecision = { kind: "ok"; id: string } | { kind: "ask"; text: string };

/**
 * 目标空间解析：
 * - 显式传入（非空串）→ 直接用（存在性与权限交给服务端判 403/404）。
 * - 省略 → 可见空间**唯一**才自动选；0 个 / 多个都返回让模型问用户的文本。
 */
export function decideSpace(requested: string | undefined, spaces: KbSpaceBrief[]): SpaceDecision {
  if (requested) return { kind: "ok", id: requested };

  const [only] = spaces;
  if (spaces.length === 1 && only) return { kind: "ok", id: only.id };

  if (spaces.length === 0) {
    return {
      kind: "ask",
      text:
        "No spaceId was given, and the signed-in user can see no knowledge base spaces. " +
        "Ask the user to check their space membership in the 知识库 panel.",
    };
  }

  const list = spaces.map((s) => `- ${s.name} — id ${s.id}`).join("\n");
  return {
    kind: "ask",
    text:
      `No spaceId was given, and ${spaces.length} spaces are visible:\n${list}\n` +
      "Ask the user which space to write to, then call this tool again with that spaceId.",
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledge/space.test.ts`
Expected: PASS，5 passed。

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/extensions/knowledge/space.ts agent-sidecar/src/extensions/knowledge/space.test.ts
git commit -m "feat(knowledge): 写目标空间决策（不猜，多空间回问用户）"
```

---

### Task 2: 写侧文案与尺寸常量

**Files:**
- Modify: `agent-sidecar/src/extensions/knowledge/format.ts`（在文件末尾追加）
- Modify: `agent-sidecar/src/extensions/knowledge/format.test.ts`（追加用例）

**Interfaces:**
- Consumes：`KbSaveResult` / `KbIngestResult`（P1 的 `client.ts`）。
- Produces（给 Task 3/4）：`KB_CONTENT_MAX_BYTES`、`KB_DOC_MAX_BYTES`、`KB_INGEST_MAX_BYTES`、`formatTooLarge(what, maxBytes)`、`formatSavedDocument(res, verb)`、`formatIngestResult(res)`。

- [ ] **Step 1: 写失败测试**

在 `agent-sidecar/src/extensions/knowledge/format.test.ts` 末尾追加：

```ts
describe("写侧文案与尺寸常量", () => {
  it("尺寸常量就是设计定的三个数（不是拍脑袋的近似值）", () => {
    expect(KB_CONTENT_MAX_BYTES).toBe(256 * 1024);
    expect(KB_DOC_MAX_BYTES).toBe(1024 * 1024);
    expect(KB_INGEST_MAX_BYTES).toBe(32 * 1024 * 1024);
  });

  it("formatTooLarge 说清超了什么、上限多少、下一步怎么办", () => {
    const text = formatTooLarge("content", KB_CONTENT_MAX_BYTES);
    expect(text).toContain("content");
    expect(text).toContain("256 KiB");
    expect(text).toContain("Split");
  });

  it("formatTooLarge 在 MiB 档不显示成 1024 KiB", () => {
    expect(formatTooLarge("the file", KB_INGEST_MAX_BYTES)).toContain("32 MiB");
    expect(formatTooLarge("the file", KB_INGEST_MAX_BYTES)).not.toContain("KiB");
  });

  it("formatSavedDocument 带动词、documentId 与版本号；合并窗口单独提示", () => {
    const text = formatSavedDocument({ documentId: "d1", revisionId: "r1", versionNo: 4, merged: false }, "Created");
    expect(text).toContain("Created");
    expect(text).toContain("d1");
    expect(text).toContain("4");
    expect(text).not.toContain("merge window");
    expect(formatSavedDocument({ documentId: "d1", revisionId: "r1", versionNo: 2, merged: true }, "Updated"))
      .toContain("merge window");
  });

  it("formatIngestResult 带标题/documentId/parser；有 warnings 时如实列出", () => {
    const base = formatIngestResult({ documentId: "d1", revisionId: "r1", title: "规范", backend: "docx-to-md" });
    expect(base).toContain("规范");
    expect(base).toContain("d1");
    expect(base).toContain("docx-to-md");
    expect(base).not.toContain("warnings");
    expect(
      formatIngestResult({ documentId: "d1", revisionId: "r1", title: "规范", backend: "docx-lite", warnings: ["结构丢失"] }),
    ).toContain("结构丢失");
  });
});
```

并在该文件顶部的 `from "./format.js"` 导入里补上新名字：`KB_CONTENT_MAX_BYTES, KB_DOC_MAX_BYTES, KB_INGEST_MAX_BYTES, formatIngestResult, formatSavedDocument, formatTooLarge`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledge/format.test.ts`
Expected: FAIL —— `formatTooLarge is not a function`（或导入解析失败）。

- [ ] **Step 3: 实现**

在 `agent-sidecar/src/extensions/knowledge/format.ts` 的 `KB_READ_MAX_CHARS` 之后加常量：

```ts
/** 单次调用传入的 `content` 上限（append 只算新增段落）。 */
export const KB_CONTENT_MAX_BYTES = 256 * 1024;
/** append / update **写回后整篇正文**上限——没有这道闸，append 能绕过单次上限撑爆文档。 */
export const KB_DOC_MAX_BYTES = 1024 * 1024;
/** `ingest_file` 导入文件上限。 */
export const KB_INGEST_MAX_BYTES = 32 * 1024 * 1024;
```

并在文件末尾追加：

```ts
/** 人类可读的字节数（文案用；整数档位，不做小数）。 */
function humanBytes(n: number): string {
  return n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MiB` : `${Math.round(n / 1024)} KiB`;
}

/** 超限一律「拒绝 + 给下一步」，绝不截断后照写（写进共享知识库的内容不能被悄悄剪）。 */
export function formatTooLarge(what: string, maxBytes: number): string {
  return `Refused: ${what} exceeds ${humanBytes(maxBytes)} for one tool call. Split it into smaller pieces instead.`;
}

/** 写成功回执。`verb` 是过去式动词（Created / Updated / Appended to），由调用方给。 */
export function formatSavedDocument(res: KbSaveResult, verb: string): string {
  const merged = res.merged
    ? " (merged into the current revision: same author within the merge window)"
    : "";
  return `${verb} the knowledge base document. documentId ${res.documentId}, version ${res.versionNo}${merged}.`;
}

/** 导入回执。解析器的降级警告如实透出（服务端按端口/适配器范式把丢失信息放这里）。 */
export function formatIngestResult(res: KbIngestResult): string {
  const warnings = res.warnings?.length ? `\n⚠ Parser warnings: ${res.warnings.join("; ")}` : "";
  return `Imported "${res.title}" into the knowledge base. documentId ${res.documentId}, revision ${res.revisionId}, parser ${res.backend}.${warnings}`;
}
```

导入行补上 `KbSaveResult, KbIngestResult`（沿用 P1 已有的 `import type { ... } from "./client.js"` 那一行）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledge/format.test.ts`
Expected: PASS（P1 的 14 条 + 新增 5 条）。

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/extensions/knowledge/format.ts agent-sidecar/src/extensions/knowledge/format.test.ts
git commit -m "feat(knowledge): 写侧文案与三道尺寸闸常量"
```

---

### Task 3: 写操作（新建 / 整篇更新 / 追加）

**Files:**
- Create: `agent-sidecar/src/extensions/knowledge/operations.ts`
- Test: `agent-sidecar/src/extensions/knowledge/operations.test.ts`

**Interfaces:**
- Consumes：`KbClient` / `KbDocument` / `KbSaveResult` / `KbSpace`（P1）、`decideSpace` / `SpaceDecision`（Task 1）、写侧格式化器（Task 2）。
- Produces（给 Task 5）：`resolveWriteTarget(client, requested?)`、`createDocument(client, doc)`、`updateDocument(client, args)`、`appendToDocument(client, args)`、类型 `NewDocument` / `UpdateArgs` / `AppendArgs`。
- Task 4 会在同文件追加 `ingestFile` 与 `IngestArgs`。

- [ ] **Step 1: 写失败测试**

新建 `agent-sidecar/src/extensions/knowledge/operations.test.ts`：

```ts
import { describe, it, expect, vi } from "vitest";
import {
  appendToDocument,
  createDocument,
  resolveWriteTarget,
  updateDocument,
} from "./operations.js";
import { KB_CONTENT_MAX_BYTES, KB_DOC_MAX_BYTES } from "./format.js";
import type { KbClient, KbDocument, KbResult } from "./client.js";

/** 假 client：只实现被测路径用到的方法，返回值由用例给定。 */
function fakeClient(over: Partial<KbClient> = {}): KbClient {
  return {
    getJson: vi.fn(async () => ({ ok: false, failure: { kind: "not_found" } }) as KbResult<never>),
    sendJson: vi.fn(async () => ({ ok: false, failure: { kind: "server", status: 500 } }) as KbResult<never>),
    sendFile: vi.fn(async () => ({ ok: false, failure: { kind: "server", status: 500 } }) as KbResult<never>),
    ...over,
  } as KbClient;
}

const doc: KbDocument = {
  id: "d1", spaceId: "s1", slug: "a", title: "原标题", content: "旧正文", versionNo: 3, status: "published",
};

describe("resolveWriteTarget", () => {
  it("传了 spaceId → 不再拉空间列表（少一次请求）", async () => {
    const c = fakeClient();
    expect(await resolveWriteTarget(c, "s1")).toEqual({ kind: "ok", id: "s1" });
    expect(c.getJson).not.toHaveBeenCalled();
  });

  it("省略 → 拉 /api/spaces 交给决策：唯一空间自动选", async () => {
    const c = fakeClient({ getJson: vi.fn(async () => ({ ok: true, data: [{ id: "s1", name: "工程" }] }) as KbResult<never>) });
    expect(await resolveWriteTarget(c)).toEqual({ kind: "ok", id: "s1" });
  });

  it("省略 + 拉列表失败 → 失败文本（不是异常）", async () => {
    const c = fakeClient({ getJson: vi.fn(async () => ({ ok: false, failure: { kind: "unauthorized" } }) as KbResult<never>) });
    const d = await resolveWriteTarget(c);
    expect(d.kind).toBe("ask");
    expect(d.kind === "ask" && d.text).toContain("sign in again");
  });
});

describe("createDocument", () => {
  it("POST /api/documents，带 spaceId/title/content，成功回执带 documentId", async () => {
    const sendJson = vi.fn(async () => ({
      ok: true, data: { documentId: "d9", revisionId: "r9", versionNo: 1, merged: false },
    }) as KbResult<never>);
    const text = await createDocument(fakeClient({ sendJson }), {
      spaceId: "s1", title: "新文档", content: "正文",
    });
    expect(sendJson).toHaveBeenCalledWith("/api/documents", "POST", { spaceId: "s1", title: "新文档", content: "正文" });
    expect(text).toContain("Created");
    expect(text).toContain("d9");
  });

  it("有 parentId 才带 parentId（不塞 null 字段）", async () => {
    const sendJson = vi.fn(async () => ({ ok: true, data: { documentId: "d", revisionId: "r", versionNo: 1, merged: false } }) as KbResult<never>);
    await createDocument(fakeClient({ sendJson }), { spaceId: "s1", title: "t", content: "c", parentId: "p1" });
    expect(sendJson).toHaveBeenCalledWith("/api/documents", "POST", expect.objectContaining({ parentId: "p1" }));
  });

  it("content 超 256 KiB → 拒绝且不发请求", async () => {
    const sendJson = vi.fn();
    const text = await createDocument(fakeClient({ sendJson }), {
      spaceId: "s1", title: "t", content: "x".repeat(KB_CONTENT_MAX_BYTES + 1),
    });
    expect(text).toContain("Refused");
    expect(sendJson).not.toHaveBeenCalled();
  });

  it("服务端 403 → 权限引导文本", async () => {
    const sendJson = vi.fn(async () => ({ ok: false, failure: { kind: "forbidden" } }) as KbResult<never>);
    expect(await createDocument(fakeClient({ sendJson }), { spaceId: "s1", title: "t", content: "c" }))
      .toContain("permission");
  });
});

describe("updateDocument（整篇替换，先读后写）", () => {
  it("先 GET 再用新正文 PUT，title 沿用当前版本", async () => {
    const getJson = vi.fn(async () => ({ ok: true, data: doc }) as KbResult<never>);
    const sendJson = vi.fn(async () => ({ ok: true, data: { documentId: "d1", revisionId: "r2", versionNo: 4, merged: false } }) as KbResult<never>);
    const text = await updateDocument(fakeClient({ getJson, sendJson }), { documentId: "d1", content: "新正文" });
    expect(getJson).toHaveBeenCalledWith("/api/documents/d1");
    expect(sendJson).toHaveBeenCalledWith("/api/documents/d1", "PUT", { title: "原标题", content: "新正文" });
    expect(text).toContain("Updated");
    expect(text).toContain("4");
  });

  it("显式 title 覆盖当前标题", async () => {
    const getJson = vi.fn(async () => ({ ok: true, data: doc }) as KbResult<never>);
    const sendJson = vi.fn(async () => ({ ok: true, data: { documentId: "d1", revisionId: "r", versionNo: 4, merged: false } }) as KbResult<never>);
    await updateDocument(fakeClient({ getJson, sendJson }), { documentId: "d1", content: "c", title: "新标题" });
    expect(sendJson).toHaveBeenCalledWith("/api/documents/d1", "PUT", expect.objectContaining({ title: "新标题" }));
  });

  it("读失败（404）→ 直接返回失败文本，不尝试写", async () => {
    const sendJson = vi.fn();
    const text = await updateDocument(fakeClient({ sendJson }), { documentId: "gone", content: "c" });
    expect(text).toContain("404");
    expect(sendJson).not.toHaveBeenCalled();
  });

  it("409（他人持锁）→ 带服务端 message 的重试引导", async () => {
    const getJson = vi.fn(async () => ({ ok: true, data: doc }) as KbResult<never>);
    const sendJson = vi.fn(async () => ({ ok: false, failure: { kind: "locked", message: "正被张三编辑" } }) as KbResult<never>);
    expect(await updateDocument(fakeClient({ getJson, sendJson }), { documentId: "d1", content: "c" }))
      .toContain("正被张三编辑");
  });
});

describe("appendToDocument（读旧正文 → 拼接 → 整篇写回）", () => {
  it("PUT body 必须含旧正文（这就是「先读后写」的全部意义）", async () => {
    const getJson = vi.fn(async () => ({ ok: true, data: doc }) as KbResult<never>);
    const sendJson = vi.fn(async () => ({ ok: true, data: { documentId: "d1", revisionId: "r", versionNo: 5, merged: false } }) as KbResult<never>);
    const text = await appendToDocument(fakeClient({ getJson, sendJson }), { documentId: "d1", content: "新增段落" });
    expect(sendJson).toHaveBeenCalledWith(
      "/api/documents/d1",
      "PUT",
      expect.objectContaining({ title: "原标题", content: "旧正文\n\n新增段落" }),
    );
    expect(text).toContain("Appended");
  });

  it("追加后整篇超 1 MiB → 拒绝且不发 PUT（单次上限挡不住累积）", async () => {
    const big = { ...doc, content: "x".repeat(KB_DOC_MAX_BYTES - 10) };
    const getJson = vi.fn(async () => ({ ok: true, data: big }) as KbResult<never>);
    const sendJson = vi.fn();
    const text = await appendToDocument(fakeClient({ getJson, sendJson }), { documentId: "d1", content: "y".repeat(100) });
    expect(text).toContain("Refused");
    expect(sendJson).not.toHaveBeenCalled();
  });

  it("changeNote 有才带（写进版本历史）", async () => {
    const getJson = vi.fn(async () => ({ ok: true, data: doc }) as KbResult<never>);
    const sendJson = vi.fn(async () => ({ ok: true, data: { documentId: "d1", revisionId: "r", versionNo: 5, merged: false } }) as KbResult<never>);
    await appendToDocument(fakeClient({ getJson, sendJson }), { documentId: "d1", content: "x", changeNote: "补一条" });
    expect(sendJson).toHaveBeenCalledWith(
      "/api/documents/d1",
      "PUT",
      expect.objectContaining({ changeNote: "补一条" }),
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledge/operations.test.ts`
Expected: FAIL —— `Failed to resolve import "./operations.js"`。

- [ ] **Step 3: 实现**

新建 `agent-sidecar/src/extensions/knowledge/operations.ts`：

```ts
// 多步写操作：返回**给模型看的文本**（成功与失败都是文本），与 knowledgeTools.ts 的
// kbCall 同属「失败也返回文本」这条红线（codegraphTools.ts:50 先例）。
//
// 为什么这些操作要多一步 GET：知识库的 PUT 是整篇替换且**没有乐观锁**，只有 300s
// 同作者合并窗口与文档行锁兜底。所以凡改已有文档，必须先把当前正文读回来再拼，
// 否则并发下静默覆盖别人的修改（设计 spec §4.2）。
import {
  docPath,
  type KbClient,
  type KbDocument,
  type KbSaveResult,
  type KbSpace,
} from "./client.js";
import { decideSpace, type SpaceDecision } from "./space.js";
import {
  KB_CONTENT_MAX_BYTES,
  KB_DOC_MAX_BYTES,
  formatFailure,
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
  const cur = await client.getJson<KbDocument>(docPath(args.documentId));
  if (!cur.ok) return formatFailure(cur.failure);

  const body = `${cur.data.content ?? ""}\n\n${args.content}`;
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledge/operations.test.ts`
Expected: PASS，12 passed。

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/extensions/knowledge/operations.ts agent-sidecar/src/extensions/knowledge/operations.test.ts
git commit -m "feat(knowledge): 写操作三件（新建/整篇更新/追加，先读后写）"
```

---

### Task 4: 导入本地文件（multipart）

**Files:**
- Modify: `agent-sidecar/src/extensions/knowledge/operations.ts`（追加 `ingestFile`）
- Modify: `agent-sidecar/src/extensions/knowledge/operations.test.ts`（追加用例）

**Interfaces:**
- Consumes：`KbUpload` / `KbIngestResult`（P1）、`formatIngestResult` / `KB_INGEST_MAX_BYTES`（Task 2）、`resolveWriteTarget`（Task 3）。
- Produces（给 Task 5）：`ingestFile(client, cwd, args)`、类型 `IngestArgs`。

- [ ] **Step 1: 写失败测试**

在 `agent-sidecar/src/extensions/knowledge/operations.test.ts` 末尾追加（导入行补 `ingestFile`、`KB_INGEST_MAX_BYTES`，并在 `node:fs`/`node:os`/`node:path` 上补 `mkdtempSync, writeFileSync, rmSync, tmpdir, join`）：

```ts
describe("ingestFile（导入磁盘文件）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kb-ingest-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("相对路径按会话 cwd 解析，multipart 文件名取 basename", async () => {
    writeFileSync(join(dir, "spec.md"), "# 规范\n正文");
    const sendFile = vi.fn(async () => ({
      ok: true, data: { documentId: "d1", revisionId: "r1", title: "规范", backend: "markdown" },
    }) as KbResult<never>);
    const text = await ingestFile(fakeClient({ sendFile }), dir, { filePath: "spec.md", spaceId: "s1" });
    expect(sendFile).toHaveBeenCalledTimes(1);
    // 第三个位置参数就是上传体：只看 filename 与字节数（`as` 是为了给未定型 mock 的
    // calls 元组一个形状——不给的话 `calls[0][2]` 是「空元组没有索引 2」）。
    const upload = (
      sendFile.mock.calls[0] as unknown as [unknown, unknown, { filename: string; data: Uint8Array }]
    )[2];
    expect(sendFile).toHaveBeenCalledWith(
      "/api/ingest",
      { spaceId: "s1", parentId: undefined },
      expect.objectContaining({ filename: "spec.md" }),
    );
    expect(upload.filename).toBe("spec.md");
    expect(upload.data.byteLength).toBeGreaterThan(0);
    expect(text).toContain("Imported");
    expect(text).toContain("markdown");
  });

  it("绝对路径直接用", async () => {
    const abs = join(dir, "abs.txt");
    writeFileSync(abs, "x");
    const sendFile = vi.fn(async () => ({ ok: true, data: { documentId: "d", revisionId: "r", title: "t", backend: "markdown" } }) as KbResult<never>);
    await ingestFile(fakeClient({ sendFile }), "/some/other/cwd", { filePath: abs, spaceId: "s1" });
    const upload = (sendFile.mock.calls[0] as unknown as [unknown, unknown, { filename: string }])[2];
    expect(upload.filename).toBe("abs.txt");
  });

  it("文件不存在 → 说明相对路径规则，不发请求", async () => {
    const sendFile = vi.fn();
    const text = await ingestFile(fakeClient({ sendFile }), dir, { filePath: "nope.md", spaceId: "s1" });
    expect(text).toContain("File not found");
    expect(text).toContain("working directory");
    expect(sendFile).not.toHaveBeenCalled();
  });

  it("路径是目录 → 明确说不是文件，不发请求", async () => {
    const sendFile = vi.fn();
    const text = await ingestFile(fakeClient({ sendFile }), dir, { filePath: ".", spaceId: "s1" });
    expect(text).toContain("Not a file");
    expect(sendFile).not.toHaveBeenCalled();
  });

  it("超过 32 MiB → 拒绝且不读文件、不发请求", async () => {
    const big = join(dir, "big.bin");
    writeFileSync(big, Buffer.alloc(KB_INGEST_MAX_BYTES + 1));
    const sendFile = vi.fn();
    const text = await ingestFile(fakeClient({ sendFile }), dir, { filePath: "big.bin", spaceId: "s1" });
    expect(text).toContain("Refused");
    expect(sendFile).not.toHaveBeenCalled();
  });

  it("服务端解析失败（400）→ 透出服务端 message", async () => {
    writeFileSync(join(dir, "a.xlsx"), "x");
    const sendFile = vi.fn(async () => ({
      ok: false, failure: { kind: "bad_request", message: "不支持的文件类型" },
    }) as KbResult<never>);
    const text = await ingestFile(fakeClient({ sendFile }), dir, { filePath: "a.xlsx", spaceId: "s1" });
    expect(text).toContain("不支持的文件类型");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledge/operations.test.ts`
Expected: FAIL —— `ingestFile is not a function`。

- [ ] **Step 3: 实现**

在 `operations.ts` 顶部补导入：

```ts
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
```
并在 `./client.js` 的导入里加 `type KbIngestResult`、`type KbUpload`；在 `./format.js` 的导入里加 `KB_INGEST_MAX_BYTES`、`formatIngestResult`。

在文件末尾追加：

```ts
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledge/operations.test.ts`
Expected: PASS（12 + 6 条）。

- [ ] **Step 5: 提交**

```bash
git add agent-sidecar/src/extensions/knowledge/operations.ts agent-sidecar/src/extensions/knowledge/operations.test.ts
git commit -m "feat(knowledge): 导入本地文件（stat 先行挡尺寸，扩展名交给服务端判）"
```

---

### Task 5: 4 个写工具接入 + instructions 补写规则

**Files:**
- Modify: `agent-sidecar/src/extensions/knowledgeTools.ts`
- Modify: `agent-sidecar/src/extensions/knowledgeTools.test.ts`
- Modify: `agent-sidecar/src/extensions/knowledgeMcp.ts`（instructions）
- Modify: `agent-sidecar/src/extensions/__snapshots__/knowledgeMcp.test.ts.snap`（快照更新）

**Interfaces:**
- Consumes：`resolveWriteTarget` / 四个 operation（Task 3、4）。
- Produces：`buildKnowledgeTools(env, cwd)` —— **签名变化**（P1 只有 `env`）。返回 8 个工具。

- [ ] **Step 1: 写失败测试**

在 `agent-sidecar/src/extensions/knowledgeTools.test.ts` 里：

1. 把 P1 的清单断言改成 8 个：

```ts
  it("P2 后暴露 4 读 + 4 写，顺序稳定", () => {
    const names = (buildKnowledgeTools(credEnv, "/proj") as unknown as { name: string }[]).map((t) => t.name);
    expect(names).toEqual([
      "search", "read_document", "list_spaces", "list_documents",
      "create_document", "append_document", "update_document", "ingest_file",
    ]);
  });
```
   （`toolByName` 辅助函数同步改成 `buildKnowledgeTools(env, "/proj")`。）

2. 把 P1 那条「未配置凭据 → 不发请求」的用例改成也覆盖写工具：

```ts
  it("未登录时写工具同样只回引导文本，且不发请求", async () => {
    const calls = stubFetch({ status: 200, body: "{}" });
    const r = await toolByName({} as NodeJS.ProcessEnv, "create_document")
      .handler({ title: "t", content: "c" }, undefined);
    expect(r.content[0]!.text).toContain("sign in");
    expect(calls).toEqual([]);
  });
```

3. 追加写工具的行为用例：

```ts
describe("写工具", () => {
  it("create_document：带 spaceId 直接 POST，不再拉空间列表", async () => {
    const urls = stubFetch({ status: 200, body: JSON.stringify({ documentId: "d1", revisionId: "r1", versionNo: 1, merged: false }) });
    const r = await toolByName(credEnv, "create_document")
      .handler({ spaceId: "s1", title: "标题", content: "正文" }, undefined);
    expect(urls).toEqual(["http://kb.test/api/documents"]);
    expect(r.content[0]!.text).toContain("Created");
  });

  it("append_document：先 GET 再 PUT，PUT 正文含旧正文", async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      urls.push(url);
      if (init.method === "PUT") bodies.push(JSON.parse(String(init.body)));
      const body = init.method === "GET"
        ? { id: "d1", spaceId: "s1", slug: "a", title: "T", content: "旧", versionNo: 1, status: "published" }
        : { documentId: "d1", revisionId: "r", versionNo: 2, merged: false };
      return { status: 200, text: async () => JSON.stringify(body) } as Response;
    });
    const r = await toolByName(credEnv, "append_document").handler({ documentId: "d1", content: "新" }, undefined);
    expect(urls).toEqual(["http://kb.test/api/documents/d1", "http://kb.test/api/documents/d1"]);
    expect((bodies[0] as { content: string }).content).toBe("旧\n\n新");
    expect(r.content[0]!.text).toContain("Appended");
  });

  it("写工具省略 spaceId 且多个空间 → 回问用户，不发写请求", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return { status: 200, text: async () => JSON.stringify([{ id: "s1", key: "a", name: "工程", visibility: "internal" }, { id: "s2", key: "b", name: "产品", visibility: "internal" }]) } as Response;
    });
    const r = await toolByName(credEnv, "create_document").handler({ title: "t", content: "c" }, undefined);
    expect(urls).toEqual(["http://kb.test/api/spaces"]);
    expect(r.content[0]!.text).toContain("Ask the user");
  });

  it("ingest_file：相对路径按会话 cwd 解析（cwd 由 buildKnowledgeTools 第二参给）", async () => {
    writeFileSync(join(cwdDir, "note.md"), "# 笔记");
    const urls = stubFetch({ status: 201, body: JSON.stringify({ documentId: "d1", revisionId: "r1", title: "笔记", backend: "markdown" }) });
    const r = await toolByName(credEnv, "ingest_file").handler({ filePath: "note.md", spaceId: "s1" }, undefined);
    expect(urls).toEqual(["http://kb.test/api/ingest?spaceId=s1"]);
    expect(r.content[0]!.text).toContain("Imported");
  });
});
```

   其中 `cwdDir` 在 `beforeEach` 里建：`cwdDir = mkdtempSync(join(tmpdir(), "kb-cwd-"))`，`afterEach` 清理。注意 `toolByName` 用的 cwd 参数就是它，所以把辅助函数的第二参改成变量 `cwdDefault`（默认 `/proj`，ingest 用例里临时用 `cwdDir`）。**实现方式**：把 `toolByName(env, name, cwd = "/proj")` 做成三参辅助函数。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledgeTools.test.ts`
Expected: FAIL —— 工具清单只有 4 个 / `buildKnowledgeTools` 参数不匹配。

- [ ] **Step 3: 实现——加壳与四个写工具**

在 `knowledgeTools.ts` 的导入区加：

```ts
import {
  appendToDocument,
  createDocument,
  ingestFile,
  resolveWriteTarget,
  updateDocument,
} from "./knowledge/operations.js";
```

在 `kbCall` 之后加写工具壳：

```ts
/**
 * 写工具壳：现读凭据 → 建客户端 → 跑一个多步操作（自己返回给模型看的文本）。
 * 与 kbCall 的分工：kbCall 服务「一次请求」的工具，这里服务「先读后写」的工具。
 * 永不抛（工具线红线）。
 */
async function kbWrite(env: NodeJS.ProcessEnv, op: (client: KbClient) => Promise<string>): Promise<ToolResult> {
  const cfg = readKbConfig(env);
  if (!cfg) return textResult(KB_NOT_CONNECTED_TEXT);
  return textResult(await op(createKbClient(cfg)));
}
```

在 `buildListDocumentsTool` 之后加四个写工具 builder：

```ts
function buildCreateDocumentTool(env: NodeJS.ProcessEnv) {
  return tool(
    "create_document",
    "Create a NEW knowledge base document (title + markdown content). Use it when the user asks to save something that does not exist yet — use append_document to add to an existing document instead of creating a duplicate.",
    {
      title: z.string().describe("Document title (also becomes the URL slug)"),
      content: z.string().describe("Document body in markdown"),
      spaceId: z.string().optional().describe("Target space id from list_spaces. Omit only when the user's target is unambiguous."),
      parentId: z.string().optional().describe("Parent document id to nest under. Omit for a top-level document."),
    },
    (args) =>
      kbWrite(env, async (client) => {
        const target = await resolveWriteTarget(client, args.spaceId);
        if (target.kind === "ask") return target.text;
        return createDocument(client, {
          spaceId: target.id,
          title: args.title,
          content: args.content,
          ...(args.parentId ? { parentId: args.parentId } : {}),
        });
      }),
  );
}

function buildAppendDocumentTool(env: NodeJS.ProcessEnv) {
  return tool(
    "append_document",
    "Append markdown to the END of an existing knowledge base document, keeping everything already there. This is the safe default for accumulating findings — prefer it over update_document. Call read_document first if you need to see what is already in the document.",
    {
      documentId: z.string().describe("Document id (uuid) from search or list_documents"),
      content: z.string().describe("Markdown to append at the end of the document"),
      changeNote: z.string().optional().describe("Short note recorded in the revision history"),
    },
    (args) =>
      kbWrite(env, (client) =>
        appendToDocument(client, {
          documentId: args.documentId,
          content: args.content,
          ...(args.changeNote ? { changeNote: args.changeNote } : {}),
        }),
      ),
  );
}

function buildUpdateDocumentTool(env: NodeJS.ProcessEnv) {
  return tool(
    "update_document",
    "Replace the WHOLE body of an existing knowledge base document. Read it with read_document first and carry over the parts you are not changing — this overwrites everything. Prefer append_document when you are only adding something.",
    {
      documentId: z.string().describe("Document id (uuid) from search or list_documents"),
      content: z.string().describe("The complete new document body in markdown"),
      title: z.string().optional().describe("New title. Omit to keep the current title."),
      changeNote: z.string().optional().describe("Short note recorded in the revision history"),
    },
    (args) =>
      kbWrite(env, (client) =>
        updateDocument(client, {
          documentId: args.documentId,
          content: args.content,
          ...(args.title ? { title: args.title } : {}),
          ...(args.changeNote ? { changeNote: args.changeNote } : {}),
        }),
      ),
  );
}

function buildIngestFileTool(env: NodeJS.ProcessEnv, cwd: string) {
  return tool(
    "ingest_file",
    "Import a local file from disk into the knowledge base (md, markdown, txt, docx, pdf — the server parses it into markdown). Use this instead of pasting a large file's content into create_document. Relative paths resolve against the session working directory.",
    {
      filePath: z.string().describe("Path to the file on disk (absolute, or relative to the session working directory)"),
      spaceId: z.string().optional().describe("Target space id from list_spaces. Omit only when the user's target is unambiguous."),
      parentId: z.string().optional().describe("Parent document id to nest under. Omit for a top-level document."),
    },
    (args) =>
      kbWrite(env, async (client) => {
        const target = await resolveWriteTarget(client, args.spaceId);
        if (target.kind === "ask") return target.text;
        return ingestFile(client, cwd, {
          filePath: args.filePath,
          spaceId: target.id,
          ...(args.parentId ? { parentId: args.parentId } : {}),
        });
      }),
  );
}
```

把编排主函数改成（**签名变化**：加 cwd，给 ingest 用）：

```ts
/** 工具总装：本文件唯一的编排点（一张表，不加逻辑）。cwd 只服务 ingest_file 的相对路径。 */
export function buildKnowledgeTools(env: NodeJS.ProcessEnv, cwd: string) {
  return [
    buildSearchTool(env),
    buildReadDocumentTool(env),
    buildListSpacesTool(env),
    buildListDocumentsTool(env),
    buildCreateDocumentTool(env),
    buildAppendDocumentTool(env),
    buildUpdateDocumentTool(env),
    buildIngestFileTool(env, cwd),
  ];
}
```

在 `knowledgeMcp.ts` 里把 `tools: buildKnowledgeTools(env)` 改成 `tools: buildKnowledgeTools(env, cwd)`，并给 `knowledgeMcpRegistration` 加第三参之后的第四参：

```ts
export function knowledgeMcpRegistration(
  env: NodeJS.ProcessEnv = process.env,
  trusted = true,
  taskTools?: string[],
  cwd = "",
): Record<string, unknown> | null {
```
在 `queryContext.ts` 的调用点补上 `deps.cwd`：

```ts
  const knowledgeMcp = knowledgeMcpRegistration(deps.processEnv, deps.trusted, deps.taskTools, deps.cwd);
```

- [ ] **Step 4: instructions 补写规则**

`knowledgeMcp.ts` 的 `KNOWLEDGE_INSTRUCTIONS` 在第 5 条之后追加（**不动前 5 条**，那是 P1 冒烟验过的）：

```
6. WRITING: append_document adds to the end and keeps what is there (the safe default for accumulating findings); update_document REPLACES the whole body, so read_document first and carry over the rest; create_document makes a new document; ingest_file imports a local file from disk (md/txt/docx/pdf) — pass a path instead of pasting a large file's content.
7. NEVER GUESS A SPACE when writing. Call mcp__aide-knowledge__list_spaces first; if more than one space is visible and the user did not say which, ask the user — knowledge base writes land somewhere other people can see.
8. Every write is confirmed by the user through a permission prompt. Say which space and document you are about to write to in the same message, so the prompt is easy to judge.
9. If a write fails, report the failure text to the user instead of retrying blindly. Never save the content to a local file as a fallback unless the user asks.
```

- [ ] **Step 5: 跑测试 + 更新快照**

Run: `cd agent-sidecar && npx vitest run src/extensions/knowledgeTools.test.ts src/extensions/knowledgeMcp.test.ts`
Expected: PASS。`knowledgeMcp.test.ts` 的 instructions 快照会失败 —— 这是**预期变更**，用 `npx vitest run src/extensions/knowledgeMcp.test.ts -u` 更新，然后 `git diff` 确认快照 diff **只含 instructions 的第 6-9 条**与新增的四个工具描述。

Run: `cd agent-sidecar && npx vitest run`
Expected: 全绿。

Run: `npx vitest run`（仓库根）
Expected: 全绿——`session-worker.test.ts` 里 P1 加的「写工具不在 allowedTools」用例必须仍然通过（**本期不加任何放行规则**）。

- [ ] **Step 6: 权限弹窗手工验收（本计划的核心验收）**

`pnpm build:sidecar` 后 `pnpm tauri dev`（⚠️ 不是 `pnpm dev`——那只是 `vite`，起不了 Tauri 壳，也就不会 spawn sidecar），知识库面板登录，新开会话：

1. 发「把这段结论存到知识库：<一段文字>」→ **必须弹出权限确认**，弹窗里有工具名 `create_document` 与标题/正文参数；批准后文档出现在知识库面板的对应空间里。
2. 发「把刚才那条追加到刚才那篇文档末尾」→ 弹窗 → 批准 → 面板里该文档版本号 +1，旧内容仍在。
3. 发「读一下那篇文档，把第二段改写成……」（触发 update_document）→ 弹窗 → 批准 → 全文替换生效。
4. 发「把 `<本地某个 md 文件路径>` 导入知识库」→ 弹窗 → 批准 → 面板出现新文档，标题取自文件首标题。
5. **拒绝一次**（弹窗里点拒绝）→ agent 如实汇报被拒，不重试、不改写本地文件兜底。
6. 未登录状态（面板登出，同一会话）发写指令 → 返回「知识库未连接，请先登录」，**不弹窗**（因为请求根本没发出去）。

- [ ] **Step 7: 分支对账 + 提交**

回填 spec 附录 B 的分支对账表（P2 部分：`decideSpace` 四支、`resolveWriteTarget` 三支、四个 operation 的成功/失败/超限/读取失败、`ingestFile` 的 stat 失败/非文件/超限/读失败/服务端拒绝）。

```bash
git add agent-sidecar/src/extensions/knowledgeTools.ts agent-sidecar/src/extensions/knowledgeTools.test.ts agent-sidecar/src/extensions/knowledgeMcp.ts agent-sidecar/src/extensions/knowledgeMcp.test.ts agent-sidecar/src/extensions/__snapshots__/knowledgeMcp.test.ts.snap agent-sidecar/src/engine/session-worker/queryContext.ts docs/superpowers/specs/2026-09-13-knowledge-mcp-design.md
git commit -m "feat(knowledge): 4 个写工具接入 + instructions 补写规则（写必弹窗）"
```

---

## 完成判据（P2）

- `npx vitest run`（根）与 `cd agent-sidecar && npx vitest run` 全绿。
- `knowledgeMcp.test.ts` 里 `KNOWLEDGE_READ_RULES` 仍是四条读规则，**没有**任何写规则；`session-worker.test.ts` 的「写工具不在 allowedTools」用例通过。
- 手工验收 6 条全过，尤其第 1 条（写必弹窗）与第 5 条（拒绝后不兜底改写本地文件）。
- spec 附录 B 的对账表 P2 部分已回填。
- 设计 spec §9 的「已知代价」是否有更新（本期新增：写工具弹窗会展示 256 KiB 内的完整正文，长正文弹窗较长）——有则回写 spec 并提交。
