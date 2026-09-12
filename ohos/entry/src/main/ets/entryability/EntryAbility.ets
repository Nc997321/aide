import { AbilityConstant, Configuration, ConfigurationConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window, KeyboardAvoidMode, UIContext } from '@kit.ArkUI';
import { WindowManager } from '@kit.SpeechKit';
import { connModel } from '../conn/ConnModel';
import { initStorage } from '../sdk/storage';
import { BroadcastStandby } from './BroadcastStandby';

export default class EntryAbility extends UIAbility {
  /** 主窗口引用（onWindowStageCreate 挂载；系统栏染色的应用对象）。 */
  private windowStage: window.WindowStage | null = null;
  /** 播报待命（AUDIO_PLAYBACK 长时任务 + 静音垫底音；见 BroadcastStandby 头注释）。 */
  private readonly standby: BroadcastStandby = new BroadcastStandby();

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    // 启动序：凭据存储 → 连接模型（context + 上次中继地址 + 已配对标记）→ 有凭据自动续连。
    // makeOpenUrl(this.context) 由 ConnModel.ensureClient 构造 RemoteTransport 时注入。
    initStorage(this.context);
    connModel.init(this.context);
    connModel.autoConnect();
    hilog.info(0x0000, 'aide', '%{public}s', 'Ability onCreate');
  }

  onDestroy(): void {
    hilog.info(0x0000, 'aide', '%{public}s', 'Ability onDestroy');
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    this.windowStage = windowStage;
    // Speech Kit 朗读控件（TextReader）init 前必须注入 windowStage，
    // 否则 init 报 1010600011——尽早挂，页面里懒初始化不再关心时序
    WindowManager.setWindowStage(windowStage);
    // 入口页固定 pages/Index；后续接入连接管理/会话页后仍从这里路由
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(0x0000, 'aide', 'Failed to load the content. Cause: %{public}s', JSON.stringify(err) ?? '');
        return;
      }
      // 键盘避让用 RESIZE（压缩模式）：顶栏驻留、输入区贴键盘；默认 OFFSET
      // 整窗上移会在键盘下方留出大块空白（用户反馈问题）
      const ui: UIContext = windowStage.getMainWindowSync().getUIContext();
      ui.setKeyboardAvoidMode(KeyboardAvoidMode.RESIZE);
      // 系统栏与页面同色（首帧即融合；深浅色切换经 onConfigurationUpdate 重染）
      this.applySystemBarColors(this.isDarkMode(this.context.config?.colorMode));
      hilog.info(0x0000, 'aide', 'Succeeded in loading the content.');
    });
  }

  onConfigurationUpdate(newConfig: Configuration): void {
    // 深浅色切换：页面资源自动重载，系统栏色不跟随——按新色式重染
    if (this.windowStage !== null) {
      this.applySystemBarColors(this.isDarkMode(newConfig.colorMode));
    }
  }

  onWindowStageDestroy(): void {
    this.windowStage = null;
    hilog.info(0x0000, 'aide', '%{public}s', 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    this.standby.stop();
    // 解锁回前台即补一次重连：熄屏期间若播报待命被系统整体取消（垫底音失败
    // 时纯任务仅 60s 容忍，见 BroadcastStandby），进程冻结 → keepalive 断供 →
    // relay 清腿 → 解冻转 offline，其退避计时器随进程冻结而迟到——不等退避，
    // 立即重连。仅 offline 态触发：autoConnect 内部走 connect()，会掐掉活连接，
    // authed/connecting 等活态不可动。
    if (connModel.state === 'offline') {
      connModel.autoConnect();
    }
    hilog.info(0x0000, 'aide', '%{public}s', 'Ability onForeground');
  }

  onBackground(): void {
    this.standby.start(this.context);
    hilog.info(0x0000, 'aide', '%{public}s', 'Ability onBackground');
  }

  /** 系统栏样式：状态栏背景透明——让页面 background() 延伸上来的背景透出
   *  （登录页透出灰 page_bg、聊天页透出白顶栏，各自与内容连成一体；不透明
   *  系统栏层会盖住应用内容，顶栏白就透不出来）；导航栏仍染 page_bg（手势
   *  导航条不消费此值为无操作，三键导航栏设备上与灰底一致）。栏内图标随
   *  深浅色切换深/浅。 */
  private applySystemBarColors(dark: boolean): void {
    if (this.windowStage === null) {
      return;
    }
    const bg: string = dark ? '#0F1117' : '#F1F3F5';
    const fg: string = dark ? '#E8ECF4' : '#1D2129';
    this.windowStage.getMainWindowSync().setWindowSystemBarProperties({
      statusBarColor: '#00000000',
      statusBarContentColor: fg,
      navigationBarColor: bg,
      navigationBarContentColor: fg
    }, (err) => {
      if (err.code) {
        hilog.warn(0x0000, 'aide', 'setWindowSystemBarProperties failed: %{public}s', JSON.stringify(err) ?? '');
      }
    });
  }

  /** 当前是否深色模式（config 未就绪按亮色处理）。 */
  private isDarkMode(mode: ConfigurationConstant.ColorMode | undefined): boolean {
    return mode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
  }
}
