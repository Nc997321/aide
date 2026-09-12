/**
 * 语音播报（Core Speech Kit · textToSpeech，默认小艺语音通道，无需权限声明）。
 *
 * 对照 design/voice-broadcast/app.html 语音模块的真机落地：
 *  - 总开关归语音 chip 长按（VoiceChip）：开 ↔ 关 toast 回报；状态记 preferences
 *    （aide-tts，storage.ets），默认开。播报中点 chip = 只停本次，不动开关。
 *  - 自动播报：回复完成（ChatEvents message_stop）播末位 assistant 正文；
 *    权限请求到达播固定模板（动作 + 单行摘要；提问类播第一题）。
 *  - 播报范围：只读正文 TextBlock（思考/工具行/子代理不读），Markdown 剥成
 *    播报文本（代码块 →「（代码略）」、图片跳过、链接取文字）；新播报打断
 *    旧播报；发消息/切会话/中断/离页一律先停（停止钩子散布 ChatModel/ChatEvents/
 *    ChatPage，对照原型 stopSpeak 的九处调用点）。
 *  - 引擎生命周期：懒建单例（zh-CN / interaction-broadcast / 语音助手通道 /
 *    isBackStage 支持后台播报——切走应用不掐断，权限呼回场景依赖），requestId
 *    过滤迟到回调；音色用推荐 13（聆小珊），创建失败或报音色不支持（1002300003）
 *    → 退回兼容 0；任意 onError / speak 异常 / 忙态滞留 → 丢弃引擎下次重建
 *    （切后台服务被杀等自愈）；queueMode 1 抢占模式（0 是排队，滞留会死队）；
 *    createEngine 全失败（模拟器无小艺服务）→ 静默降级 + toast 一次。
 * 本模块不 import ChatDrawer/ChatModel（ChatDrawer → ChatModel → ChatEvents →
 * 本模块已成链）：toast 经 pickToast 注入（ChatPage 挂载时接线，同
 * ChatAttachments.pickToast 模式）。
 */
import { textToSpeech } from '@kit.CoreSpeechKit';
import { ChatMessage, ContentBlock, TextBlock, PermissionRequest } from './ChatBlocks';
import { PermissionKind, QuestionSpec, judgePermissionKind, parseQuestions } from './PermissionShape';
import { uuid, toolSummary } from './ChatWire';
import { loadTtsEnabled, saveTtsEnabled } from '../../sdk/storage';

/** textToSpeech 单次播报文本上限（超限引擎报 1002300001）。 */
const SPEECH_CAP: number = 10000;

/**
 * 正文 Markdown → 播报文本（对照原型 speechText 的逐行为重写）：
 * 代码块/图片/表格分隔行/分隔线跳过（代码块代读「（代码略）」），链接取文字，
 * 行内代码取内容，剥标题/引用/列表/强调标记；换行读作停顿「，」。
 */
export function speechText(raw: string): string {
  if (raw === '') {
    return '';
  }
  const lines: string[] = raw.split('\n');
  const parts: string[] = [];
  let inCode: boolean = false;
  for (let i = 0; i < lines.length; i++) {
    const trimmed: string = lines[i].trim();
    if (trimmed.startsWith('```')) {
      if (inCode) {
        parts.push('（代码略）');
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      continue;
    }
    let line: string = trimmed;
    line = line.replace(/!\[[^\]]*\]\([^)]*\)/g, ''); // 图片跳过
    line = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // 链接取文字
    line = line.replace(/`([^`]+)`/g, '$1'); // 行内代码取内容
    line = line.replace(/^#{1,6}\s*/, ''); // 标题标记
    line = line.replace(/^>\s*/, ''); // 引用标记
    line = line.replace(/^[-*·]\s+/, ''); // 无序列表标记
    line = line.replace(/^(\d+)\.\s+/, '$1，'); // 有序列表：序号后换停顿
    line = line.replace(/(\*\*|__|\*|~~)/g, ''); // 加粗/斜体/删除线
    if (/^(-{3,}|_{3,})$/.test(line)) {
      continue; // 分隔线
    }
    if (line.startsWith('|') && line.endsWith('|')) {
      if (line.includes('---')) {
        continue; // 表格分隔行
      }
      line = line.replace(/\|/g, '，'); // 表格数据行：竖线读停顿
    }
    if (line !== '') {
      parts.push(line);
    }
  }
  if (inCode) {
    parts.push('（代码略）'); // 未闭合代码块（截断/流式中断兜底）
  }
  let out: string = parts.join('，').replace(/\s{2,}/g, ' ').trim();
  if (out.length > SPEECH_CAP) {
    out = out.substring(0, SPEECH_CAP);
  }
  return out;
}

/** 消息播报文本：只读正文 TextBlock（思考/工具/子代理块不读），块间停顿。 */
export function speechTextOf(m: ChatMessage): string {
  let raw: string = '';
  for (let i = 0; i < m.blocks.length; i++) {
    const b: ContentBlock = m.blocks[i];
    if (b instanceof TextBlock && b.text.trim() !== '') {
      raw += raw === '' ? b.text : `\n\n${b.text}`;
    }
  }
  return speechText(raw);
}

/** 权限播报动作名（对照原型 permLabel）。 */
export function permActionLabel(tool: string): string {
  const t: string = tool.toLowerCase();
  if (t === 'bash' || t === 'shell') {
    return '运行命令';
  }
  if (t === 'write') {
    return '写入文件';
  }
  if (t === 'edit') {
    return '编辑文件';
  }
  if (t === 'webfetch' || t === 'web_search') {
    return '访问网络';
  }
  return `执行 ${tool} 操作`;
}

/**
 * 权限播报固定模板（对照原型 permAnnounce）：工具调用 = 动作 + 单行摘要；
 * 计划批准不念长正文；提问类播第一题文本。
 */
export function permAnnounceText(req: PermissionRequest): string {
  const kind: PermissionKind = judgePermissionKind(req.name);
  if (kind === 'plan') {
    return '需要确认。aide 请求批准计划。请回到手机处理。';
  }
  if (kind === 'question') {
    const questions: QuestionSpec[] = parseQuestions(req.input);
    const first: QuestionSpec | undefined = questions[0];
    if (first !== undefined && first.question !== '') {
      return `需要确认。aide 想问你：${first.question}。请回到手机处理。`;
    }
    return '需要确认。aide 想向你提问。请回到手机处理。';
  }
  const summary: string = toolSummary(req.input);
  return `需要确认。aide 请求${permActionLabel(req.name)}：${summary !== '' ? summary : req.name}。请回到手机处理。`;
}

@ObservedV2
export class TtsModel {
  /** 总开关（持久化，默认开）：关 = 全部播报静音，chip 点击可重开。 */
  @Trace enabled: boolean = true;
  /** 是否正在播报。 */
  @Trace speaking: boolean = false;
  /** 正在播报的目标 id：消息 id / `perm-${请求id}`；空 = 空闲。 */
  @Trace activeId: string = '';
  /** 引擎不可用（createEngine 失败：模拟器无小艺服务等）：静默降级。 */
  @Trace unavailable: boolean = false;
  /** toast 注入（ChatPage 挂载时接线；本模块不 import ChatDrawer 防循环依赖）。 */
  pickToast: ((msg: string, kind: string) => void) | null = null;

  private engine: textToSpeech.TextToSpeechEngine | null = null;
  /** 引擎创建 Promise（并发防抖：创建中复用同一 Promise，不重复建）。 */
  private enginePromise: Promise<textToSpeech.TextToSpeechEngine | null> | null = null;
  private hydrated: boolean = false;
  private unavailableToasted: boolean = false;
  /** 当前播报 requestId（迟到回调过滤）。 */
  private reqId: string = '';
  /** 播报代际：stop() 递增，作废等待引擎创建的 start 异步段。 */
  private gen: number = 0;
  /** 当前音色：13 推荐（聆小珊），不可用时降 0 兼容。 */
  private personTry: number = 13;

  /** 持久化读取（页面挂载时调用；storage 已在 EntryAbility.onCreate 先 init）。
   *  开关开时顺带预热引擎：首播不卡建引擎，并探测设备可用音色清单。 */
  hydrate(): void {
    if (this.hydrated) {
      return;
    }
    this.hydrated = true;
    this.enabled = loadTtsEnabled();
    if (this.enabled) {
      void this.ensureEngine();
    }
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
    saveTtsEnabled(v);
  }

  /** 轻提示（经注入的 toast 通道；未接线静默）。 */
  toast(msg: string, kind: string): void {
    if (this.pickToast !== null) {
      this.pickToast(msg, kind);
    }
  }

  /** 建引擎（懒建，Promise 化；音色 13 创建失败退回 0 重试；再失败 = 无小艺
   *  服务 → 静默降级 + 一次性提示）。 */
  private ensureEngine(): Promise<textToSpeech.TextToSpeechEngine | null> {
    if (this.unavailable) {
      return Promise.resolve(null);
    }
    if (this.engine !== null) {
      return Promise.resolve(this.engine);
    }
    if (this.enginePromise === null) {
      const extra: Record<string, Object> = {
        'style': 'interaction-broadcast',
        'locate': 'CN',
        'name': 'aide_tts',
        'isBackStage': true // 默认不支持后台播报：不设切走应用即被掐断
      };
      const params: textToSpeech.CreateEngineParams = {
        language: 'zh-CN',
        person: this.personTry,
        online: 1,
        extraParams: extra
      };
      this.enginePromise = textToSpeech.createEngine(params)
        .then((e: textToSpeech.TextToSpeechEngine): textToSpeech.TextToSpeechEngine => {
          e.setListener(this.buildListener());
          this.engine = e;
          console.info(`[tts] 引擎就绪 person=${this.personTry}`);
          return e;
        })
        .catch((e: Error): Promise<textToSpeech.TextToSpeechEngine | null> | null => {
          this.enginePromise = null;
          console.warn(`[tts] 建引擎失败 person=${this.personTry}：${e.message ?? ''}`);
          if (this.personTry === 13) {
            this.personTry = 0; // 推荐音色不可用（未下载等）：退回兼容音色重试
            return this.ensureEngine();
          }
          this.unavailable = true;
          if (!this.unavailableToasted) {
            this.unavailableToasted = true;
            this.toast('当前设备不支持语音播报', 'warn');
          }
          return null;
        });
    }
    return this.enginePromise;
  }

  private buildListener(): textToSpeech.SpeakListener {
    return {
      onStart: (requestId: string, _response: textToSpeech.StartResponse): void => {
        console.info(`[tts] onStart ${requestId}`);
      },
      onComplete: (requestId: string, response: textToSpeech.CompleteResponse): void => {
        console.info(`[tts] onComplete ${requestId} type=${response.type}`);
        if (requestId === this.reqId) {
          this.finish();
        }
      },
      onStop: (requestId: string, response: textToSpeech.StopResponse): void => {
        console.info(`[tts] onStop ${requestId} type=${response.type}`);
        if (requestId === this.reqId) {
          this.finish();
        }
      },
      onError: (requestId: string, errorCode: number, errorMessage: string): void => {
        console.warn(`[tts] onError ${errorCode}：${errorMessage}`);
        if (errorCode === 1002300003 && this.personTry === 13) {
          this.personTry = 0; // 音色不支持（未下载）：退回兼容音色，下次播报生效
        }
        const dead: textToSpeech.TextToSpeechEngine | null = this.engine;
        if (dead !== null) {
          // 任意错误都丢弃重建：切后台服务被杀等场景靠这条自愈
          this.dropEngine(dead);
        }
        if (requestId === this.reqId) {
          this.finish();
        }
      }
    };
  }

  /** 播报收尾（幂等）。 */
  private finish(): void {
    if (!this.speaking) {
      return;
    }
    this.reqId = '';
    this.speaking = false;
    this.activeId = '';
  }

  /** 停止当前播报（幂等；发消息/切会话/中断/离页/新播报前共用）。 */
  stop(): void {
    this.gen++; // 先作废等待引擎创建的 start 异步段（空闲时多 bump 无副作用）
    if (!this.speaking) {
      return;
    }
    this.reqId = ''; // 摘 requestId：stop 触发的 onStop 即成迟到回调
    this.speaking = false;
    this.activeId = '';
    if (this.engine !== null) {
      const e: textToSpeech.TextToSpeechEngine = this.engine;
      try {
        e.stop();
      } catch (err) {
        this.dropEngine(e); // 服务已死：丢弃，下次播报重建
      }
    }
  }

  /** 丢弃引擎实例（shutdown 释放；下次 ensureEngine 重建）。 */
  private dropEngine(e: textToSpeech.TextToSpeechEngine): void {
    try {
      e.shutdown();
    } catch (err) {
      // 服务已死：忽略，反正要丢弃
    }
    if (this.engine === e) {
      this.engine = null;
    }
    this.enginePromise = null;
  }

  /** 引擎忙态探测（isBusy 抛异常 = 服务已死，视作滞留）。 */
  private engineBusy(e: textToSpeech.TextToSpeechEngine): boolean {
    try {
      return e.isBusy();
    } catch (err) {
      return true;
    }
  }

  /** 正在播报这个目标？（chip 三态判定） */
  isPlaying(id: string): boolean {
    return this.speaking && this.activeId === id;
  }

  /** 播报 assistant 正文（message_stop 自动 / chip 点击重播共用）。 */
  speakReply(m: ChatMessage): void {
    void this.start(speechTextOf(m), m.id);
  }

  /** 权限请求播报（固定模板）。 */
  speakPermission(req: PermissionRequest): void {
    void this.start(permAnnounceText(req), `perm-${req.id}`);
  }

  /** 播报中若是这条权限请求 → 停（本机应答 / 桌面侧取消后不再念）。 */
  stopPermission(reqId: string): void {
    if (this.activeId === `perm-${reqId}`) {
      this.stop();
    }
  }

  /** 播报原语：开关关/文本空静默；新播报抢占旧播报；引擎缺降级。
   *  异步段（等引擎创建）以代际 + 开关复核守门：等待期被停/被顶掉/被关闭即放弃。
   *  引擎忙态滞留自检：空闲态引擎仍忙（切后台播报被掐断滞留等）→ 丢弃重建再播。 */
  private async start(text: string, id: string): Promise<void> {
    if (!this.enabled || text === '') {
      return;
    }
    const wasSpeaking: boolean = this.speaking;
    this.stop();
    const g: number = this.gen;
    let e: textToSpeech.TextToSpeechEngine | null = await this.ensureEngine();
    if (e === null || !this.enabled || g !== this.gen) {
      return;
    }
    if (!wasSpeaking && this.engineBusy(e)) {
      console.warn('[tts] 引擎忙态滞留，丢弃重建');
      this.dropEngine(e);
      e = await this.ensureEngine();
      if (e === null || !this.enabled || g !== this.gen) {
        return;
      }
    }
    const rid: string = uuid();
    const extra: Record<string, Object> = {
      'queueMode': 1, // 抢占模式：新播报顶掉旧播报（0 是排队，滞留会死队）
      'speed': 1,
      'volume': 2,
      'pitch': 1,
      'languageContext': 'zh-CN',
      'audioType': 'pcm',
      'soundChannel': 3, // 语音助手通道（小艺）
      'playType': 1 // 合成并播报，不回音频流
    };
    const params: textToSpeech.SpeakParams = {
      requestId: rid,
      extraParams: extra
    };
    this.reqId = rid;
    this.activeId = id;
    this.speaking = true;
    console.info(`[tts] speak ${rid} len=${text.length} person=${this.personTry}`);
    try {
      e.speak(text, params);
    } catch (err) {
      console.warn('[tts] speak 调用异常，丢弃引擎重建');
      this.dropEngine(e);
      this.finish();
    }
  }
}

/** 全局单例：SpeakChip 三态渲染 + 事件面自动播报共用。 */
export const ttsModel: TtsModel = new TtsModel();
