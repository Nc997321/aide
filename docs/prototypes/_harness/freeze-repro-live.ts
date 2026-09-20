/**
 * 冻结复现夹具（一次性验证，不入产品路径）：把**真实的** ChatMessage 挂进浏览器，
 * 用产品同款 LoAF / longtask 采集器量「一条含 N 个变更卡的消息」的代价。
 *
 * 由来（2026-09-20）：真机冻结报告里 90~118 个长任务全是 `import.then` +
 * 匿名函数 + 主包，强制同步布局 60~180ms/帧，连成一串 17~28 秒。主包里的
 * 动态 import 只有三处：App.vue 的 7 个懒组件（每个一生只解析一次，凑不出上百条）、
 * cmLanguage 的 14 个语言包、main.ts 的错误上报。而 `loadLanguageExtension`
 * 的调用方只有 CodeEditor 与 DiffViewer，且 ChatMessage 对变更类工具传的是
 * `:default-expanded="isChangeTool(...)"`——**每个 Edit/Write 块都默认展开、都建
 * 一个 CodeMirror merge 视图**。本夹具就是量这一条：挂 N 个变更卡要多久、长什么形状。
 *
 *   npx vite --port 5199 →
 *   http://localhost:5199/docs/prototypes/_harness/freeze-repro-live.html?n=60&mode=mount
 *
 * 2026-09-20 修完的基线（headless Edge，同一台机器，`node %TEMP%\aide-cdp-repro.mjs <url>`）：
 * 变更卡改静态 diff 之前 —— n=40 长帧 13（全 import.then）/脚本 1676ms/强制布局 1144ms/
 * DOM 10762/40 个 .cm-editor；n=80 长帧 35/4677ms/3831ms/21522。改完 —— n=40 长帧 2/
 * 脚本 136ms/**强制布局 0**/DOM 4482/0 个编辑器；n=80 长帧 2/272ms/**0**/8962。
 * 复现基线要 `git stash` 掉 ToolCallBlock 的 StaticDiff 替换。
 *
 * mode：
 *   mount   —— 一次挂载含 N 个变更卡的消息（= 打开/切到一个编辑密集的会话）
 *   rebuild —— 挂 K 个变更卡后，逐轮把消息对象整体换新（= store 每次更新换掉
 *              块对象，props.pair 身份变 → DiffViewer 重建视图）
 *   control —— 同样 N 个卡但换成非变更类工具（不建 DiffViewer），做对照
 */
import { createApp, h, nextTick, ref } from "vue";
import "../../../src/styles/global.css";
import { applyTheme } from "../../../src/themes/apply";
import { glass } from "../../../src/themes/glass";
import { vTooltip } from "../../../src/directives/tooltip";
import ChatMessageView from "../../../src/components/ChatMessage.vue";
import { loadLanguageExtension } from "../../../src/utils/cmLanguage";
import {
  framesSinceDetailed,
  startLongFrames,
  stopLongFrames,
} from "../../../src/utils/diagnostics/longFrames";
import {
  entriesSinceDetailed,
  startLongTasks,
  stopLongTasks,
} from "../../../src/utils/diagnostics/longTasks";
import type { ChatMessage, ContentBlock } from "../../../src/types/chat";

const q = new URLSearchParams(location.search);
const N = Number(q.get("n") || 40);
const MODE = q.get("mode") || "mount";
const ROUNDS = Number(q.get("rounds") || 20);
const K = Number(q.get("k") || 6);

applyTheme(glass);

/** 一段像样的 Java 片段（Edit 卡的真实量级：二三十行，不是三五行）。 */
function javaFragment(i: number, side: string): string {
  const lines = [
    `    @Override`,
    `    public PageResult<EquipmentVO> page${i}(${side}Query query) {`,
    `        LambdaQueryWrapper<Equipment> wrapper = new LambdaQueryWrapper<>();`,
    `        wrapper.eq(StringUtils.hasText(query.getDeviceName()), Equipment::getDeviceName, query.getDeviceName());`,
    `        wrapper.eq(query.getDeptId() != null, Equipment::getDeptId, query.getDeptId());`,
    `        wrapper.ge(query.getStartTime() != null, Equipment::getCreateTime, query.getStartTime());`,
    `        wrapper.le(query.getEndTime() != null, Equipment::getCreateTime, query.getEndTime());`,
    `        wrapper.orderByDesc(Equipment::getCreateTime);`,
    `        Page<Equipment> page = equipmentMapper.selectPage(new Page<>(query.getPageNo(), query.getPageSize()), wrapper);`,
    `        List<EquipmentVO> rows = page.getRecords().stream()`,
    `                .map(this::toVo${i})`,
    `                .collect(Collectors.toList());`,
    `        return PageResult.of(rows, page.getTotal(), query.getPageNo(), query.getPageSize());`,
    `    }`,
    ``,
    `    private EquipmentVO toVo${i}(Equipment entity) {`,
    `        EquipmentVO vo = new EquipmentVO();`,
    `        BeanUtils.copyProperties(entity, vo);`,
    `        vo.setDeviceName(entity.getDeviceName());`,
    `        vo.setFaultTypeName(faultTypeCache.name(entity.getFaultTypeId()));`,
    `        vo.setReporterName(userCache.name(entity.getReporterId()));`,
    `        vo.setDeptName(deptCache.name(entity.getDeptId()));`,
    `        return vo;`,
    `    }`,
  ];
  // 两侧留几行差异，让 diff 有真实改动量
  if (side === "new") {
    lines[3] = `        wrapper.like(StringUtils.hasText(query.getDeviceName()), Equipment::getDeviceName, query.getDeviceName());`;
    lines.splice(15, 0, `        vo.setRepairStatusName(repairCache.name(entity.getRepairStatus()));`);
  }
  return lines.join("\n");
}

let seq = 0;
const nextId = () => `blk-${++seq}`;

/** 变更类工具块（Edit）——ChatMessage 对它传 default-expanded=true → 建 DiffViewer。 */
function changeBlock(i: number): ContentBlock {
  return {
    type: "tool_call",
    id: nextId(),
    name: "Edit",
    input: {
      file_path: `C:\\document\\programs\\chennong\\src\\main\\java\\com\\cn\\equipment\\service\\impl\\Equipment${i}ServiceImpl.java`,
      old_string: javaFragment(i, "old"),
      new_string: javaFragment(i, "new"),
    },
    result: "The file has been updated successfully.",
    isPending: false,
  };
}

/** 对照块：非变更类工具（走 <pre>，不建 DiffViewer）。 */
function plainBlock(i: number): ContentBlock {
  return {
    type: "tool_call",
    id: nextId(),
    name: "Read",
    input: { file_path: `C:\\document\\programs\\chennong\\src\\main\\java\\com\\cn\\Equipment${i}.java` },
    result: javaFragment(i, "old"),
    isPending: false,
  };
}

function makeMessage(blocks: ContentBlock[], id = "msg-1"): ChatMessage {
  return { id, role: "assistant", blocks, timestamp: 0, streaming: false };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 让 LoAF/longtask 条目全部落袋：条目在帧结束后才产生，事件循环转几圈再读。
 *  **不能用 rAF 等**：嵌板隐藏时（document.hidden=true）引擎不给帧，rAF 永不回调，
 *  夹具会挂死在这儿（2026-09-20 实测）。LoAF 同理——隐藏页收不到长帧条目，
 *  只有 longtask 还能读。 */
async function settle(): Promise<void> {
  await nextTick();
  await sleep(400);
  await sleep(400);
}

interface Report {
  mode: string;
  n: number;
  rounds: number;
  /** 主步骤墙钟（ms）：mount 模式=挂载耗时；rebuild 模式=每轮重建耗时数组 */
  stepMs: number[];
  domNodes: number;
  cmEditors: number;
  longTasks: { count: number; totalMs: number; maxMs: number; durations: number[] };
  frames: Array<{ invoker: string; func: string; durationMs: number; forcedLayoutMs: number }>;
  frameScriptMs: number;
  frameForcedMs: number;
}

const out = document.getElementById("out") as HTMLElement;
let report: Partial<Report> = {};

function collect(since: number): void {
  const lt = entriesSinceDetailed(since);
  const lf = framesSinceDetailed(since);
  const durations = lt.tasks.map((e) => e.duration);
  report.longTasks = {
    count: lt.tasks.length,
    totalMs: durations.reduce((a, b) => a + b, 0),
    maxMs: durations.length ? Math.max(...durations) : 0,
    durations,
  };
  report.frames = lf.frames.map((f) => ({
    invoker: f.scripts[0]?.invoker ?? "(no script)",
    func: f.scripts[0]?.func ?? "",
    durationMs: f.durationMs,
    forcedLayoutMs: f.forcedLayoutMs,
  }));
  report.frameScriptMs = lf.frames.reduce((a, f) => a + f.scriptMs, 0);
  report.frameForcedMs = lf.frames.reduce((a, f) => a + f.forcedLayoutMs, 0);
  report.domNodes = document.getElementById("app")!.querySelectorAll("*").length;
  report.cmEditors = document.querySelectorAll(".cm-editor").length;
}

function render(): void {
  out.textContent = JSON.stringify(report, null, 2);
  (window as unknown as { __done?: boolean }).__done = true; // CDP 驱动靠它判断收工
}

async function main(): Promise<void> {
  // 语言包先热一遍：真机上第一个变更卡之后 import 就是缓存命中（微任务），
  // 不预热会把「首次拉 chunk」的网络开销混进测量。
  await loadLanguageExtension("java");
  startLongTasks();
  startLongFrames();
  const t0 = performance.now();

  if (MODE === "mount" || MODE === "control") {
    const blocks = Array.from({ length: N }, (_, i) =>
      MODE === "control" ? plainBlock(i) : changeBlock(i),
    );
    const app = createApp({ setup: () => () => h(ChatMessageView as never, { message: makeMessage(blocks) }) });
    app.directive("tooltip", vTooltip);
    app.mount("#app");
    await nextTick();
    const mountMs = performance.now() - t0;
    await settle();
    report = { mode: MODE, n: N, rounds: 0, stepMs: [Math.round(mountMs)] };
    collect(t0 - 50);
    render();
    return;
  }

  if (MODE === "rebuild") {
    const msg = ref<ChatMessage>(makeMessage(Array.from({ length: K }, (_, i) => changeBlock(i))));
    const app = createApp({ setup: () => () => h(ChatMessageView, { message: msg.value }) });
    app.directive("tooltip", vTooltip);
    app.mount("#app");
    await nextTick();
    await settle();

    // 逐轮把消息换成全新对象（含 input 新引用）——模拟 store 每次更新换掉块对象。
    const stepMs: number[] = [];
    const tRebuild = performance.now();
    for (let r = 0; r < ROUNDS; r++) {
      const t = performance.now();
      msg.value = structuredClone(makeMessage(Array.from({ length: K }, (_, i) => changeBlock(i))));
      await nextTick();
      await sleep(0); // 单独一个任务：和真机上「每条 delta 一个任务」同形
      stepMs.push(performance.now() - t);
    }
    await settle();
    report = { mode: MODE, n: K, rounds: ROUNDS, stepMs: stepMs.map(Math.round) };
    collect(tRebuild - 50);
    render();
    return;
  }

  out.textContent = `unknown mode: ${MODE}`;
}

void main();
