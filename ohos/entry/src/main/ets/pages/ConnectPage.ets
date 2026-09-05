/**
 * 连接管理页：配对码连接 + 五态状态展示 + 已配对脚注。
 *
 * 信息架构对照 remote-pwa/src/components/ConnectView.vue（表单/状态区/脚注三层）；
 * 状态源是 conn/ConnModel 的 @ObservedV2 单例。
 * 主题：跟随系统深浅模式（resources/base 亮色 + resources/dark 暗色同名资源自动切换），
 * 不绑定 aide 品牌主题。
 * 上游差异：pairWithCode 的编排（连接→配对→存凭据）下沉到 ConnModel，页面只收输入。
 */
import { ConnModel, connModel, PairError } from '../conn/ConnModel';
import { ConnState } from '../sdk/remote';

/** 状态展示区的互斥五态（原型 data-st 映射）。 */
type ConnStatus = 'connecting' | 'connected' | 'offline' | 'badcode' | 'revoked' | undefined;

@ComponentV2
export struct ConnectPage {
  @Local conn: ConnModel = connModel;
  @Local relayUrl: string = connModel.savedRelayUrl;
  @Local code: string = '';

  aboutToAppear(): void {
    // EntryAbility.onCreate 已 init（早于页面加载）；此处兜底同步一次预填值
    this.relayUrl = this.conn.savedRelayUrl;
  }

  /** 配对码输入：只留数字、最多 6 位；输入即清错误态（原型：error 时输入回 idle）。 */
  onCodeInput(value: string): void {
    let cleaned: string = '';
    for (let i = 0; i < value.length; i++) {
      const ch: string = value.charAt(i);
      if (ch >= '0' && ch <= '9' && cleaned.length < 6) {
        cleaned += ch;
      }
    }
    this.code = cleaned;
    if (this.conn.pairError !== undefined) {
      this.conn.pairError = undefined;
    }
  }

  isBusy(): boolean {
    const s: ConnState = this.conn.state;
    return s === 'connecting' || s === 'bridged' || s === 'authed';
  }

  canConnect(): boolean {
    return !this.isBusy() && this.code.length === 6;
  }

  onConnect(): void {
    if (!this.canConnect()) {
      return;
    }
    this.conn.pairWithCode(this.relayUrl.trim(), this.code);
  }

  /** 五态互斥归一（对照上游 status computed）。 */
  statusOf(): ConnStatus {
    switch (this.conn.state) {
      case 'connecting':
      case 'bridged':
        return 'connecting';
      case 'authed':
        return 'connected';
      case 'offline':
        return 'offline';
      case 'needsPairing':
        return this.conn.pairError === 'revoked' ? 'revoked' : 'badcode';
      default:
        return undefined;
    }
  }

  @Builder
  statusCard(icon: string, title: string, sub: string, tone: ResourceColor, spinning: boolean) {
    Row({ space: 10 }) {
      if (spinning) {
        LoadingProgress().width(16).height(16).color(tone)
      } else {
        Text(icon).fontSize(14).fontColor(tone)
      }
      Column({ space: 2 }) {
        Text(title).fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
        Text(sub).fontSize(12).fontColor($r('app.color.text_secondary'))
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .padding(12)
    .borderRadius(12)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(VerticalAlign.Center)
  }

  build() {
    Scroll() {
      Column({ space: 20 }) {
        // ── 头部 ──
        Column({ space: 8 }) {
          Image($r('app.media.startIcon')).width(64).height(64).borderRadius(16)
          Text('aide 远程').fontSize(26).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
          Text('用手机远程控制你的桌面 aide').fontSize(14).fontColor($r('app.color.text_secondary'))
        }
        .margin({ top: 24, bottom: 8 })

        // ── 中继服务器 ──
        Column({ space: 8 }) {
          Text('中继服务器').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
          TextInput({ text: this.relayUrl, placeholder: 'wss://relay.example.com' })
            .onChange((value: string) => {
              this.relayUrl = value;
            })
            .height(46)
            .fontSize(14)
            .fontColor($r('app.color.text_primary'))
            .placeholderColor($r('app.color.text_secondary'))
            .backgroundColor($r('app.color.input_bg'))
            .borderRadius(10)
            .padding({ left: 12, right: 12 })
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)

        // ── 配对码 ──
        Column({ space: 8 }) {
          Text('配对码').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
          TextInput({ text: this.code, placeholder: '––––––' })
            .type(InputType.Number)
            .maxLength(6)
            .inputFilter('[0-9]')
            .onChange((value: string) => {
              this.onCodeInput(value);
            })
            .height(46)
            .fontSize(18)
            .fontColor(this.conn.pairError === 'badcode' ? $r('app.color.status_danger') : $r('app.color.text_primary'))
            .placeholderColor($r('app.color.text_secondary'))
            .backgroundColor($r('app.color.input_bg'))
            .borderRadius(10)
            .padding({ left: 12, right: 12 })
            .border({
              width: this.conn.pairError === 'badcode' ? 1 : 0,
              color: $r('app.color.status_danger')
            })
          if (this.conn.pairError === 'badcode') {
            Text('配对码无效或已过期，请重新输入').fontSize(12).fontColor($r('app.color.status_danger'))
          } else {
            Text('桌面 aide → 设置 → 远程控制，查看 6 位配对码').fontSize(12).fontColor($r('app.color.text_secondary'))
          }
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)

        // ── 连接按钮 ──
        Button({ type: ButtonType.Capsule }) {
          Row({ space: 8 }) {
            if (this.isBusy()) {
              LoadingProgress().width(14).height(14).color(Color.White)
            }
            Text(this.isBusy() ? '连接中' : '连 接').fontSize(16).fontColor(Color.White)
          }
          .justifyContent(FlexAlign.Center)
          .width('100%')
        }
        .width('100%')
        .height(48)
        .backgroundColor(this.canConnect() ? $r('app.color.accent') : $r('app.color.btn_disabled_bg'))
        .enabled(this.canConnect())
        .onClick(() => {
          this.onConnect();
        })

        // ── 状态展示区：同一位置互斥展示五种状态 ──
        if (this.statusOf() === 'connecting') {
          this.statusCard('', '正在连接中继服务器…', this.relayUrl !== '' ? this.relayUrl : 'wss://relay.example.com', $r('app.color.accent'), true)
        }
        if (this.statusOf() === 'connected') {
          this.statusCard('✓', '已连接，正在进入会话…', '正在加载会话列表', $r('app.color.status_ok'), false)
        }
        if (this.statusOf() === 'offline') {
          this.statusCard('', '设备离线', '桌面 aide 未开启远程控制，或中继无法连接，正在自动重试…', $r('app.color.status_warn'), true)
        }
        if (this.statusOf() === 'badcode') {
          this.statusCard('✕', '配对码无效或已过期', '请回到桌面 aide 重新获取配对码', $r('app.color.status_danger'), false)
        }
        if (this.statusOf() === 'revoked') {
          this.statusCard('⚠', '需要重新配对', '本设备的登录凭证已被吊销，请输入新配对码', $r('app.color.status_danger'), false)
        }

        // ── 已配对脚注 ──
        if (this.conn.hasCreds) {
          Row({ space: 6 }) {
            Column().width(8).height(8).borderRadius(4).backgroundColor($r('app.color.status_ok'))
            Text('本设备已配对 · 下次启动自动连接').fontSize(12).fontColor($r('app.color.text_secondary'))
          }
          .alignItems(VerticalAlign.Center)
        }
      }
      .width('100%')
      .padding({ left: 24, right: 24, bottom: 32 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_bg'))
    .align(Alignment.Top)
    .scrollBar(BarState.Off)
  }
}
