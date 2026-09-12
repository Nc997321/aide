/**
 * 听书模式（Speech Kit · TextReader 朗读控件，系统小艺朗读面板）。
 *
 * 与 TtsModel 轻量播报（textToSpeech 一句话念完即止）互补的「整篇听」：
 *  - 入口：assistant 正文消息尾部语音 chip 点按（VoiceChip 消费本模型状态；
 *    同一 chip 长按 = TtsModel 自动播报开关）。点哪条听哪条——播放列表 = 当前
 *    会话全部 assistant 正文
 *    （纯工具/思考回复无正文不入列），面板内可上/下篇连续听。
 *  - 面板：init 后由系统托管（音色/倍速/定时/进度条/播放列表），品牌名露
 *    「aide 朗读」；start 本身拉起面板，无需再 showPanel。
 *  - 互斥：两套引擎不同通道会叠音。本模块起播前停 TTS（ttsModel.stop()）；
 *    反向（TTS 起播停听书）经调用点注入——ChatEvents 自动播报两处 +
 *    SpeakChip 手动重播前调 readerModel.stop()（本模块不 import ChatModel/
 *    ChatEvents，反向引用会成环；对照 TtsModel 的停止钩子散布模式）。
 *  - 生命周期：懒初始化（首听才 init——朗读控件是重资源，拉起系统 HSP +
 *    TTS 引擎；并发防抖复用同一 Promise）；init 失败（模拟器/无小艺朗读
 *    服务）→ 静默降级 + toast 一次；requestMore 触底一次性 loadMore([],
 *    true) 封口，否则面板播放列表页显示「加载失败」；切会话/离页先停
 *    （ChatModel.open/newSession、ChatPage.aboutToDisappear）。
 *  - 状态：stateChange 映射 PLAYING→朗读中 / PAUSED→停在本条可续播 /
 *    COMPLETED→停在本条可重听 / WAITING·NOT_IN_READ_LIST→清空；stop 事件
 *    （面板关闭）清空。代际计数作废「等 init 的 start」异步段（点击后瞬间
 *    离页的竞态）。
 * 前置条件：EntryAbility.onWindowStageCreate 已调 WindowManager.setWindowStage
 * （否则 init 报 1010600011）；module.json5 已声明 KEEP_BACKGROUND_RUNNING
 * （init 硬性要求，缺则 201）+ GET_NETWORK_INFO（面板切音色）。
 * toast 经 pickToast 注入（ChatPage 挂载时接线，同 TtsModel 模式）。
 */
import { TextReader, ReadStateCode } from '@kit.SpeechKit';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { ChatMessage, ContentBlock, TextBlock } from './ChatBlocks';
import { speechTextOf, ttsModel } from './TtsModel';

/** 面板文章标题上限（取正文首行截断；面板自身约 24 字符省略，这里留足余量）。 */
const TITLE_CAP: number = 30;

@ObservedV2
export class ReaderModel {
  /** 朗读控件当前停留的文章（消息）id；空 = 空闲。 */
  @Trace activeId: string = '';
  /** 正在出声朗读（PLAYING；PAUSED/COMPLETED 为假）。 */
  @Trace playing: boolean = false;
  /** 停在本条且是暂停态（点 chip 续播而非重听）。 */
  @Trace paused: boolean = false;
  /** 朗读服务不可用（init 失败）：静默降级。 */
  @Trace unavailable: boolean = false;
  /** toast 注入（ChatPage 挂载时接线；本模块不 import 页面防循环依赖）。 */
  pickToast: ((msg: string, kind: string) => void) | null = null;

  private inited: boolean = false;
  /** init Promise（并发防抖：初始化中复用同一 Promise，不重复 init）。 */
  private initPromise: Promise<boolean> | null = null;
  private unavailableToasted: boolean = false;
  /** 代际：stop() 递增，作废等待 init 的 start 异步段。 */
  private gen: number = 0;

  /** 轻提示（经注入的 toast 通道；未接线静默）。 */
  toast(msg: string, kind: string): void {
    if (this.pickToast !== null) {
      this.pickToast(msg, kind);
    }
  }

  /** 正在朗读这条？（chip 均衡器动画判定） */
  isReading(id: string): boolean {
    return this.playing && this.activeId === id;
  }

  /** 停在这条（面板暂停/播完）？（chip 高亮 + 续播/重听入口） */
  isCurrent(id: string): boolean {
    return !this.playing && this.activeId === id;
  }

  /** 懒初始化（首听才建：朗读控件要拉起系统 HSP + TTS 引擎；init 失败 =
   *  无小艺朗读服务 → 静默降级 + 一次性提示，不再重试）。 */
  private ensureInit(context: common.BaseContext): Promise<boolean> {
    if (this.unavailable) {
      return Promise.resolve(false);
    }
    if (this.inited) {
      return Promise.resolve(true);
    }
    if (this.initPromise === null) {
      const brand: TextReader.BusinessBrandInfo = { panelName: 'aide 朗读' };
      const param: TextReader.ReaderParam = {
        isVoiceBrandVisible: true, // 面板露出品牌名（businessBrandInfo.panelName）
        businessBrandInfo: brand
      };
      this.initPromise = TextReader.init(context, param)
        .then((): boolean => {
          this.inited = true;
          this.registerListeners();
          console.info('[reader] 朗读控件就绪');
          return true;
        })
        .catch((e: BusinessError): boolean => {
          this.initPromise = null;
          console.warn(`[reader] init 失败 code=${e.code}：${e.message}`);
          this.unavailable = true;
          if (!this.unavailableToasted) {
            this.unavailableToasted = true;
            this.toast('当前设备不支持听书朗读', 'warn');
          }
          return false;
        });
    }
    return this.initPromise;
  }

  /** 事件面接线（init 成功后挂一次；同类型重复注册只有首个生效，勿重复挂）。 */
  private registerListeners(): void {
    TextReader.on('stateChange', (st: TextReader.ReadState): void => {
      console.info(`[reader] stateChange id=${st.id} state=${st.state}`);
      if (st.state === ReadStateCode.PLAYING || st.state === ReadStateCode.PAUSED) {
        this.activeId = st.id;
        this.playing = st.state === ReadStateCode.PLAYING;
        this.paused = st.state === ReadStateCode.PAUSED;
      } else if (st.state === ReadStateCode.COMPLETED) {
        this.activeId = st.id; // 播完停在本条：chip 仍高亮，点按重听
        this.playing = false;
        this.paused = false;
      } else {
        // WAITING / NOT_IN_READ_LIST：整体清空
        this.activeId = '';
        this.playing = false;
        this.paused = false;
      }
    });
    TextReader.on('stop', (): void => {
      console.info('[reader] stop 事件');
      this.activeId = '';
      this.playing = false;
      this.paused = false;
    });
    // 播放列表触底拉更多：一次性封口声明「没有更多」，
    // 不注册/不封口则面板播放列表页显示「加载失败」
    TextReader.on('requestMore', (): void => {
      try {
        TextReader.loadMore([], true);
      } catch (err) {
        // 列表已收尾：忽略
      }
    });
  }

  /** 文章标题：首个正文 TextBlock 的首个非空行剥 Markdown 标记；全空 =
   *  「aide 回复」。截断防长句把面板标题区撑爆。 */
  private titleOf(m: ChatMessage): string {
    for (let i = 0; i < m.blocks.length; i++) {
      const b: ContentBlock = m.blocks[i];
      if (!(b instanceof TextBlock)) {
        continue;
      }
      const lines: string[] = b.text.split('\n');
      for (let j = 0; j < lines.length; j++) {
        let t: string = lines[j].trim();
        if (t === '') {
          continue;
        }
        t = t.replace(/^#{1,6}\s*/, ''); // 标题标记
        t = t.replace(/^>\s*/, ''); // 引用标记
        t = t.replace(/^[-*·]\s+/, ''); // 列表标记
        t = t.replace(/(\*\*|__|\*|~~|`)/g, ''); // 强调/行内代码
        t = t.trim();
        if (t !== '') {
          return t.length > TITLE_CAP ? t.substring(0, TITLE_CAP) : t;
        }
      }
    }
    return 'aide 回复';
  }

  /** 会话 assistant 正文 → 朗读文章列表。正文复用 TtsModel 的 Markdown
   *  剥离（speechTextOf：代码块代读、链接取文字），与轻量播报读音一致。 */
  private buildReadInfos(messages: ChatMessage[]): TextReader.ReadInfo[] {
    const out: TextReader.ReadInfo[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m: ChatMessage = messages[i];
      if (m.role !== 'assistant') {
        continue;
      }
      const body: string = speechTextOf(m);
      if (body === '') {
        continue;
      }
      const title: TextReader.TextInfo = { text: this.titleOf(m), isClickable: false };
      const author: TextReader.TextInfo = {
        text: m.modelLabel !== '' ? m.modelLabel : 'aide',
        isClickable: false
      };
      const info: TextReader.ReadInfo = {
        id: m.id,
        title: title,
        author: author,
        bodyInfo: body
      };
      out.push(info);
    }
    return out;
  }

  /** 从这条开始听（ListenChip 点按入口）：播放列表 = 会话全部 assistant
   *  正文，点哪条听哪条。起播前停 TTS（互斥）；等待 init 期间被停（代际
   *  失配）→ 迟到的 start 立即收掉。 */
  async startFrom(context: common.BaseContext, messages: ChatMessage[], targetId: string): Promise<void> {
    const list: TextReader.ReadInfo[] = this.buildReadInfos(messages);
    let hit: boolean = false;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === targetId) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      return; // 目标无正文（纯工具回复等）：无事可做
    }
    ttsModel.stop(); // 两套引擎会叠音：听书顶掉轻量播报
    this.gen++;
    const g: number = this.gen;
    const ok: boolean = await this.ensureInit(context);
    if (!ok || g !== this.gen) {
      return;
    }
    TextReader.start(list, targetId)
      .then((): void => {
        if (g !== this.gen) {
          // 等待期被 stop：面板会被拉起，立刻收掉
          TextReader.stop().catch((e: BusinessError): void => {
            console.warn(`[reader] 迟到 start 收尾失败 code=${e.code}：${e.message}`);
          });
          return;
        }
        this.activeId = targetId;
        this.playing = true;
        this.paused = false;
      })
      .catch((e: BusinessError): void => {
        console.warn(`[reader] start 失败 code=${e.code}：${e.message}`);
        this.toast('朗读启动失败', 'warn');
      });
  }

  /** 暂停后继续（chip 停留态点按；面板内暂停按钮的镜像入口）。 */
  resume(): void {
    if (!this.inited) {
      return;
    }
    try {
      TextReader.resume();
    } catch (err) {
      console.warn('[reader] resume 调用异常，忽略'); // 引擎态由 stateChange 兜底
    }
  }

  /** 停止朗读并收面板（幂等；切会话/离页/被 TTS 顶掉共用）。 */
  stop(): void {
    this.gen++; // 先作废等待 init 的 start 异步段（空闲时多 bump 无副作用）
    this.activeId = '';
    this.playing = false;
    this.paused = false;
    if (!this.inited) {
      return;
    }
    TextReader.stop().catch((e: BusinessError): void => {
      console.warn(`[reader] stop 失败 code=${e.code}：${e.message}`);
    });
  }
}

/** 全局单例：ListenChip 状态渲染 + 生命周期停止钩子共用。 */
export const readerModel: ReaderModel = new ReaderModel();
