import { describe, it, expect } from "vitest";
import {
  createChangeAttribution,
  toRelPath,
  mergeTouches,
  toChangeFiles,
  isSegmentedRound,
  type TouchedFile,
} from "./useChangeAttribution";

const ROOT = "C:/proj";
const SID = "sid-1";
const OTHER_SID = "sid-2";

/** 造一条 tool_use_start 事件（与 chat-event payload 同形）。 */
function toolUse(name: string, input: unknown, sid: string = SID) {
  return { type: "tool_use_start", session_id: sid, name, input };
}

function edit(path: string, oldString = "a", newString = "b", sid: string = SID) {
  return toolUse("Edit", { file_path: path, old_string: oldString, new_string: newString }, sid);
}

function write(path: string, content = "line1\nline2", sid: string = SID) {
  return toolUse("Write", { file_path: path, content }, sid);
}

/** 默认 deps：所有会话都归属 ROOT、都可跟踪。 */
function make(overrides: Partial<Parameters<typeof createChangeAttribution>[0]> = {}) {
  return createChangeAttribution({
    rootOf: () => ROOT,
    isTracked: () => true,
    ...overrides,
  });
}

describe("createChangeAttribution.ingest", () => {
  it("忽略非 tool_use_start 事件", () => {
    const a = make();
    a.ingest({ type: "text_delta", session_id: SID, name: "Edit", input: {} });
    expect(a.drain(SID)).toBeNull();
  });

  it("忽略非变更类工具（Read/Bash 改文件不归集——已知覆盖度代价）", () => {
    const a = make();
    a.ingest(toolUse("Read", { file_path: `${ROOT}/a.ts` }));
    a.ingest(toolUse("Bash", { command: `sed -i s/a/b/ ${ROOT}/a.ts` }));
    expect(a.drain(SID)).toBeNull();
  });

  it("Edit → 相对路径 + M 状态 + 行数 + 片段", () => {
    const a = make();
    a.ingest(edit(`${ROOT}/src/a.ts`, "old\nline", "new\nline\nextra"));
    const r = a.drain(SID);
    expect(r).not.toBeNull();
    expect(r!.wsRoot).toBe(ROOT);
    expect(r!.files).toHaveLength(1);
    const f = r!.files[0];
    expect(f.path).toBe("src/a.ts");
    expect(f.status).toBe("M");
    expect(f.additions).toBe(3);
    expect(f.deletions).toBe(2);
    expect(f.segments).toHaveLength(1);
    expect(f.segments[0].oldText).toBe("old\nline");
    expect(f.segments[0].newText).toBe("new\nline\nextra");
  });

  it("Write → 新增态 A", () => {
    const a = make();
    a.ingest(write(`${ROOT}/src/new.ts`));
    const f = a.drain(SID)!.files[0];
    expect(f.status).toBe("A");
    expect(f.deletions).toBe(0);
  });

  it("同一轮内同一文件多次 Edit：行数累加、片段按序保留多个", () => {
    const a = make();
    a.ingest(edit(`${ROOT}/a.ts`, "x", "y"));
    a.ingest(edit(`${ROOT}/a.ts`, "z", "w\nw2"));
    const f = a.drain(SID)!.files[0];
    expect(f.additions).toBe(3);
    expect(f.deletions).toBe(2);
    expect(f.segments).toHaveLength(2);
  });

  it("先 Edit 后 Write：整条记为新增（Write 覆盖全文件）", () => {
    const a = make();
    a.ingest(edit(`${ROOT}/a.ts`));
    a.ingest(write(`${ROOT}/a.ts`));
    expect(a.drain(SID)!.files[0].status).toBe("A");
  });

  it("多个文件按路径分别成条", () => {
    const a = make();
    a.ingest(edit(`${ROOT}/a.ts`));
    a.ingest(edit(`${ROOT}/sub/b.rs`));
    const files = a.drain(SID)!.files;
    expect(files.map((f) => f.path).sort()).toEqual(["a.ts", "sub/b.rs"]);
  });
});

describe("归属与边界", () => {
  it("工作区外文件不归集（漏是安全失败，撤回对它本就无意义）", () => {
    const a = make();
    a.ingest(edit("D:/elsewhere/a.ts"));
    expect(a.drain(SID)).toBeNull();
  });

  it("会话未绑定工作区（rootOf 为 null）→ 不归集", () => {
    const a = make({ rootOf: () => null });
    a.ingest(edit(`${ROOT}/a.ts`));
    expect(a.drain(SID)).toBeNull();
  });

  it("未跟踪会话（自动化运行）→ 不归集", () => {
    const a = make({ isTracked: (sid) => sid !== "run-1" });
    a.ingest(edit(`${ROOT}/a.ts`, "x", "y", "run-1"));
    expect(a.drain("run-1")).toBeNull();
  });

  it("按 sid 分桶：A 会话的改动不会出现在 B 会话的 drain 里", () => {
    const a = make();
    a.ingest(edit(`${ROOT}/a.ts`, "x", "y", SID));
    a.ingest(edit(`${ROOT}/b.ts`, "x", "y", OTHER_SID));
    expect(a.drain(SID)!.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(a.drain(OTHER_SID)!.files.map((f) => f.path)).toEqual(["b.ts"]);
  });

  it("Windows 分隔符混用：绝对路径用反斜杠也能归一", () => {
    const a = make();
    a.ingest(edit("C:\\proj\\src\\a.ts"));
    expect(a.drain(SID)!.files[0].path).toBe("src/a.ts");
  });

  it("工作区根带尾部分隔符也能正确切分", () => {
    const a = make({ rootOf: () => "C:/proj/" });
    a.ingest(edit(`${ROOT}/src/a.ts`));
    expect(a.drain(SID)!.files[0].path).toBe("src/a.ts");
  });
});

describe("游标语义", () => {
  it("drain 取走即清空：无新增量时返回 null", () => {
    const a = make();
    a.ingest(edit(`${ROOT}/a.ts`));
    expect(a.drain(SID)).not.toBeNull();
    expect(a.drain(SID)).toBeNull();
  });

  it("drain 后再有新改动 → 只返回增量", () => {
    const a = make();
    a.ingest(edit(`${ROOT}/a.ts`));
    a.drain(SID);
    a.ingest(edit(`${ROOT}/b.ts`));
    const r = a.drain(SID)!;
    expect(r.files.map((f) => f.path)).toEqual(["b.ts"]);
  });

  it("forget 丢弃未取走的桶", () => {
    const a = make();
    a.ingest(edit(`${ROOT}/a.ts`));
    a.forget(SID);
    expect(a.drain(SID)).toBeNull();
  });

  it("无 session_id 的事件不建桶", () => {
    const a = make();
    a.ingest({ type: "tool_use_start", name: "Edit", input: {} });
    expect(a.drain(SID)).toBeNull();
  });
});

describe("片段预算", () => {
  it("超长片段不收集（Write 全文常见几十 KB → 退化为累计视图）", () => {
    const a = make();
    const big = "x".repeat(20_001);
    a.ingest(write(`${ROOT}/big.ts`, big));
    const f = a.drain(SID)!.files[0];
    expect(f.segments).toHaveLength(0);
    // 行数统计仍然保留：核心需求不受片段预算影响
    expect(f.additions).toBe(1);
  });

  it("同一文件片段数封顶 12，超出不再追加（行数照常累加）", () => {
    const a = make();
    for (let i = 0; i < 20; i++) a.ingest(edit(`${ROOT}/a.ts`, "x", "y"));
    const f = a.drain(SID)!.files[0];
    expect(f.segments).toHaveLength(12);
    expect(f.additions).toBe(20);
  });
});

describe("toRelPath", () => {
  it("绝对路径在工作区内 → 相对路径", () => {
    expect(toRelPath("C:/proj", "C:/proj/src/a.ts")).toBe("src/a.ts");
  });

  it("大小写不同（Windows 语义）仍视为同前缀", () => {
    expect(toRelPath("C:/Proj", "c:/proj/src/a.ts")).toBe("src/a.ts");
  });

  it("工作区外 / 同前缀但不是目录边界 → null", () => {
    expect(toRelPath("C:/proj", "D:/proj/a.ts")).toBeNull();
    expect(toRelPath("C:/proj", "C:/project/a.ts")).toBeNull();
  });

  it("空根 → null（未绑定工作区不应产生条目）", () => {
    expect(toRelPath("", "C:/proj/a.ts")).toBeNull();
  });
});

describe("mergeTouches", () => {
  const base: TouchedFile[] = [
    { path: "a.ts", status: "M", additions: 1, deletions: 1, segments: [{ oldText: "x", newText: "y", addCount: 1, delCount: 1 }] },
  ];

  it("同路径合并：行数累加、片段拼接", () => {
    const out = mergeTouches(base, [
      { path: "a.ts", status: "M", additions: 2, deletions: 0, segments: [{ oldText: "p", newText: "q", addCount: 2, delCount: 0 }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].additions).toBe(3);
    expect(out[0].segments).toHaveLength(2);
  });

  it("新增态优先：任一段是 Write 即视为新建", () => {
    const out = mergeTouches(base, [
      { path: "a.ts", status: "A", additions: 0, deletions: 0, segments: [] },
    ]);
    expect(out[0].status).toBe("A");
  });

  it("新路径直接入列，不改动原数组", () => {
    const out = mergeTouches(base, [
      { path: "b.ts", status: "M", additions: 1, deletions: 0, segments: [] },
    ]);
    expect(out.map((f) => f.path).sort()).toEqual(["a.ts", "b.ts"]);
    expect(base).toHaveLength(1);
  });

  it("片段数上限在合并时同样生效", () => {
    const many = Array.from({ length: 20 }, () => ({ oldText: "x", newText: "y", addCount: 1, delCount: 1 }));
    const out = mergeTouches([], [
      { path: "a.ts", status: "M", additions: 20, deletions: 20, segments: many },
    ]);
    expect(out[0].segments).toHaveLength(12);
  });
});

describe("toChangeFiles / isSegmentedRound", () => {
  it("toChangeFiles 剥掉片段，输出落盘形状", () => {
    const files: TouchedFile[] = [
      { path: "a.ts", status: "M", additions: 2, deletions: 1, segments: [{ oldText: "x", newText: "y", addCount: 2, delCount: 1 }] },
    ];
    expect(toChangeFiles(files)).toEqual([
      { path: "a.ts", status: "M", additions: 2, deletions: 1 },
    ]);
  });

  it("isSegmentedRound：所有文件都有片段才算整轮片段视图", () => {
    const withSeg: TouchedFile[] = [
      { path: "a.ts", status: "M", additions: 1, deletions: 0, segments: [{ oldText: "x", newText: "y", addCount: 1, delCount: 0 }] },
      { path: "b.ts", status: "M", additions: 1, deletions: 0, segments: [{ oldText: "x", newText: "y", addCount: 1, delCount: 0 }] },
    ];
    expect(isSegmentedRound(withSeg)).toBe(true);

    // 一个文件没片段 → 整轮降级为累计视图：同一轮里不许出现两种语义
    const partial = [withSeg[0], { ...withSeg[1], segments: [] }];
    expect(isSegmentedRound(partial)).toBe(false);
  });

  it("isSegmentedRound：空集合不是片段轮（无文件 = 无变更）", () => {
    expect(isSegmentedRound([])).toBe(false);
  });
});
