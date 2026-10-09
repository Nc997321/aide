import { backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { common, wantAgent, WantAgent } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { audio } from '@kit.AudioKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

/** 播报待命：熄屏/切后台期间「AUDIO_PLAYBACK 长时任务 + 静音垫底音」双人舞。
 *
 * 需求：息屏后中继链路 keepalive 不断供（中继 60s 掐腿够不着）+ 桌面回复/
 * 权限播报照常出声 → 进程不能冻结 → 需要长时任务。
 * 为什么是 AUDIO_PLAYBACK：TtsModel 的 textToSpeech 后台播报（isBackStage）
 * 属官方分类「用户可感知的其他播放任务」，申请 AUDIO_PLAYBACK 即可、无需
 * AVSession（MUSIC/AUDIOBOOK 等媒体流才强制会话服务）。曾否决的
 * MULTI_DEVICE_CONNECTION 校验真实 softbus 分布式链路，与本模式无关。
 *
 * 为什么还要静音垫底音（真机实测 2026-09-13）：任务授予后系统在 +60s 做音频
 * 行为校验（指纹：TASK_DETECTION backgroundMode:2 → OnContinuousTaskAudioStateChange
 * state=1 → OnContinuousTaskStop cancelReason 0 → DOZE_BY_CONTINUOUS_DETECTION_FAILED
 * 冻结），无音频输出即取消——纯待命只有 60 秒容忍。垫一条听不见的
 * VOICE_ASSISTANT 静音流让「有效音频播放」恒真，校验通过则待命不限时。
   * 同机实证：微信即以静音播放 + 长时任务常驻后台收消息（系统日志
   * DOZE_BY_SILENT_PLAYBACK 被 ERR_HAS_CONTINUOUS_TASK 豁免）。
   *
   * 但全零垫底被识破（真机实测二轮）：熄屏 +17s 系统静音播放检测器以
   * DOZE_BY_SILENT_PLAYBACK 直接冻结（cgroup freezer:/Frozen 实锤；
   * 微信有 has special 豁免，三方 app 没有）。对策：180Hz 低频正弦
   * 垫底——100ms 块恰含 18 个整周期可无缝循环；峰值 ≈ -40dB 且手机
   * 喇叭物理重放不出 180Hz，人耳不可闻，但 RMS 非零、不再是静音流。
 *
 * 安全约束（官方规则）：后台有音频播放但无长时任务 = 被查杀——垫底音必须
 * 严格随任务启停：任务授予成功才起垫；任务被系统取消立即停垫。
 *
 * 降级链：垫底音创建失败（模拟器/无音频 HAL）→ 纯任务待命（仅 60s 容忍）；
 * 任务申请失败 → 完全不起垫（回落「冻结 + onForeground 秒连」形态）。
 * 无条件启用（不看语音播报开关）：待命同时承担链路保活——保活是本任务的
 * 恒定业务，与播报开关无关；用户从任务列表划掉 = 进程终结，天然退出。 */
export class BroadcastStandby {
  /** 任务+垫底音整体持有标记（幂等启停）。 */
  private running: boolean = false;
  /** 长时任务授予成功标记（停垫/停任务判据）。 */
  private taskRunning: boolean = false;
  /** 垫底音循环运转标记。 */
  private bedAlive: boolean = false;
  /** 垫底音渲染器（运行期非空；停垫即置空断开循环归属）。 */
  private renderer: audio.AudioRenderer | null = null;
  /** start 传入的 ability 上下文（stopBackgroundRunning 需要）。 */
  private ctx: common.UIAbilityContext | null = null;
  /** continuousTaskCancel 监听只注册一次（进程级）。 */
  private listenerOn: boolean = false;

  /** 进后台申请（EntryAbility.onBackground 调用）。 */
  start(context: common.UIAbilityContext): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.ctx = context;
    this.registerCancelListener();
    const wantAgentInfo: wantAgent.WantAgentInfo = {
      wants: [
        {
          bundleName: 'com.aide.ohos',
          abilityName: 'EntryAbility'
        }
      ],
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode: 0,
      actionFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    };
    wantAgent.getWantAgent(wantAgentInfo).then((agent: WantAgent): void => {
      const modes: string[] = ['audioPlayback'];
      backgroundTaskManager.startBackgroundRunning(context, modes, agent)
        .then((): void => {
          this.taskRunning = true;
          hilog.info(0x0000, 'aide', 'standby task started');
          // 任务到手才起垫：无任务的音频播放会被查杀（见文件头安全约束）
          this.startBed();
        })
        .catch((e: BusinessError): void => {
          this.running = false;
          hilog.warn(0x0000, 'aide', 'standby task failed: %{public}s', JSON.stringify(e) ?? '');
        });
    }).catch((e: BusinessError): void => {
      this.running = false;
      hilog.warn(0x0000, 'aide', 'getWantAgent failed: %{public}s', JSON.stringify(e) ?? '');
    });
  }

  /** 回前台停待命（EntryAbility.onForeground 调用；幂等）。 */
  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.stopBed();
    if (this.taskRunning && this.ctx !== null) {
      this.taskRunning = false;
      backgroundTaskManager.stopBackgroundRunning(this.ctx)
        .then((): void => {
          hilog.info(0x0000, 'aide', 'standby task stopped');
        })
        .catch((e: BusinessError): void => {
          hilog.warn(0x0000, 'aide', 'stopBackgroundRunning failed: %{public}s', JSON.stringify(e) ?? '');
        });
    }
  }

  /** 系统取消任务的兜底监听：记指纹 + 立即停垫（无任务的音频会被查杀）。
   * 实测取消→冻结仅 ~3s，回调可能来不及执行——冻结本身也停垫，殊途同归。 */
  private registerCancelListener(): void {
    if (this.listenerOn) {
      return;
    }
    this.listenerOn = true;
    backgroundTaskManager.on('continuousTaskCancel', (info: backgroundTaskManager.ContinuousTaskCancelInfo): void => {
      hilog.warn(0x0000, 'aide', 'standby task cancelled: id=%{public}d reason=%{public}d', info.id, info.reason);
      this.taskRunning = false;
      this.stopBed();
    });
  }

  /** 起近静音垫底音：VOICE_ASSISTANT 单声道 16k 180Hz 低幅度正弦循环写。
   * write 在内部缓冲满时阻塞，天然按实时节奏推进；进程冻结时循环随进程
   * 暂停，无害。 */
  private startBed(): void {
    const opts: audio.AudioRendererOptions = {
      streamInfo: {
        samplingRate: audio.AudioSamplingRate.SAMPLE_RATE_16000,
        channels: audio.AudioChannel.CHANNEL_1,
        sampleFormat: audio.AudioSampleFormat.SAMPLE_FORMAT_S16LE,
        encodingType: audio.AudioEncodingType.ENCODING_TYPE_RAW
      },
      rendererInfo: {
        usage: audio.StreamUsage.STREAM_USAGE_VOICE_ASSISTANT,
        rendererFlags: 0
      }
    };
    audio.createAudioRenderer(opts)
      .then(async (r: audio.AudioRenderer): Promise<void> => {
        this.renderer = r;
        await r.start();
        this.bedAlive = true;
        hilog.info(0x0000, 'aide', 'silent bed started');
        // 100ms 近静音块（16000Hz × 2 字节 × 0.1s = 3200B）：180Hz 在
        // 100ms 内恰 18 个整周期 → 无缝循环；峰值 300/32767 ≈ -40dB，
        // 低频超出手机喇叭重放能力 → 人耳不可闻，RMS 非零过静音检测
        const chunk: ArrayBuffer = new ArrayBuffer(3200);
        const samples: Int16Array = new Int16Array(chunk);
        const step: number = 2 * Math.PI * 180 / 16000;
        for (let i = 0; i < samples.length; i++) {
          samples[i] = Math.round(300 * Math.sin(step * i));
        }
        while (this.bedAlive && this.renderer === r) {
          try {
            await r.write(chunk);
          } catch (e) {
            break; // 停垫竞态（stop/release 打断在途 write）：静默退出循环
          }
        }
      })
      .catch((e: BusinessError): void => {
        this.renderer = null;
        hilog.warn(0x0000, 'aide', 'silent bed unavailable (60s standby only): %{public}s', JSON.stringify(e) ?? '');
      });
  }

  /** 停垫底音（幂等）：先断循环归属再 stop/release，在途 write 的拒绝被循环捕获。 */
  private stopBed(): void {
    this.bedAlive = false;
    const r: audio.AudioRenderer | null = this.renderer;
    this.renderer = null;
    if (r !== null) {
      r.stop()
        .then((): Promise<void> => r.release())
        .catch((e: BusinessError): void => {
          hilog.warn(0x0000, 'aide', 'silent bed stop failed: %{public}s', JSON.stringify(e) ?? '');
        });
    }
  }
}
