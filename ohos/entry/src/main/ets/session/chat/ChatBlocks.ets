/**
 * 会话内容块：@ObservedV2 可观察类型 + 子代理条目累积。
 *
 * 过筛自 packages/aide-sdk/src/types/chat.ts（块/消息形状）与
 * useChatSession/state.ts 的块段（appendSubagentTextEntry + P2-1 摊还截断）。
 * ArkTS 化：判别联合（ContentBlock = text | thinking | tool_call | subagent）
 * → interface 判别面 + 各块独立 class，消费端 instanceof 分发。
 * 平台差异：Vue reactive(block) 代理回填 → @ObservedV2 + @Trace 字段级观察
 * （流式增量 last.text += delta 直接驱动渲染，无需替换引用）。
 * 上游 ImageBlock 已随附件发送接入（选入/编码见 ChatAttachments，回灌解析
 * 见 ChatEvents parseUserDisplay）；ActionBlock 仍未收录：ohos 端暂无动作
 * 胶囊通路。VideoBlock 为 ohos 专有（协议无视频通道，取首帧海报 + 元数据；
 * 桌面 blocksFromDisplay 对未知类型安全跳过）。
 */
import { uuid, emptyRecord } from './ChatWire';
import { QuestionSpec, toggleQuestionSelection, canSubmitQuestions, packQuestionAnswers } from './PermissionShape';

/** 块公共面：type 判别 + ForEach 稳定 key。 */
export interface ContentBlock {
  type: string;
  id: string;
}

@ObservedV2
export class TextBlock implements ContentBlock {
  type: string = 'text';
  id: string = '';
  @Trace text: string = '';

  constructor(id: string, text: string) {
    this.id = id;
    this.text = text;
  }
}

@ObservedV2
export class ThinkingBlock implements ContentBlock {
  type: string = 'thinking';
  id: string = '';
  @Trace text: string = '';
  /** 折叠态（默认收起，仅用户点击翻转；段收尾 sealThinking 亦置真——完成即收起）。 */
  @Trace collapsed: boolean = false;
  /** 本思考段仍在流式增长（「思考中…」与流式光标的依据；收尾置假）。 */
  @Trace active: boolean = false;

  constructor(id: string, text: string) {
    this.id = id;
    this.text = text;
  }

  /** 流式段新卡：active + 收起（流式也不自动展开，仅用户点击；appendThinkingDelta 新起段用）。 */
  static streaming(id: string, text: string): ThinkingBlock {
    const b: ThinkingBlock = new ThinkingBlock(id, text);
    b.active = true;
    b.collapsed = true;
    return b;
  }

  /** 历史卡：静态收起（transcript 映射用；无流式语义）。 */
  static history(id: string, text: string): ThinkingBlock {
    const b: ThinkingBlock = new ThinkingBlock(id, text);
    b.collapsed = true;
    return b;
  }
}

/** 用户消息图片块（附件发送 → user_message display 回灌；data: URI 即终态）。 */
@ObservedV2
export class ImageBlock implements ContentBlock {
  type: string = 'image';
  id: string = '';
  /** data: URI（data:image/jpeg;base64,…；非流式，@Trace 保持与兄弟块一致）。 */
  @Trace dataUri: string = '';

  constructor(id: string, dataUri: string) {
    this.id = id;
    this.dataUri = dataUri;
  }
}

/** 用户消息视频块（ohos 专有：首帧海报 + 时长/文件名；模型侧只收海报图）。 */
@ObservedV2
export class VideoBlock implements ContentBlock {
  type: string = 'video';
  id: string = '';
  /** 首帧海报（data: URI，恒 jpeg）。 */
  @Trace posterUri: string = '';
  /** 时长毫秒（徽标 m:ss，见 ChatAttachments durationLabel）。 */
  @Trace durationMs: number = 0;
  @Trace name: string = '';

  constructor(id: string, posterUri: string, durationMs: number, name: string) {
    this.id = id;
    this.posterUri = posterUri;
    this.durationMs = durationMs;
    this.name = name;
  }
}

/** 工具调用块：user 侧 = @引用 Read 卡片（可展开看文件内容）；assistant 侧 =
 * Edit/Write 常驻折叠行（写盘留痕，始终显示不可展开）。其余 assistant 工具
 * 不落 blocks（瞬态行，见 LiveActivity）。 */
@ObservedV2
export class ToolCallBlock implements ContentBlock {
  type: string = 'tool_call';
  /** = tool_use_id（工具结果回填键，兼作 ForEach key）。 */
  id: string = '';
  name: string = '';
  /** JSON 值域（上游 unknown → Object）；展示层 JSON.stringify 摘要。 */
  input: Object = emptyRecord();
  @Trace result: string = '';
  @Trace isError: boolean = false;
  @Trace isPending: boolean = true;
  /** 结果区折叠态（默认收起，点击展开）。 */
  @Trace expanded: boolean = false;

  constructor(id: string, name: string, input: Object, result: string, isError: boolean, isPending: boolean) {
    this.id = id;
    this.name = name;
    this.input = input;
    this.result = result;
    this.isError = isError;
    this.isPending = isPending;
  }
}

/** 子代理时间线单项（上游 SubagentEntry 联合 → 单类 + type 字段）。 */
@ObservedV2
export class SubagentEntry implements ContentBlock {
  type: string = 'text';
  id: string = '';
  /** text/thinking 臂：累积文本。 */
  @Trace text: string = '';
  /** tool 臂。 */
  toolUseId: string = '';
  @Trace toolName: string = '';
  input: Object = emptyRecord();
  @Trace result: string = '';
  @Trace isError: boolean = false;
  /** 截头保尾的累计省略字节（>0 即展示截断标记；对照上游 TruncatedInfo）。 */
  @Trace truncatedBytes: number = 0;
  /** tool 结果折叠态。 */
  @Trace expanded: boolean = false;

  constructor(id: string, type: string) {
    this.id = id;
    this.type = type;
  }
}

@ObservedV2
export class SubagentBlock implements ContentBlock {
  type: string = 'subagent';
  id: string = '';
  @Trace agentName: string = '';
  @Trace description: string = '';
  /** 主代理派发的完整任务描述（非空才展示）。 */
  @Trace prompt: string = '';
  @Trace entries: SubagentEntry[] = [];
  @Trace result: string = '';
  @Trace resultTruncatedBytes: number = 0;
  @Trace isError: boolean = false;
  @Trace isPending: boolean = true;
  /** 子代理实际运行的模型（sidecar 首次坐实时才有值）。 */
  @Trace model: string = '';
  @Trace collapsed: boolean = true;

  constructor(id: string, agentName: string, description: string, prompt: string) {
    this.id = id;
    this.agentName = agentName;
    this.description = description;
    this.prompt = prompt;
  }
}

@ObservedV2
export class ChatMessage {
  id: string = '';
  /** 'user' | 'assistant'（历史行 role==='claude' 映射为 assistant）| 'system'（UI 痕迹，不落盘）。 */
  role: string = 'assistant';
  @Trace blocks: ContentBlock[] = [];
  timestamp: number = 0;
  /** assistant 消息正在流式生成中（message_stop / 用户气泡插入前收尾）。 */
  @Trace streaming: boolean = false;
  /** sidecar 盖在首个块事件上的真实模型（历史消息没有）。 */
  @Trace modelLabel: string = '';

  static userText(id: string, text: string): ChatMessage {
    const m: ChatMessage = new ChatMessage();
    m.id = id;
    m.role = 'user';
    m.timestamp = Date.now();
    m.blocks = [new TextBlock(uuid(), text)];
    return m;
  }

  /** 用户富气泡（附件发送 / display 回灌）：块序照回灌数组（媒体 → 文本 → 引用）。 */
  static userBlocks(id: string, blocks: ContentBlock[]): ChatMessage {
    const m: ChatMessage = new ChatMessage();
    m.id = id;
    m.role = 'user';
    m.timestamp = Date.now();
    m.blocks = blocks;
    return m;
  }

  static assistantStreaming(id: string): ChatMessage {
    const m: ChatMessage = new ChatMessage();
    m.id = id;
    m.role = 'assistant';
    m.timestamp = Date.now();
    m.streaming = true;
    return m;
  }

  /** 系统分隔线（ohos 专有：中断标记等时间线痕迹；纯内存，重载/切换即消）。 */
  static systemNote(id: string, text: string): ChatMessage {
    const m: ChatMessage = new ChatMessage();
    m.id = id;
    m.role = 'system';
    m.timestamp = Date.now();
    m.blocks = [new TextBlock(uuid(), text)];
    return m;
  }
}

/**
 * 瞬态运行行：正在执行的主线程工具调用（bash/read/grep/glob…）。
 * 排版语义：只进 store.liveActivities，不进消息 blocks；tool_result /
 * 轮次收尾即移除——运行期可见、结束即焚，不驻留历史与内存。
 * Edit/Write 例外：不建 LiveActivity，落消息 blocks 常驻折叠行（ToolCallBlock）。
 */
export class LiveActivity {
  id: string = '';
  name: string = '';
  input: Object = emptyRecord();

  constructor(id: string, name: string, input: Object) {
    this.id = id;
    this.name = name;
    this.input = input;
  }
}

/** 忙碌排队的待发消息快照（jump_promoted 时 flush 成用户气泡）。 */
export class PendingJump {
  text: string = '';

  constructor(text: string) {
    this.text = text;
  }
}

/**
 * 后台 shell 任务（镜像 sidecar bg_task_* 事件流；对照上游 BgTask）。
 * 生命周期跨轮次：tool_result 早回来，任务自己跑到 bg_task_ended；
 * 结束不立即移除——状态条「全部完成」停留数秒后由页面触发
 * clearEndedBgTasks 即焚，不进历史（对照桌面 BgTaskDock 的「下次点开清理」）。
 */
@ObservedV2
export class BgTask {
  id: string = '';
  /** 发起它的工具卡片 id（上游 toolUseId；ohos 工具卡已瞬态，暂无消费方）。 */
  toolUseId: string = '';
  @Trace command: string = '';
  @Trace description: string = '';
  /** 'running' | 'completed' | 'failed' | 'stopped'。 */
  @Trace status: string = 'running';
  @Trace output: string = '';
  @Trace summary: string = '';
  startedAt: number = 0;
  @Trace endedAt: number = 0;
  @Trace truncatedBytes: number = 0;

  constructor(id: string) {
    this.id = id;
  }
}

/** 后台任务输出保留上限：截头保尾（尾部最新鲜；摊还策略对照 appendEntryText）。 */
export const BG_OUTPUT_CAP = 64 * 1024;

export function appendBgOutput(task: BgTask, delta: string): void {
  const next: string = task.output + delta;
  if (next.length > BG_OUTPUT_CAP * 2) {
    task.truncatedBytes = task.truncatedBytes + (next.length - BG_OUTPUT_CAP) * 2;
    task.output = next.substring(next.length - BG_OUTPUT_CAP);
  } else {
    task.output = next;
  }
}

@ObservedV2
export class PermissionRequest {
  id: string = '';
  name: string = '';
  input: Object = emptyRecord();
  /** 发起方子代理名（空串 = 主线程）——无它用户无从知道是谁在问。 */
  fromSubagentName: string = '';
  /** AskUserQuestion 解析出的问题清单（事件到达时解析；空 = 非提问/形状不对）。 */
  questions: QuestionSpec[] = [];
  /** 逐题作答草稿（与 questions 下标对齐）：选中的 label 列表 / 自由文本 /
   *  是否走自由文本（与选项互斥）。状态随请求实例走——队头切换即全新草稿，
   *  无跨请求残留（对照 PWA 在组件里 watch id 复位，这里数据即状态）。 */
  @Trace selections: string[][] = [];
  @Trace freeText: string[] = [];
  @Trace useFreeText: boolean[] = [];
  /** 拒绝理由表单开关 + 草稿（提交前临时态；同样随请求实例走）。 */
  @Trace denyOpen: boolean = false;
  @Trace denyReason: string = '';

  /** 事件到达时解析问题清单并初始化逐题草稿（permission_request 专用入口）。 */
  initQuestions(specs: QuestionSpec[]): void {
    this.questions = specs;
    const sels: string[][] = [];
    const texts: string[] = [];
    const frees: boolean[] = [];
    for (let i = 0; i < specs.length; i++) {
      sels.push([]);
      texts.push('');
      frees.push(false);
    }
    this.selections = sels;
    this.freeText = texts;
    this.useFreeText = frees;
  }

  /** 选项点击：单选覆盖、多选增删；改选选项退出自由文本（对照 PWA toggleOption）。 */
  toggleOption(qi: number, label: string): void {
    if (qi < 0 || qi >= this.questions.length) {
      return;
    }
    const cur: string[] | undefined = this.selections[qi];
    this.replaceSelections(qi, toggleQuestionSelection(cur !== undefined ? cur : [], label, this.questions[qi].multiSelect));
    this.replaceUseFreeText(qi, false);
  }

  /** 改走自由文本作答：与选项选择互斥（对照 PWA selectFreeText）。 */
  useFreeTextAnswer(qi: number): void {
    if (qi < 0 || qi >= this.questions.length) {
      return;
    }
    this.replaceUseFreeText(qi, true);
    this.replaceSelections(qi, []);
  }

  setFreeText(qi: number, text: string): void {
    this.replaceFreeText(qi, text);
  }

  /** 全部问题已作答（提交门；零问题恒 false——只剩跳过）。 */
  canSubmitAnswers(): boolean {
    return canSubmitQuestions(this.questions, this.selections, this.freeText, this.useFreeText);
  }

  /** 打包 answers（问题文本 → 答案；仅在 canSubmitAnswers 通过后调用）。 */
  packAnswers(): Record<string, string> {
    return packQuestionAnswers(this.questions, this.selections, this.freeText, this.useFreeText);
  }

  // 草稿更新统一整体替换数组引用（@Trace 字段级观察的最稳路径，数组很小无成本）

  private replaceSelections(qi: number, v: string[]): void {
    const next: string[][] = this.selections.slice();
    next[qi] = v;
    this.selections = next;
  }

  private replaceFreeText(qi: number, v: string): void {
    const next: string[] = this.freeText.slice();
    next[qi] = v;
    this.freeText = next;
  }

  private replaceUseFreeText(qi: number, v: boolean): void {
    const next: boolean[] = this.useFreeText.slice();
    next[qi] = v;
    this.useFreeText = next;
  }
}

// ── 子代理条目累积（对照 state.ts；P2-1 写入时上限，防单个子代理块撑爆内存）──

/** 子代理单条 entry / 最终产出的保留上限：截头保尾（流式结论在尾部）。 */
export const SUBAGENT_ENTRY_CAP = 256 * 1024;

/** 追加 delta 并摊还截断：累积超 2×cap 才截保尾，避免流式热路径 O(n²) 放大。 */
function appendEntryText(entry: SubagentEntry, delta: string): void {
  const next: string = entry.text + delta;
  if (next.length > SUBAGENT_ENTRY_CAP * 2) {
    entry.truncatedBytes = entry.truncatedBytes + (next.length - SUBAGENT_ENTRY_CAP) * 2;
    entry.text = next.substring(next.length - SUBAGENT_ENTRY_CAP);
  } else {
    entry.text = next;
  }
}

/** 逐字增量累积：最后一项同类型原地追加，否则另起一项（类型切换/被工具打断）。 */
export function appendSubagentTextEntry(block: SubagentBlock, kind: string, delta: string): void {
  const last: SubagentEntry | undefined = block.entries[block.entries.length - 1];
  if (last !== undefined && last.type === kind) {
    appendEntryText(last, delta);
    return;
  }
  const entry: SubagentEntry = new SubagentEntry(uuid(), kind);
  block.entries.push(entry);
  appendEntryText(entry, delta);
}
