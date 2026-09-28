# 回合变更结算卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在对话流尾部挂一张跟随当前轮的「本轮变更」结算卡——不打开任何侧栏就能说出这轮改了几个文件、多少行，并从卡上直达变更面板与单文件 diff。

**Architecture:** 纯前端接线，零新数据通道。卡片是 `App.vue` 里**唯一一份** `useConversationChanges` 实例投影的**第二个消费者**（第一个是右栏 `ChangeLogPanel`）：App 用 `provide(TURN_CHANGES_KEY)` 下发 `{ sid, rounds, revertSingleFile }`，`ChatPanel` 注入后在 `.chat-messages-body` 尾部渲染 `TurnChangeCard`。卡片自己判断"这份数据是不是我这个会话的""这一轮该不该有卡"（0 文件整卡不渲染）、进行中/已结算两态、展开清单复用既有 `ChangeFileList`。

**Tech Stack:** Vue 3.5（SFC + Composition API）+ TypeScript；vitest 4 + @vue/test-utils 2（jsdom）；样式全部走 `--aide-*` 语义 token。

**Spec:** `docs/superpowers/specs/2026-09-24-turn-change-card-design.md`（语义权威）
**原型:** `docs/prototypes/2026-09-24-turn-change-footer.html`（形态与生命周期唯一依据）

---

## 实施前拍板的四个空档（spec 留了选择，这里定一个；评审可推翻）

1. **`变更面板 ↗` 走 `ensureTabShown`**（spec §2.3.1 的"推荐"），而不是 §6.2"建议"的卡片内手写三行。理由：`useRightPanel.select()` 是 toggle，`ensureBrowserShown()` 就是为同一个坑存在的；卡片再手写一遍 `tab = "changes"; collapsed = false` 等于把这处特例复制第二份。泛化的回归面 = `ensureBrowserShown` 改写成它的薄封装（行为逐字不变，既有 2 个用例覆盖）。
2. **「首次出现变更」淡入不做**（spec §6.3 建议 YAGNI）。代价：本笔新增**状态为零**（只有 `expanded` 这个纯展示 ref）。原型 §03 表里那一行是唯一不落地的形态项；要补回来是卡内加一个 ref + 一个 class，不影响其余结构。
3. **分屏口径（spec 未写，但不写会串会话）**：`feed.sid !== props.sessionId` 时整卡不渲染。App 的那份 `rounds` 绑的是**聚焦组**的会话（`activeSessionId`），分屏里另一组显示的是别的会话——不设这道闸，非聚焦组会把聚焦组的数字当自己的显示出来。取舍：非聚焦组看不到卡（与右栏"变更面板只服务活动会话"同一口径）。
4. **两处形态落点原型页没有**（原型是单卡演示页，没有对话列）：卡面 `margin: 4px 12px`（与 `.msg-row` 的 `padding: 4px 12px` 对齐）；hover 泛光**只给已结算态**（进行中的卡没有任何可点处，亮起来是承诺一个不存在的动作；原型 CSS 里 `.tf:hover` 的优先级会覆盖 `.tf--live`，那是没考虑到的组合，不是意图）。

---

## Global Constraints

- **主题 token 是配色的唯一来源**：所有颜色/圆角/字体/缓动走 `var(--aide-*)`，**禁止硬编码 hex**；`color-mix` 只允许作用在 token 上（原型页写法照搬）。
- **本笔不动逻辑**：`packages/aide-sdk`、`agent-sidecar`、`src-tauri`（含协议 / REGISTRY / 落盘格式 `ChangeRoundData`）、`useConversationChanges`、`useChangeAttribution`、`ChangeLogPanel` / `ChangeRoundItem`、`blockSegments.ts` / `ChatMessage.vue` **一律不改**。
- **桌面专属**：不往共享 SDK 的类型里加东西，不在共享代码里 import 桌面组件。
- **行 1 = 身份 + 动作；行 2 = 全部统计量**（已结算态）。进行中态照原型：文件数在行 1 右端（此刻行 1 没有动作可放）。
- 数字规格：行数 `19px / 600 / letter-spacing:-.02em / --aide-font-mono / tabular-nums`；文件数 `13px`（数字 `14px` mono 600）；卡名 `10.5px / 600 / letter-spacing:1.1px / accent`；面板入口 `11px / accent / 无底无边 / hover 下划线`。
- 比例条：`5px` 高 / `gap:1.5px` / `min-width:2px` / 圆角 `99px` / 轨道 `--aide-surface-hover` / `flex: 0 1 230px` 贴右端；**长度恒定**（`flex-grow` 取原始行数）；**右端不挂任何文字**。
- 文案（逐字，含码位）：`正在改`、`本轮变更`、`变更面板 ↗`（U+2197）、`展开`、`收起`、`<n> 个文件`；增删号 `+`（U+002B）与 `−`（**U+2212，不是 ASCII 连字符**）；零值整项不渲染；千分位仅 ≥4 位时出现（`+1,240`）。
- 展开箭头是 **border 三角**（同 `ProcessGroup` 的 `.pg-caret`）旋转 90°，不用 `▾` / emoji。
- 悬停只动 accent 透明度与底色，**不加边框、不改尺寸**。
- 代码规矩：函数 ≤40 行、嵌套 ≤3 层、单函数输入 ≤4；无死代码、无注释掉的逻辑。
- 测试：`npx vitest run <path>`；全量 `pnpm test`；类型 `npx vue-tsc --noEmit`。

## Review Focus

（spec 没写、但输入一到就会咬人的五类；每一条都在 Task 3 的测试里钉住）

1. **分屏的另一组**（`feed.sid` ≠ 本面板 `sessionId`）→ 整卡不渲染。不设闸就会把 A 组的数字显示到 B 组。
2. **撤回掉本轮最后一个文件** → `files` 变空 → 整卡消失（不是留一张"0 个文件"的空壳）。
3. **纯删除轮**（`additions = 0`）→ 不出现 `+0`，比例条不出现空绿段（只剩红段）。
4. **行数 ≥4 位**（`+1,240`）→ 千分位出现，且数字变长不把条推走（条贴右端、数字列等宽）。
5. **下一轮开始 / 换会话** → 展开态复位、卡名回到 `正在改`（上一轮的展开清单不得被下一轮继承）。

另有三条由组件自身用例覆盖、不单列：等权限（`attention`）时**不得**显示成已结算（用 `round.pending` 而非 `sessionState === "running"`）；`+` / `−` 的零值与码位；`变更面板 ↗` 已在该 tab 时**不收起**面板。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/composables/useRightPanel.ts`（改） | 新增 `ensureTabShown(id)`：幂等展开任意 tab；`ensureBrowserShown` 改为它的薄封装 |
| `src/components/ChatPanel/turnChanges.ts`（新） | 卡片的数据契约：`TurnChangesFeed` 接口 + `TURN_CHANGES_KEY`。App 提供、ChatPanel 注入 |
| `src/components/ChatPanel/turnChangeStats.ts`（新） | 纯展示量：`roundStats` / `formatCount` / `barSegments`（无 Vue 依赖，可直接单测） |
| `src/components/ChatPanel/TurnChangeCard.vue`（新） | 卡片本体：三态、文案、比例条、展开清单、两个出口 |
| `src/components/ChatPanel/ChatPanel.vue`（改） | 注入 feed（没有就整块不渲染）+ 在消息流行末渲染卡片（1 行） |
| `src/App.vue`（改） | `provide(TURN_CHANGES_KEY, computed(...))`：把唯一实例的投影下发 |
| `docs/prototypes/_harness/turn-change-card-live.{html,ts}`（新） | 真组件截图夹具：核对形态与原型一致 |
| `docs/turn-change-card-test-checklist.md`（新） | 真机验收清单（零上下文可跑，含回写说明） |

---

### Task 1: `ensureTabShown(id)` —— 幂等展开任意 tab

**Files:**
- Modify: `src/composables/useRightPanel.ts:69-79`（`ensureBrowserShown` 所在段）及 `:122-138`（返回值）
- Test: `src/composables/useRightPanel.test.ts`（追加 describe）

**Interfaces:**
- Consumes: 无（既有模块）
- Produces: `useRightPanel().ensureTabShown(id: RightTabId): void` —— 幂等：`tab = id; collapsed = false`；`browser` 额外置 `browserEverActive`。Task 3 用它做 `变更面板 ↗`。

- [ ] **Step 1: 写失败测试**

追加到 `src/composables/useRightPanel.test.ts`（文件已有 `beforeEach(() => __resetRightPanelForTest())`）：

```ts
describe("ensureTabShown：幂等展开任意 tab（结算卡的「变更面板 ↗」走它）", () => {
  it("已在该 tab 且面板展开时再点 → 不收起（select 是 toggle，不能用）", () => {
    const p = useRightPanel();
    p.select("changes"); // 展开
    expect(p.collapsed.value).toBe(false);

    p.ensureTabShown("changes");
    p.ensureTabShown("changes"); // 幂等：调几次都一样

    expect(p.tab.value).toBe("changes");
    expect(p.collapsed.value).toBe(false);
  });

  it("从别的 tab 切过去，并保证面板是展开的", () => {
    const p = useRightPanel();
    p.select("files");
    p.ensureTabShown("changes");
    expect(p.tab.value).toBe("changes");
    expect(p.collapsed.value).toBe(false);
  });

  it("收起态调它 → 展开（不切走别的 tab 的语义）", () => {
    const p = useRightPanel();
    p.collapse();
    p.ensureTabShown("changes");
    expect(p.collapsed.value).toBe(false);
    expect(p.tab.value).toBe("changes");
  });

  it("browser 走同一条路径：懒挂载标记照旧置位", () => {
    const p = useRightPanel();
    p.ensureTabShown("browser");
    expect(p.browserEverActive.value).toBe(true);
    p.ensureTabShown("browser"); // 幂等
    expect(p.collapsed.value).toBe(false);
  });

  it("非 browser 的 tab 不动 browserEverActive（懒挂载只认浏览器）", () => {
    const p = useRightPanel();
    p.ensureTabShown("changes");
    expect(p.browserEverActive.value).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/useRightPanel.test.ts`
Expected: FAIL —— `p.ensureTabShown is not a function`（其余既有用例仍绿）

- [ ] **Step 3: 实现**

`src/composables/useRightPanel.ts`，把 `ensureBrowserShown` 那段（`:69-79`）替换为：

```ts
/**
 * **幂等**展开到某个 tab（不是 toggle）。
 *
 * 不能用 `select(id)`：那是 toggle，用户已经在该 tab 时会把面板**收起来**——
 * 一个"给我看看"的请求变成"把你的面板关掉"。agent 的 focus 请求（浏览器）与
 * 结算卡的「变更面板 ↗」都踩这个坑，故裁决收在这里一处。
 */
function ensureTabShown(id: RightTabId) {
  if (id === "browser") browserEverActive.value = true; // 懒挂载：浏览器组件首次激活才挂
  tab.value = id;
  collapsed.value = false;
}

/** 展开浏览器面板（agent 的 focus 请求走它）。 */
function ensureBrowserShown() {
  ensureTabShown("browser");
}
```

返回值里在 `ensureBrowserShown,` 下一行加 `ensureTabShown,`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/composables/useRightPanel.test.ts`
Expected: PASS（既有 21 条 + 新增 5 条全绿；`browserActive / maximized` 那条「切回浏览器自动恢复最大化」用例不受影响）

- [ ] **Step 5: 提交**

```bash
git add src/composables/useRightPanel.ts src/composables/useRightPanel.test.ts
git commit -m "feat(right-panel): ensureTabShown 泛化——幂等展开任意 tab，ensureBrowserShown 改为薄封装"
```

---

### Task 2: 结算卡的显示量（纯函数）

**Files:**
- Create: `src/components/ChatPanel/turnChangeStats.ts`
- Test: `src/components/ChatPanel/turnChangeStats.test.ts`

**Interfaces:**
- Consumes: `ChangeFile`（`@/types`：`{ path, status, additions, deletions }`）
- Produces:
  - `interface RoundStats { files: number; additions: number; deletions: number }`
  - `roundStats(files: ChangeFile[]): RoundStats`
  - `formatCount(n: number): string`
  - `type BarSegment = { kind: "add" | "del"; flex: number }`
  - `barSegments(s: RoundStats): BarSegment[]`

- [ ] **Step 1: 写失败测试**

Create `src/components/ChatPanel/turnChangeStats.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { barSegments, formatCount, roundStats } from "./turnChangeStats";
import type { ChangeFile } from "@/types";

const f = (path: string, status: string, additions: number, deletions: number): ChangeFile => ({
  path, status, additions, deletions,
});

describe("roundStats — 一轮的规模", () => {
  it("文件数 + 逐文件累加的行数", () => {
    expect(roundStats([f("a.ts", "M", 200, 1), f("b.ts", "A", 3, 1)])).toEqual({
      files: 2, additions: 203, deletions: 2,
    });
  });

  it("空轮 → 全 0（卡片据此整卡不渲染）", () => {
    expect(roundStats([])).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  it("纯新增轮：deletions 为 0，不做任何补位", () => {
    expect(roundStats([f("a.ts", "A", 64, 0)])).toEqual({ files: 1, additions: 64, deletions: 0 });
  });
});

describe("formatCount — 千分位仅 ≥4 位时出现", () => {
  it("三位数不加分隔", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
  });

  it("四位数起加逗号", () => {
    expect(formatCount(1000)).toBe("1,000");
    expect(formatCount(1240)).toBe("1,240");
  });

  it("大数按三位分段", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
  });
});

describe("barSegments — 长度恒定，只表达增删比例", () => {
  it("两段都非零 → 绿红各一段，flex 取原始行数（不是百分比）", () => {
    expect(barSegments(roundStats([f("a.ts", "M", 203, 2)]))).toEqual([
      { kind: "add", flex: 203 },
      { kind: "del", flex: 2 },
    ]);
  });

  it("纯新增轮 → 只有绿段（不产生空红段）", () => {
    expect(barSegments({ files: 1, additions: 64, deletions: 0 })).toEqual([{ kind: "add", flex: 64 }]);
  });

  it("纯删除轮 → 只有红段", () => {
    expect(barSegments({ files: 1, additions: 0, deletions: 5 })).toEqual([{ kind: "del", flex: 5 }]);
  });

  it("全零（改了文件但 0 行）→ 无分段，只剩轨道", () => {
    expect(barSegments({ files: 1, additions: 0, deletions: 0 })).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/ChatPanel/turnChangeStats.test.ts`
Expected: FAIL —— `Failed to resolve import "./turnChangeStats"`

- [ ] **Step 3: 实现**

Create `src/components/ChatPanel/turnChangeStats.ts`：

```ts
/**
 * 回合结算卡的显示量（纯函数，无 Vue 依赖）。
 *
 * 单独成文件的理由：这些是"数字怎么算、怎么写字"的规则——文案与格式是评审过
 * 的（spec §2.5），值得被用例钉住；卡片组件只管摆放。
 */
import type { ChangeFile } from "@/types";

export interface RoundStats {
  files: number;
  additions: number;
  deletions: number;
}

/** 一轮的规模：文件数 + 逐文件累加的行数。
 *  只吃 `files`（落盘投影）不吃 `touches`——历史轮只有前者，两条路会算出两个数。 */
export function roundStats(files: ChangeFile[]): RoundStats {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files: files.length, additions, deletions };
}

/** 千分位仅在 ≥4 位数字时出现（`+1,240`）。手写而不是 toLocaleString：
 *  后者的分隔符随运行环境 locale 变（德语法语给 `.` / 空格），是"同一份数据两种字"。 */
export function formatCount(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export type BarSegment = { kind: "add" | "del"; flex: number };

/** 比例条的分段：绿=加、红=删，`flex` 取**原始行数**（比例由 flex 分配表达，
 *  长度恒定）——量级由数字承担，条不表达量级（spec §2.4）。
 *  零值不产生分段：纯新增轮不出现空的红段。 */
export function barSegments(s: RoundStats): BarSegment[] {
  const segs: BarSegment[] = [];
  if (s.additions > 0) segs.push({ kind: "add", flex: s.additions });
  if (s.deletions > 0) segs.push({ kind: "del", flex: s.deletions });
  return segs;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/ChatPanel/turnChangeStats.test.ts`
Expected: PASS（10 条）

- [ ] **Step 5: 提交**

```bash
git add src/components/ChatPanel/turnChangeStats.ts src/components/ChatPanel/turnChangeStats.test.ts
git commit -m "feat(chat): 结算卡显示量——统计归并 / 千分位 / 比例条分段（纯函数 + 用例）"
```

---

### Task 3: `TurnChangeCard.vue` —— 三态、文案、比例条、展开清单

**Files:**
- Create: `src/components/ChatPanel/turnChanges.ts`（数据契约）
- Create: `src/components/ChatPanel/TurnChangeCard.vue`
- Test: `src/components/ChatPanel/TurnChangeCard.test.ts`

**Interfaces:**
- Consumes: `roundStats` / `formatCount` / `barSegments`（Task 2）；`ensureTabShown`（Task 1）；既有 `roundRows`（`src/utils/changeFiles.ts`）、`ChangeFileList.vue`、`useSessionWorkspaces().workspaceOf`、`useDiffWindow().openDiff`、`useFileResolver().openResolved`、`useToast`、`errorText`
- Produces:
  - `interface TurnChangesFeed { sid: string; rounds: ChangeRound[]; revertSingleFile: (round: ChangeRound, filePath: string) => Promise<void> }`
  - `TURN_CHANGES_KEY: InjectionKey<Ref<TurnChangesFeed>>`（Task 4 由 App `provide`、ChatPanel `inject`）
  - `TurnChangeCard` 组件：props `{ feed: TurnChangesFeed; sessionId: string | null }`

- [ ] **Step 1: 写失败测试**

Create `src/components/ChatPanel/TurnChangeCard.test.ts`：

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reactive, nextTick } from "vue";
import { mount, flushPromises } from "@vue/test-utils";
import type { ChangeFile, ChangeRound } from "@/types";

const mocks = vi.hoisted(() => ({
  ensureTabShown: vi.fn(),
  openResolved: vi.fn(async () => {}),
  openDiff: vi.fn(async (_row: unknown, _wsRoot?: string) => {}),
  workspaceOf: vi.fn((): { wsKey: string; wsPath: string } | null => null),
}));

const showToastMock = vi.hoisted(() => vi.fn());

// mock 边界：diff 窗口的载荷校验不在这里（窗口层自己的用例管），只验「点了行 →
// 递给窗口层的载荷对不对」；撤回走 feed，不需要 mock。这一层 mock 也顺带挡住
// useFileViewer → useRecent/useNotifications 那一串（它们不在本文件的关注面内）。
vi.mock("../../composables/useRightPanel", () => ({
  useRightPanel: () => ({ ensureTabShown: mocks.ensureTabShown }),
}));
vi.mock("../../composables/useFileResolver", () => ({
  useFileResolver: () => ({ openResolved: mocks.openResolved }),
}));
vi.mock("../../composables/useSessionWorkspaces", () => ({
  useSessionWorkspaces: () => ({ workspaceOf: mocks.workspaceOf }),
}));
vi.mock("../../composables/useDiffWindow", () => ({
  useDiffWindow: () => ({ openDiff: (row: unknown, wsRoot?: string) => mocks.openDiff(row, wsRoot) }),
}));
vi.mock("../../composables/useToast", () => ({
  useToast: () => ({ toastState: { visible: false, text: "", kind: "info" }, showToast: showToastMock }),
}));

import TurnChangeCard from "./TurnChangeCard.vue";
import type { TurnChangesFeed } from "./turnChanges";

const f = (path: string, additions: number, deletions: number, status = "M"): ChangeFile => ({
  path, status, additions, deletions,
});

/** 可控的 feed：rounds 用 reactive 数组，用例可以直接改内容验"实时变"。 */
function makeFeed(rounds: ChangeRound[], sid = "s1", revert = vi.fn(async () => {})): TurnChangesFeed {
  return { sid, rounds, revertSingleFile: revert };
}

function mountCard(feed: TurnChangesFeed, sessionId: string | null = "s1") {
  return mount(TurnChangeCard, {
    props: { feed, sessionId },
    global: { directives: { tooltip: () => {} } },
  });
}

/** 一轮（默认已结算；pending 由用例显式给）。 */
function round(index: number, files: ChangeFile[], pending = false): ChangeRound {
  return { index, time: "10:00", files, pending };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspaceOf.mockReturnValue({ wsKey: "C--repo", wsPath: "C:/repo" });
});

describe("TurnChangeCard — 三态（隐藏 / 进行中 / 已结算）", () => {
  it("0 个文件的轮整卡不渲染——进行中同样适用（不显示「正在改 · 0 个文件」）", () => {
    const w = mountCard(makeFeed(reactive([round(1, [], true)])));
    expect(w.find(".tf").exists()).toBe(false);
  });

  it("本轮没动文件、上一轮动过 → 也没有卡（卡跟随当前轮，不跟随最后一轮有变更的轮）", () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 9, 0)]), round(2, [])])));
    expect(w.find(".tf").exists()).toBe(false);
  });

  it("进行中：卡名「正在改」+ 呼吸点，显示文件数，但无面板入口、无展开", () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 12, 0)], true)])));

    expect(w.get(".tf").classes()).toContain("tf--live");
    expect(w.get(".tf-label").text()).toBe("正在改");
    expect(w.get(".tf-dot").exists()).toBe(true);
    expect(w.find(".tf-panel-link").exists()).toBe(false);
    expect(w.find(".tf-pill").exists()).toBe(false);
    expect(w.get(".tf-big--add").text()).toBe("+12");
  });

  it("等权限（attention）时轮没结束 → 仍是进行中的形态（判据是 round.pending，不是 sessionState）", () => {
    // pending 是归集器/轮次自己的"账单还没结"，等权限不会清它；按 sessionState === "running" 判会在这里露馅
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 3, 1)], true)])));
    expect(w.get(".tf-label").text()).toBe("正在改");
  });

  it("已结算：卡名「本轮变更」，两个出口都在", () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 203, 2)])])));
    expect(w.get(".tf-label").text()).toBe("本轮变更");
    expect(w.get(".tf-panel-link").text()).toBe("变更面板 \u2197");
    expect(w.get(".tf-pill").text()).toContain("展开");
  });

  it("分屏的另一组：feed.sid 与本体会话不符 → 整卡不渲染（不串会话）", () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 1, 0)])]), "other"), "s1");
    expect(w.find(".tf").exists()).toBe(false);
  });
});

describe("TurnChangeCard — 数字与文案（spec §2.5）", () => {
  it("零值不渲染：纯新增轮没有 `−0`；纯删除轮没有 `+0`", () => {
    const add = mountCard(makeFeed(reactive([round(1, [f("a.ts", 64, 0)])])));
    expect(add.find(".tf-big--del").exists()).toBe(false);
    expect(add.get(".tf-big--add").text()).toBe("+64");

    const del = mountCard(makeFeed(reactive([round(1, [f("a.ts", 0, 5)])])));
    expect(del.find(".tf-big--add").exists()).toBe(false);
    expect(del.get(".tf-big--del").text()).toBe("\u22125");
  });

  it("删除号是 U+2212（从原型复制的字形，不是 ASCII 连字符）", () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 203, 2)])])));
    expect(w.get(".tf-big--del").text()).toBe("\u22122");
    expect(w.get(".tf-big--del").text()).not.toContain("-");
  });

  it("千分位仅在 ≥4 位时出现（+1,240），文件数同口径", () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 1240, 386)])])));
    expect(w.get(".tf-big--add").text()).toBe("+1,240");
    expect(w.get(".tf-big--del").text()).toBe("\u2212386");
    expect(w.get(".tf-unit").text()).toBe("1 个文件");
  });

  it("比例条分段：绿红各一段、零值不产生空段（flex 数值本身由 turnChangeStats 用例钉）", () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 203, 2)])])));
    const segs = w.findAll(".tf-bar-seg");
    expect(segs).toHaveLength(2);
    expect(segs[0].classes()).toContain("tf-bar-seg--add");
    expect(segs[1].classes()).toContain("tf-bar-seg--del");

    const pure = mountCard(makeFeed(reactive([round(1, [f("a.ts", 64, 0)])])));
    expect(pure.findAll(".tf-bar-seg")).toHaveLength(1);
    expect(pure.find(".tf-bar-seg--del").exists()).toBe(false);
  });

  it("行 1 / 行 2 分工：已结算态统计量全在行 2，进行中态文件数在行 1", () => {
    const settled = mountCard(makeFeed(reactive([round(1, [f("a.ts", 203, 2)])])));
    expect(settled.get(".tf-nums .tf-unit").text()).toBe("1 个文件");

    const live = mountCard(makeFeed(reactive([round(1, [f("a.ts", 12, 0)], true)])));
    expect(live.get(".tf-top .tf-unit").text()).toBe("1 个文件");
    expect(live.find(".tf-nums .tf-unit").exists()).toBe(false);
  });
});

describe("TurnChangeCard — 展开、清单与两个出口", () => {
  it("点卡片任意非按钮处展开本轮清单（复用 ChangeFileList），再点收起", async () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("src/a.ts", 7, 2)])])));
    expect(w.find(".tf-body").exists()).toBe(false);

    await w.get(".tf").trigger("click");
    expect(w.getAll(".cfl-row")).toHaveLength(1);
    expect(w.get(".tf-pill").text()).toContain("收起");

    await w.get(".tf-pill").trigger("click");
    expect(w.find(".tf-body").exists()).toBe(false);
  });

  it("点文件行开 diff（带会话所属工作区根），且不冒泡成「收起卡片」", async () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("src/a.ts", 7, 2)])])));
    await w.get(".tf").trigger("click");
    await w.get(".cfl-row").trigger("click");
    await flushPromises();

    expect(mocks.openDiff).toHaveBeenCalledTimes(1);
    expect(mocks.openDiff.mock.calls[0][0]).toMatchObject({ path: "src/a.ts" });
    expect(mocks.openDiff.mock.calls[0][1]).toBe("C:/repo");
    expect(w.find(".tf-body").exists()).toBe(true); // 清单没被这次点击塌掉
  });

  it("diff 打不开不静默：toast 说清失败", async () => {
    mocks.openDiff.mockRejectedValueOnce(new Error("git 挂了"));
    const w = mountCard(makeFeed(reactive([round(1, [f("src/a.ts", 7, 2)])])));
    await w.get(".tf").trigger("click");
    await w.get(".cfl-row").trigger("click");
    await flushPromises();

    expect(showToastMock).toHaveBeenCalledWith(expect.stringContaining("加载 diff 失败"), "danger");
  });

  it("「变更面板 ↗」走 ensureTabShown（不是 select 的 toggle），且不顺手展开自己", async () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("a.ts", 1, 0)])])));
    await w.get(".tf-panel-link").trigger("click");
    expect(mocks.ensureTabShown).toHaveBeenCalledWith("changes");
    expect(w.find(".tf-body").exists()).toBe(false);
  });

  it("行内「在编辑器打开」用手写回调 + 会话所属工作区根", async () => {
    const w = mountCard(makeFeed(reactive([round(1, [f("src/a.ts", 7, 2)])])));
    await w.get(".tf").trigger("click");
    await w.findAll(".cfl-act")[0].trigger("click");
    await flushPromises();
    expect(mocks.openResolved).toHaveBeenCalledWith("src/a.ts", "C:/repo");
  });

  it("单文件撤回：走 feed.revertSingleFile(round, path)（面板同款）", async () => {
    const revert = vi.fn(async () => {});
    const w = mountCard(makeFeed(reactive([round(1, [f("src/a.ts", 7, 2)])]), "s1", revert));
    await w.get(".tf").trigger("click");
    await w.get(".cfl-act--revert").trigger("click");
    await flushPromises();

    expect(revert).toHaveBeenCalledTimes(1);
    expect(revert.mock.calls[0][1]).toBe("src/a.ts");
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("撤回失败出声（不静默）：破坏性动作失败必须让用户知道", async () => {
    const revert = vi.fn(async () => { throw new Error("checkout 失败"); });
    const w = mountCard(makeFeed(reactive([round(1, [f("src/a.ts", 7, 2)])]), "s1", revert));
    await w.get(".tf").trigger("click");
    await w.get(".cfl-act--revert").trigger("click");
    await flushPromises();

    expect(showToastMock).toHaveBeenCalledWith(expect.stringContaining("撤回失败"), "danger");
  });

  it("撤回掉本轮最后一个文件 → 整卡消失（不留 0 个文件的空壳）", async () => {
    const rounds = reactive([round(1, [f("src/a.ts", 7, 2)])]);
    const revert = vi.fn(async () => { rounds[0].files = []; });
    const w = mountCard(makeFeed(rounds, "s1", revert));

    expect(w.find(".tf").exists()).toBe(true);
    await w.get(".tf").trigger("click");
    await w.get(".cfl-act--revert").trigger("click");
    await flushPromises();

    expect(w.find(".tf").exists()).toBe(false);
  });
});

describe("TurnChangeCard — 生命周期（展开态属于这一张账单）", () => {
  it("下一轮开始 → 卡名回到「正在改」，展开态不复用", async () => {
    const rounds = reactive([round(1, [f("a.ts", 7, 2)])]);
    const w = mountCard(makeFeed(rounds));
    await w.get(".tf").trigger("click");
    expect(w.find(".tf-body").exists()).toBe(true);

    rounds.push(round(2, [f("b.ts", 3, 0)], true));
    await nextTick();

    expect(w.find(".tf-body").exists()).toBe(false);
    expect(w.get(".tf-label").text()).toBe("正在改");
  });

  it("换会话（feed.sid 变）→ 展开态不继承", async () => {
    const rounds = reactive([round(1, [f("a.ts", 7, 2)])]);
    const feed = reactive(makeFeed(rounds));
    const w = mountCard(feed);
    await w.get(".tf").trigger("click");
    expect(w.find(".tf-body").exists()).toBe(true);

    feed.sid = "s2";
    await nextTick();

    expect(w.find(".tf-body").exists()).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/ChatPanel/TurnChangeCard.test.ts`
Expected: FAIL —— `Failed to resolve import "./TurnChangeCard.vue"`

- [ ] **Step 3: 建数据契约**

Create `src/components/ChatPanel/turnChanges.ts`：

```ts
/**
 * 回合结算卡的数据契约（App 提供 → ChatPanel 注入 → 卡片消费）。
 *
 * 为什么走 provide 而不是逐层透传 props：PaneLayout → PaneSplit（递归）→ PaneGroup
 * → ChatPanel 要为这一个叶子加四个文件的转发；且这份数据**必须**是 App 里
 * useConversationChanges 的唯一实例（归集器的 drain 取走即清空，两个实例会把
 * 同一轮的文件劈成两半，两边都显示不全）。provide 的既有先例见
 * `src/components/panelayout/keys.ts`（WORKSPACE_PATH_KEY）。
 */
import type { InjectionKey, Ref } from "vue";
import type { ChangeRound } from "@/types";

export interface TurnChangesFeed {
  /** 这份数据属于哪个会话（= 聚焦组活动 tab）。卡片与面板的会话不等时整卡不渲染。 */
  sid: string;
  /** 就是右栏变更面板读的那一份 rounds，不是副本。 */
  rounds: ChangeRound[];
  /** 单文件撤回（与面板同一个实例的方法：撤回是唯一的破坏性操作，
   *  必须钉在会话所属工作区上，见 useConversationChanges.revertFile）。 */
  revertSingleFile: (round: ChangeRound, filePath: string) => Promise<void>;
}

export const TURN_CHANGES_KEY: InjectionKey<Ref<TurnChangesFeed>> = Symbol("aide:turnChanges");
```

- [ ] **Step 4: 写组件**

Create `src/components/ChatPanel/TurnChangeCard.vue`：

```vue
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ChangeFile, ChangeRound, TouchedFile } from "@/types";
import { roundRows } from "../../utils/changeFiles";
import { barSegments, formatCount, roundStats } from "./turnChangeStats";
import { useSessionWorkspaces } from "../../composables/useSessionWorkspaces";
import { useDiffWindow } from "../../composables/useDiffWindow";
import { useFileResolver } from "../../composables/useFileResolver";
import { useRightPanel } from "../../composables/useRightPanel";
import { useToast } from "../../composables/useToast";
import { errorText } from "../../utils/errors";
import ChangeFileList from "../ChangeFileList.vue";
import AToast from "../../ui/AToast.vue";
import type { TurnChangesFeed } from "./turnChanges";

/**
 * 回合变更结算卡：消息流尾部的「这一轮一共改了什么」（spec 2026-09-24；
 * 形态与生命周期以 docs/prototypes/2026-09-24-turn-change-footer.html 为准）。
 *
 * 为什么在流尾：做"这轮我接不接受"这个决定时人就在流尾（流式输出把视口钉在底部），
 * 而右栏那个 8 分之 1 的图标在视线边缘。它跟随**当前轮**——下一轮开始就变回
 * `正在改`，上一轮的账单退场（面板里留档，`变更面板 ↗` 就是通往它的门）。
 *
 * 数据只有一个来源：App 的 useConversationChanges 唯一实例（TURN_CHANGES_KEY）。
 * **绝不自建第二份**——见 turnChanges.ts 顶部注释。
 */
const props = defineProps<{
  /** 唯一一份轮次数据（含它属于哪个会话） */
  feed: TurnChangesFeed;
  /** 本面板的会话 id：与 feed.sid 不等时这卡不属于这里（分屏的另一组） */
  sessionId: string | null;
}>();

const isMine = computed(() => props.feed.sid === props.sessionId);

/** 当前轮 = 最新一轮。锚在流尾跟随它，不堆叠历史（spec §5）。 */
const round = computed<ChangeRound | undefined>(() => {
  const list = props.feed.rounds;
  return list.length ? list[list.length - 1] : undefined;
});

/** 进行中 = 轮自己还没结算（startRound 建轮 → solidifyRound 落定）。
 *  不用 `sessionState === "running"`：等权限（attention）时轮没结束，按那个判据
 *  会把半成品的账单亮出来。 */
const live = computed(() => round.value?.pending === true);

/** 0 个文件的轮整卡不渲染——进行中同样适用：卡在第一个文件落下时才出现，
 *  那一刻的"出现"自带信息量。 */
const visible = computed(() => isMine.value && !!round.value && round.value.files.length > 0);

const stats = computed(() => roundStats(round.value?.files ?? []));
const segments = computed(() => barSegments(stats.value));
const rows = computed(() => (round.value ? roundRows(round.value) : []));

const { workspaceOf } = useSessionWorkspaces();
const { openResolved } = useFileResolver();
const { openDiff: openDiffWindow } = useDiffWindow();
const { toastState, showToast } = useToast();
const { ensureTabShown } = useRightPanel();

/** 会话所属工作区根：会话级事实，不猜活动工作区（同 ChangeLogPanel）。 */
const wsRoot = computed(() => workspaceOf(props.feed.sid)?.wsPath || undefined);

/** 展开态是纯展示状态，住在卡内；换轮或换会话即复位——展开态属于"这一张账单"，
 *  不该被下一张继承。 */
const expanded = ref(false);
watch(() => [props.feed.sid, round.value?.index], () => { expanded.value = false; });

function toggleExpand() {
  if (live.value) return; // 进行中没有账单可看（spec §3）
  expanded.value = !expanded.value;
}

/** `变更面板 ↗`：**确保显示**而非 select()——select 是 toggle，已经在该 tab 时
 *  点它会把面板收起来（"给我看看"变成"把你的面板关掉"）。 */
function openPanel() {
  ensureTabShown("changes");
}

async function openFile(f: ChangeFile) {
  await openResolved(f.path, wsRoot.value);
}

/** 点文件行 = 弹该文件 diff（失败出声——窗口没弹出来不能是"点了没反应"）。 */
async function openDiff(row: TouchedFile) {
  try {
    await openDiffWindow(row, wsRoot.value);
  } catch (e) {
    showToast(`加载 diff 失败：${errorText(e)}`, "danger");
  }
}

/** 单文件撤回（与面板同款错误出口）：破坏性动作失败必须出声，否则回滚没发生
 *  而卡上照旧显示"已撤回"。整轮撤回**不在此列**（不可逆操作留在有确认弹窗的面板）。 */
async function revertFile(path: string) {
  const r = round.value;
  if (!r) return;
  try {
    await props.feed.revertSingleFile(r, path);
  } catch (e) {
    showToast(`撤回失败：${errorText(e)}`, "danger");
  }
}
</script>

<template>
  <div
    v-if="visible"
    class="tf"
    :class="{ 'tf--live': live }"
    @click="toggleExpand"
  >
    <div class="tf-top">
      <span v-if="live" class="tf-dot" aria-hidden="true" />
      <span class="tf-label">{{ live ? "正在改" : "本轮变更" }}</span>
      <!-- 进行中：文件数占行 1 右端（此刻行 1 没有动作可放） -->
      <span v-if="live" class="tf-unit tf-unit--end">
        <span class="tf-unit-n">{{ formatCount(stats.files) }}</span> 个文件
      </span>
      <template v-else>
        <button class="tf-panel-link tf-unit--end" @click.stop="openPanel">变更面板 ↗</button>
        <button
          class="tf-pill"
          :aria-expanded="expanded ? 'true' : 'false'"
          @click.stop="toggleExpand"
        >
          {{ expanded ? "收起" : "展开" }}
          <span class="tf-caret" :class="{ 'tf-caret--down': expanded }" aria-hidden="true" />
        </button>
      </template>
    </div>

    <div class="tf-nums">
      <span v-if="!live" class="tf-unit">
        <span class="tf-unit-n">{{ formatCount(stats.files) }}</span> 个文件
      </span>
      <span v-if="stats.additions > 0" class="tf-big tf-big--add">+{{ formatCount(stats.additions) }}</span>
      <span v-if="stats.deletions > 0" class="tf-big tf-big--del">−{{ formatCount(stats.deletions) }}</span>
      <!-- 长度恒定、只表达增删比例：量级由左边的数字承担（spec §2.4）。
           `flex` 写成整串（同原型的 style="flex:12"）：grow=行数、shrink=1、basis=0% -->
      <span class="tf-bar" aria-hidden="true">
        <i
          v-for="seg in segments"
          :key="seg.kind"
          class="tf-bar-seg"
          :class="`tf-bar-seg--${seg.kind}`"
          :style="{ flex: `${seg.flex} 1 0%` }"
        />
      </span>
    </div>

    <!-- 展开体：本轮清单（ChangeFileList 的状态徽标 / 文件图标 / 弱化目录段 / hover 出的
         撤回全现成）。@click.stop —— 点文件行或行内图标不该冒泡成"收起卡片"。 -->
    <div v-if="!live && expanded" class="tf-body" @click.stop>
      <ChangeFileList
        :rows="rows"
        :workspace-root="wsRoot"
        :open-file="openFile"
        :open-diff="openDiff"
        :revert-file="(f: ChangeFile) => revertFile(f.path)"
      />
    </div>

    <!-- 卡内失败出口（diff 打不开 / 撤回失败）：锚在本卡，不进通知中心 -->
    <AToast :state="toastState" placement="inside-bottom" />
  </div>
</template>

<style scoped>
/* ── 卡面（值取自原型页 .tf，颜色一律走 --aide-* token） ── */
.tf {
  position: relative; /* AToast 的定位祖先 */
  margin: 4px 12px; /* 与 .msg-row 的 padding: 4px 12px 对齐（原型是单卡演示页，没有对话列） */
  padding: 9px 13px 11px;
  display: flex;
  flex-direction: column;
  gap: 9px;
  border: 1px solid color-mix(in srgb, var(--aide-accent) 24%, transparent);
  border-radius: var(--aide-radius-md);
  background: radial-gradient(130% 190% at 0% 0%, var(--aide-accent-subtle), transparent 58%), var(--aide-bg-base);
  box-shadow: var(--aide-highlight-inset);
  font-family: var(--aide-font-ui);
  color: var(--aide-text-secondary);
  transition: border-color var(--aide-ease-t), background var(--aide-ease-t);
}

/* 悬停只给可交互（已结算）的卡：进行中的卡没有任何可点处，亮起来是承诺一个不存在的动作。
   只动 accent 透明度与底色——加边框会改盒模型让整卡"抖"。 */
.tf:not(.tf--live) {
  cursor: pointer;
}
.tf:not(.tf--live):hover {
  border-color: color-mix(in srgb, var(--aide-accent) 40%, transparent);
  background: radial-gradient(130% 190% at 0% 0%, color-mix(in srgb, var(--aide-accent) 22%, transparent), transparent 58%), var(--aide-bg-raised);
}

/* ── 进行中：灰调 + 呼吸点，与"结算完成的产出"用颜色分开 ── */
.tf--live {
  border-color: color-mix(in srgb, var(--aide-text-muted) 22%, transparent);
  background: var(--aide-bg-base);
  cursor: default;
}
.tf--live .tf-label {
  color: var(--aide-text-muted);
}

/* ── 行 1：身份 + 动作 ── */
.tf-top {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.tf-label {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 1.1px;
  color: var(--aide-accent);
  text-transform: uppercase;
  white-space: nowrap;
}
.tf-dot {
  flex-shrink: 0;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--aide-accent);
  opacity: 0.85;
  animation: tf-breathe 1.7s ease-in-out infinite;
}
@keyframes tf-breathe {
  0%, 100% { opacity: 0.35; transform: scale(0.85); }
  50%      { opacity: 0.95; transform: scale(1.15); }
}

/* ── 行 2：全部统计量 ── */
.tf-nums {
  display: flex;
  align-items: baseline;
  gap: 10px;
  max-width: 480px; /* 不封顶则数字与条之间裂出几百像素空带（宽窗最终形态待定，spec §11） */
}
.tf-nums .tf-unit {
  margin-right: 5px;
}
.tf-unit {
  font-size: 13px;
  color: var(--aide-text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.tf-unit-n {
  font-family: var(--aide-font-mono);
  color: var(--aide-text-primary);
  font-weight: 600;
  font-size: 14px;
}
.tf-unit--end {
  margin-left: auto;
}
.tf-big {
  font-family: var(--aide-font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1;
  font-size: 19px;
}
.tf-big--add { color: var(--aide-success); }
.tf-big--del { color: var(--aide-danger); }

/* ── 比例条：绿=加、红=删，按行数分**比例**（不是量级）。长度恒定、贴右端、右端不挂文字 ── */
.tf-bar {
  display: flex;
  gap: 1.5px;
  height: 5px;
  border-radius: 99px;
  background: var(--aide-surface-hover); /* surface-default 太淡：纯新增轮会变成一根凭空浮着的绿线 */
  overflow: hidden;
  min-width: 0;
  align-self: center;
  flex: 0 1 230px;
  margin-left: auto;
}
.tf-bar-seg {
  display: block;
  border-radius: 99px;
  min-width: 2px; /* −1 行也看得见（flex-grow/shrink/basis 由行内 style 给） */
}
.tf-bar-seg--add { background: var(--aide-success); opacity: 0.9; }
.tf-bar-seg--del { background: var(--aide-danger); opacity: 0.9; }

/* ── 展开按钮 / 箭头（border 三角同 ProcessGroup：字符 ▾ 与 emoji 换字体就变形） ── */
.tf-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  border: 1px solid var(--aide-border);
  border-radius: 99px;
  background: var(--aide-surface-default);
  color: var(--aide-text-secondary);
  font-size: 11px;
  padding: 3px 10px;
  font-family: var(--aide-font-ui);
  white-space: nowrap;
  cursor: pointer;
}
.tf:not(.tf--live):hover .tf-pill {
  background: var(--aide-surface-hover);
  border-color: var(--aide-border-strong);
  color: var(--aide-text-primary);
}
.tf-caret {
  flex-shrink: 0;
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid currentColor;
  opacity: 0.7;
  transition: transform var(--aide-ease-t);
}
.tf-caret--down {
  transform: rotate(90deg);
}

/* ── 面板入口：沿用变更卡头部「打开 ↗」的既有形制（11px accent 无底无边） ── */
.tf-panel-link {
  flex-shrink: 0;
  background: none;
  border: 0;
  padding: 0;
  color: var(--aide-accent);
  font-size: 11px;
  font-family: var(--aide-font-ui);
  white-space: nowrap;
  cursor: pointer;
}
.tf-panel-link:hover {
  text-decoration: underline;
}

/* ── 展开体 ── */
.tf-body {
  margin-top: 8px; /* 原型逐字；若真机观感偏大，属形态微调，需先拍板 */
  background: var(--aide-bg-deep);
  border: 1px solid var(--aide-border-subtle);
  border-radius: var(--aide-radius-md);
  padding: 3px 0;
}

@media (prefers-reduced-motion: reduce) {
  .tf-dot { animation: none; }
  .tf-caret { transition: none; }
}
</style>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/ChatPanel/TurnChangeCard.test.ts`
Expected: PASS（21 条）。比例条的**实际比例**不在 jsdom 里断言（jsdom 的 CSSOM 对 flex 简写的处理不可靠）：数值由 `turnChangeStats` 用例钉、观感由 Step 7 的截图夹具核。

- [ ] **Step 6: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 无报错（尤其确认 `:style="{ flex: \`${seg.flex} 1 0%\` }"` 与 `TouchedFile` / `ChangeFile` / `ChangeRound` 的 import 类型正确）

- [ ] **Step 7: 真组件截图夹具（形态核对）**

Create `docs/prototypes/_harness/turn-change-card-live.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>回合变更结算卡 · 真实组件渲染</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="./turn-change-card-live.ts"></script>
</body>
</html>
```

Create `docs/prototypes/_harness/turn-change-card-live.ts`：

```ts
/**
 * 截图用活体夹具（一次性验证，不入产品路径）：把**真实的** TurnChangeCard 挂进浏览器，
 * 用真实主题 token 渲染，核对与原型页 turn-change-footer.html 的形态一致——原型是手抄
 * CSS，这里跑的是组件自己的 scoped 样式，能抓到抄错。
 *
 *   npx vite --port 5199 → http://localhost:5199/docs/prototypes/_harness/turn-change-card-live.html
 */
import { createApp, h } from "vue";
import "../../../src/styles/global.css";
import "../../../src/themes/apply";
import { applyTheme } from "../../../src/themes/apply";
import { glass } from "../../../src/themes/glass";
import { vTooltip } from "../../../src/directives/tooltip";
import TurnChangeCard from "../../../src/components/ChatPanel/TurnChangeCard.vue";
import type { TurnChangesFeed } from "../../../src/components/ChatPanel/turnChanges";
import type { ChangeRound } from "../../../src/types";

applyTheme(glass);

const revertSingleFile = async () => {};

function feed(rounds: ChangeRound[]): TurnChangesFeed {
  return { sid: "live", rounds, revertSingleFile };
}

const CASES: { label: string; round: ChangeRound; expanded?: boolean }[] = [
  { label: "① 进行中 · 1 个文件（纯新增）", round: { index: 1, time: "10:00", pending: true, files: [{ path: "src/components/PermissionDialog.vue", status: "M", additions: 12, deletions: 0 }] } },
  { label: "② 进行中 · 3 个文件（有增有删）", round: { index: 2, time: "10:01", pending: true, files: [
    { path: "src/components/PermissionDialog.vue", status: "M", additions: 46, deletions: 6 },
    { path: "src/composables/useKeyboardConsume.ts", status: "M", additions: 2, deletions: 0 },
  ] } },
  { label: "③ 已结算 · 4 个文件 +203 −2", round: { index: 3, time: "10:02", files: [
    { path: "src/components/PermissionDialog.vue", status: "M", additions: 7, deletions: 2 },
    { path: "src/composables/useKeyboardConsume.ts", status: "M", additions: 3, deletions: 0 },
    { path: "docs/specs/2026-08-20-evidence-results-review-brief.md", status: "A", additions: 129, deletions: 0 },
    { path: "src/components/PermissionDialog.test.ts", status: "M", additions: 64, deletions: 0 },
  ] } },
  { label: "④ 已结算 · 大数 12 个文件 +1,240 −386", round: { index: 4, time: "10:03", files: Array.from({ length: 12 }, (_, i) => ({ path: `src/deep/dir${i}/file-${i}.ts`, status: "M", additions: 100 + i, deletions: 30 + i })) } },
  { label: "⑤ 已结算 · 纯删除轮（无 +0、无空绿段）", round: { index: 5, time: "10:04", files: [{ path: "src/old/legacy.ts", status: "D", additions: 0, deletions: 412 }] } },
  { label: "⑥ 已结算 · 展开态", round: { index: 6, time: "10:05", files: [
    { path: "src/components/PermissionDialog.vue", status: "M", additions: 7, deletions: 2 },
    { path: "docs/specs/2026-08-20-evidence-results-review-brief.md", status: "A", additions: 64, deletions: 0 },
  ] }, expanded: true },
];

const app = createApp({
  setup() {
    return () =>
      h("div", { style: "display:flex;flex-direction:column;gap:14px;padding:20px;max-width:820px;background:#0a0b11;min-height:100vh" },
        CASES.map((c, i) =>
          h("div", { "data-case": String(i) }, [
            h("div", { style: "font:11px/1.6 var(--aide-font-ui);color:#7c8296;padding:0 0 6px" }, c.label),
            h(TurnChangeCard, { feed: feed([c.round]), sessionId: "live" }),
          ]),
        ),
      );
  },
});

app.directive("tooltip", vTooltip);
app.mount("#app");

/* 展开态没有对外开关：卡片没有 prop 也没有事件，直接点它（点非按钮区 = 展开/收起） */
setTimeout(() => {
  CASES.forEach((c, i) => {
    if (!c.expanded) return;
    document.querySelector<HTMLElement>(`[data-case="${i}"] .tf:not(.tf--live)`)?.click();
  });
}, 50);
```

Run:
```bash
npx vite --port 5199
```
打开 `http://localhost:5199/docs/prototypes/_harness/turn-change-card-live.html` 截图（Aide 内嵌浏览器 `browser_tab` → `browser_screenshot`，用完 `action=close`），对照原型页 §01 / §03 逐项目视：卡名字号与字距、19px 大数字、比例条贴右端且长度恒定、进行中灰调呼吸点、展开体在 `bg-deep` 上。**发现不一致就改组件的 scoped 样式**（原型是形态权威）。

- [ ] **Step 8: 提交**

```bash
git add src/components/ChatPanel/turnChanges.ts src/components/ChatPanel/TurnChangeCard.vue src/components/ChatPanel/TurnChangeCard.test.ts docs/prototypes/_harness/turn-change-card-live.html docs/prototypes/_harness/turn-change-card-live.ts
git commit -m "feat(chat): 回合变更结算卡——流尾跟随当前轮的三态卡 + 展开清单复用 ChangeFileList"
```

---

### Task 4: 接线（App provide → ChatPanel inject + 渲染）

**Files:**
- Modify: `src/App.vue`（imports；`:321-322` 之后加 provide）
- Modify: `src/components/ChatPanel/ChatPanel.vue`（imports；`setup` 内注入；模板 `.chat-messages-body` 尾部渲染）
- Test: `src/components/ChatPanel/ChatPanel.test.ts`（追加 describe + 顶部 mock）

**Interfaces:**
- Consumes: `TURN_CHANGES_KEY` / `TurnChangesFeed`（Task 3）、`TurnChangeCard`（Task 3）、App 里既有的 `rounds` / `revertSingleFile` / `activeSessionId`
- Produces: 无对外新接口（端到端可见即可）

- [ ] **Step 1: 写失败测试**

在 `src/components/ChatPanel/ChatPanel.test.ts` 的 mock 区（`vi.mock("../AppLogo.vue", ...)` 之后）加：

```ts
// 结算卡在本文件里换成薄壳：接线要验的是"注入了 feed 才渲染、且喂进去的是这份 feed"，
// 卡片内部的形态归 TurnChangeCard.test.ts。壳也顺带挡住卡片那串 composable 依赖。
vi.mock("./TurnChangeCard.vue", () => ({
  default: {
    name: "TurnChangeCard",
    props: { feed: { type: Object, required: true }, sessionId: { type: String, required: false, default: null } },
    template: "<div class='tf-stub' :data-sid='sessionId' />",
  },
}));
```

并在 `import ChatPanel from "./ChatPanel.vue";` 之后加 `import { TURN_CHANGES_KEY } from "./turnChanges";`，文件末尾追加：

```ts
describe("ChatPanel — 回合结算卡的接线", () => {
  const feed = { sid: "s1", rounds: [], revertSingleFile: async () => {} };

  it("没有 feed（非桌面宿主 / 测试）→ 整块不渲染", () => {
    const w = mount(ChatPanel, { props: baseProps({ sessionId: "s1" }) });
    expect(w.find(".tf-stub").exists()).toBe(false);
  });

  it("注入了 feed → 渲染在消息流行末，并把 feed 与本面板会话一起交给卡片", () => {
    const w = mount(ChatPanel, {
      props: baseProps({ sessionId: "s1" }),
      global: { provide: { [TURN_CHANGES_KEY]: ref(feed) } },
    });
    const stub = w.get(".tf-stub");
    expect(stub.attributes("data-sid")).toBe("s1");
    expect(w.findComponent({ name: "TurnChangeCard" }).props("feed")).toEqual(feed);
    // 位置：消息流行末（v-for 之后、内容盒之内）
    expect(w.get(".chat-messages-body").element.lastElementChild?.classList.contains("tf-stub")).toBe(true);
  });
});
```

（`mount` 该文件已 import；`ref` 还没有——把 `import { nextTick } from "vue";` 改成 `import { nextTick, ref } from "vue";`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/ChatPanel/ChatPanel.test.ts`
Expected: FAIL —— 两条新用例红（`.tf-stub` 不存在）；其余既有用例必须仍绿

- [ ] **Step 3: App 侧下发**

`src/App.vue`：

1. `import { ref, onMounted, onUnmounted, nextTick, watch, computed } from "vue";` → 加 `provide`；
2. 加 `import { TURN_CHANGES_KEY, type TurnChangesFeed } from "./components/ChatPanel/turnChanges";`
3. 在 `:322` 的 `const { rounds, revertRound, revertSingleFile, revertFileGlobally } = useConversationChanges(...)` 之后追加：

```ts
// 回合变更结算卡的数据源：与右栏变更面板**同一份 rounds**（唯一实例），只多带一个
// sid——卡片据此判断这份数据是不是自己那个会话的（分屏里另一组显示的是别的会话）。
// 走 provide 而不是逐层透传：PaneLayout → PaneSplit（递归）→ PaneGroup → ChatPanel
// 要为这一个叶子加四个文件的转发（先例见 panelayout/keys.ts 的 WORKSPACE_PATH_KEY）。
provide(TURN_CHANGES_KEY, computed<TurnChangesFeed>(() => ({
  sid: activeSessionId.value,
  rounds: rounds.value,
  revertSingleFile,
})));
```

- [ ] **Step 4: ChatPanel 侧注入 + 渲染**

`src/components/ChatPanel/ChatPanel.vue`：

1. 顶部 `import { ref, watch, nextTick, computed, onMounted, onUnmounted } from "vue";` → 加 `inject`；
2. `import ChatRow from "./ChatRow.vue";` 之后加：

```ts
import TurnChangeCard from "./TurnChangeCard.vue";
import { TURN_CHANGES_KEY } from "./turnChanges";
```

3. `const rootEl = ref<HTMLElement | null>(null);` 之前（setup 顶层）加：

```ts
/** 回合变更结算卡的数据（App 唯一实例的投影，见 turnChanges.ts）。没有它的宿主
 *  （单测 / 非桌面宿主）整块不渲染——不是渲染一张空卡。 */
const turnChanges = inject(TURN_CHANGES_KEY, null);
```

4. 模板 `.chat-messages-body` 内、`<ChatRow v-for="row in rows" ... />` 之后加：

```html
        <!-- 回合变更结算卡：挂在消息流尾部、跟随当前轮（spec 2026-09-24）——
             读完回答、正想"接下来呢"的那一秒它就在视线里。0 个文件的轮整卡不渲染。 -->
        <TurnChangeCard
          v-if="turnChanges"
          :feed="turnChanges"
          :session-id="props.sessionId"
        />
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/ChatPanel/ChatPanel.test.ts`
Expected: PASS（既有用例 + 新增 2 条）

- [ ] **Step 6: 全量测试 + 类型检查**

Run: `pnpm test`
Expected: 全绿（重点看 `src/components/PaneLayout*` / `panelayout` 相关用例没被 provide 影响）

Run: `npx vue-tsc --noEmit`
Expected: 无报错

- [ ] **Step 7: 提交**

```bash
git add src/App.vue src/components/ChatPanel/ChatPanel.vue src/components/ChatPanel/ChatPanel.test.ts
git commit -m "feat(chat): 结算卡接线——App provide 唯一实例投影，ChatPanel 注入并渲染在流尾"
```

---

### Task 5: 真机验收清单 + 状态回写

**Files:**
- Create: `docs/turn-change-card-test-checklist.md`
- Modify: `docs/superpowers/specs/2026-09-24-turn-change-card-design.md`（状态行 + 追加「实现状态」）

**Interfaces:**
- Consumes: 前四个任务的产物
- Produces: 一份零上下文可执行的真机清单（给新会话跑；本会话不跑真机）

- [ ] **Step 1: 写自包含清单**

Create `docs/turn-change-card-test-checklist.md`：把 spec §10 的 ①–⑧ 逐条展开成"操作 → 判据 → 判分"，每条必须**零上下文可执行**（新会话不看 spec 也能跑）。格式对照 `docs/browser-observability-test-checklist.md`。至少覆盖：

1. 一轮 Edit 后**不打开任何侧栏**能说出"几个文件、多少行、偏加还是偏删"。
2. 卡片展开 → 点文件行 → 出 diff 窗口，**≤2 击**。
3. `变更面板 ↗` → 右栏切到「变更」tab；**已在该 tab 且面板展开时点它，面板不得收起**（spec §2.3.1 判据）。
4. 进行中：显示 `正在改` + 呼吸点，**无面板入口、无展开**；数字随编辑实时长。
5. 0 变更的轮（纯问答）**整卡不出现**；本轮第一个文件落下前也不出现。
6. 长会话连排 20 轮无视觉堆积（流尾永远只有一张卡）。
7. 重载（关 tab / 重启 app）后卡片仍在流尾，数字与重载前一致。
8. 卡片在流尾增高（出现 / 数字变长 / 展开清单）时，「回到底部」浮标与自动滚动仍正确（spec §6.4 的滚动锚定实测；**打架就记下来，那是另一笔改动**）。
9. （新增，spec §11 待定项 1 的实测项）宽窗口下统计行 `max-width:480px` 的实际观感——空带是否明显。

文末写清**回写方式**：跑完把结果写回本清单的"实测记录"节 + 更新 spec 状态行。

- [ ] **Step 2: 回写 spec 状态**

改 `docs/superpowers/specs/2026-09-24-turn-change-card-design.md` 头部：

```
状态：**已实现（2026-09-28）；真机验收未做**（清单见 `docs/turn-change-card-test-checklist.md`）
```

并在文末追加「实现状态」一节：逐条对 §6.1「不动清单」（SDK / sidecar / Rust / 落盘格式 / REGISTRY 均未动——`git diff --stat` 可核）、§6.3（淡入砍掉）、§11 四条待定项的处置（1 留待实测、2 未做、3 未做、4 已做泛化）。

- [ ] **Step 3: 提交**

```bash
git add docs/turn-change-card-test-checklist.md docs/superpowers/specs/2026-09-24-turn-change-card-design.md
git commit -m "docs(chat): 结算卡真机验收清单（零上下文可跑）+ spec 状态回写"
```

---

## 收尾（全部任务完成后）

- [ ] `pnpm test` 全绿 + `npx vue-tsc --noEmit` 无报错（在最后一次改动之后再跑一遍）
- [ ] `git diff --stat master` 复核：改动面只有本计划列出的 7 个文件（+2 个夹具 +2 个文档），**没有** sidecar / Rust / SDK / 协议 / 落盘格式的改动
- [ ] 把 `docs/turn-change-card-test-checklist.md` 交给一个新会话跑真机（用户红线：不让用户重开长会话；清单本身自包含）
