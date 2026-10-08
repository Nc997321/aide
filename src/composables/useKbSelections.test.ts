import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitKbSelectionEvent } from "@aide/sdk/composables/useKbSelectionEvents";
import { __resetKbSelectionsForTest, newRangeAfterEdit, useKbSelections } from "./useKbSelections";

const scope = { start: 6, end: 13, text: "切流量到旧版本", lineStart: 3, lineEnd: 3, precise: true };
const input = { documentId: "doc-1", title: "发布流程", baseVersion: 3, baseContent: "出现故障时先切流量到旧版本再排查。", scope };

beforeEach(() => {
  vi.useFakeTimers();
  __resetKbSelectionsForTest();
});
afterEach(() => vi.useRealTimers());

describe("生命周期", () => {
  it("draft → pending → sent → working → done，状态只由用户操作与聊天事件推进", () => {
    const k = useKbSelections();
    const rec = k.begin(input);
    const id = rec.ref.selectionId;
    expect(rec.status).toBe("draft");
    k.confirm(id, "写具体些");
    expect(k.records[id]!.status).toBe("pending");
    expect(k.pendingRefs.value.map((r) => r.comment)).toEqual(["写具体些"]);
    k.markSent([id], "uuid-a");
    expect(k.records[id]!.status).toBe("sent");
    expect(k.pendingRefs.value).toEqual([]);
    emitKbSelectionEvent({ kind: "working", sid: "uuid-a", selectionId: id });
    expect(k.records[id]!.status).toBe("working");
    emitKbSelectionEvent({ kind: "result", sid: "uuid-a", selectionId: id, ok: true, versionNo: 4 });
    expect(k.records[id]).toMatchObject({ status: "done", versionNo: 4 });
  });

  it("同一时刻只留一个草稿：新圈选作废旧草稿，但不动已确认的", () => {
    const k = useKbSelections();
    const a = k.begin(input).ref.selectionId;
    k.confirm(a, "");
    const b = k.begin(input).ref.selectionId;
    const c = k.begin(input).ref.selectionId;
    expect(k.records[a]!.status).toBe("pending");
    expect(k.records[b]).toBeUndefined();
    expect(k.records[c]!.status).toBe("draft");
  });

  it("在途（sent / working）的不许丢弃；草稿与待发送可以", () => {
    const k = useKbSelections();
    const a = k.begin(input).ref.selectionId;
    k.discard(a);
    expect(k.records[a]).toBeUndefined();
    const b = k.begin(input).ref.selectionId;
    k.confirm(b, "");
    k.markSent([b]);
    k.discard(b);
    expect(k.records[b]!.status).toBe("sent");
  });

  it("拒绝回执 → refused，原因翻成人话", () => {
    const k = useKbSelections();
    const id = k.begin(input).ref.selectionId;
    k.confirm(id, "");
    k.markSent([id]);
    emitKbSelectionEvent({ kind: "working", sid: "s", selectionId: id });
    emitKbSelectionEvent({ kind: "result", sid: "s", selectionId: id, ok: false, message: "Refused: the selected text is no longer where the user selected it in 《x》" });
    expect(k.records[id]!.status).toBe("refused");
    expect(k.records[id]!.message).toContain("请重新圈选");
  });

  it("这一轮结束而 agent 没动这一段 → noop；已经 done 的不受影响", () => {
    const k = useKbSelections();
    const a = k.begin(input).ref.selectionId;
    k.confirm(a, "");
    k.markSent([a], "uuid-a");
    const b = k.begin(input).ref.selectionId;
    k.confirm(b, "");
    k.markSent([b], "uuid-a");
    emitKbSelectionEvent({ kind: "working", sid: "uuid-a", selectionId: b });
    emitKbSelectionEvent({ kind: "result", sid: "uuid-a", selectionId: b, ok: true, versionNo: 5 });
    emitKbSelectionEvent({ kind: "turn_end", sid: "uuid-a" });
    expect(k.records[a]!.status).toBe("noop");
    expect(k.records[b]!.status).toBe("done");
  });

  it("别的会话的轮次结束不会误伤（sid 对不上）", () => {
    const k = useKbSelections();
    const a = k.begin(input).ref.selectionId;
    k.confirm(a, "");
    k.markSent([a], "uuid-a");
    emitKbSelectionEvent({ kind: "working", sid: "uuid-a", selectionId: a });
    emitKbSelectionEvent({ kind: "turn_end", sid: "uuid-OTHER" });
    expect(k.records[a]!.status).toBe("working");
  });

  it("结果态不会自动消失（卡片线程与撤销挂在它上面）；sent 太久没动静按没改处理", () => {
    const k = useKbSelections();
    const a = k.begin(input).ref.selectionId;
    k.confirm(a, "");
    k.markSent([a]);
    vi.advanceTimersByTime(180_001);
    expect(k.records[a]!.status).toBe("noop");
    vi.advanceTimersByTime(24 * 3600_000);
    expect(k.records[a]!.status).toBe("noop");
    k.discard(a); // 用户点 × 才收起
    expect(k.records[a]).toBeUndefined();
  });

  it("没有对应记录的事件被忽略，不抛", () => {
    useKbSelections();
    expect(() => emitKbSelectionEvent({ kind: "result", sid: "s", selectionId: "nope", ok: true })).not.toThrow();
  });
});

describe("newRangeAfterEdit", () => {
  const base = "前缀。切流量到旧版本。后缀。";
  const ref = { start: 3, end: 10 };
  it("只有圈选那段变了 → 新范围恰好覆盖新文本", () => {
    const next = "前缀。" + "把入口流量全部切回上一个稳定版本" + "。后缀。";
    const r = newRangeAfterEdit(base, ref, next)!;
    expect(next.slice(r.start, r.end)).toBe("把入口流量全部切回上一个稳定版本");
  });
  it("前缀或后缀也变了（别人同时改了别处）→ null，不乱画", () => {
    expect(newRangeAfterEdit(base, ref, "别人加的。" + base)).toBeNull();
    expect(newRangeAfterEdit(base, ref, base + "别人加的。")).toBeNull();
  });
  it("新文本为空（删除）→ 空范围而不是 null", () => {
    const r = newRangeAfterEdit(base, ref, "前缀。。后缀。");
    expect(r).toEqual({ start: 3, end: 3 });
  });
  it("正文变得比前后缀之和还短 → null", () => {
    expect(newRangeAfterEdit(base, ref, "短")).toBeNull();
  });
});
