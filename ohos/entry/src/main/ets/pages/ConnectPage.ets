/**
 * 连接管理页：扫码配对（主路径）+ 粘贴配对 URI（兜底）+ 状态展示 + 已配对脚注。
 *
 * Aide Link v1（协议 §3）：配对 = 扫 Host 设置里显示的二维码
 * （aide-link://pair?… URI，含中继地址 / Host 公钥 / 一次性密钥）；
 * 粘贴兜底走同一解析路径。配对编排（身份密钥 → 握手 → 存凭据）下沉到 ConnModel。
 * 状态源是 conn/ConnModel 的 @ObservedV2 单例；needsPairing 按 pairError 细分四种文案。
 * 扫码用系统 ScanKit（免相机权限，自带相册入口）；用户取消（1000500002）静默。
 * 主题：跟随系统深浅模式（resources/base 亮色 + resources/dark 暗色同名资源自动切换）。
 */
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { ConnModel, connModel } from '../conn/ConnModel';
import { ConnState } from '../sdk/remote';
import { parsePairUri, PairUriError } from '../sdk/pair-uri';
import type { PairOffer } from '../sdk/pair-uri';

/** 状态展示区的互斥态（needsPairing 按 pairError 细分）。 */
type ConnStatus =
  'connecting' | 'connected' | 'offline' | 'expired' | 'badhandshake' | 'revoked' | 'unsupported' | undefined;

@ComponentV2
export struct ConnectPage {
  @Local conn: ConnModel = connModel;
  /** 粘贴兜底的配对 URI 输入。 */
  @Local uriText: string = '';
  /** URI 解析失败 / 扫码失败的提示（空串 = 无错误）。 */
  @Local uriError: string = '';

  isBusy(): boolean {
    const s: ConnState = this.conn.state;
    return s === 'connecting' || s === 'authed';
  }

  /** 配对入口（扫码/粘贴共用）：解析 URI → ConnModel 编排配对。 */
  handleUri(value: string): void {
    const raw: string = value.trim();
    if (raw === '') {
      return;
    }
    let offer: PairOffer;
    try {
      offer = parsePairUri(raw);
    } catch (e) {
      this.uriError = e instanceof PairUriError ? e.message : '不是有效的 aide-link 配对码';
      return;
    }
    this.uriError = '';
    this.conn.pairWithOffer(offer);
  }

  onScan(): void {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.uriError = '无法启动扫码';
      return;
    }
    const options: scanBarcode.ScanOptions = {
      scanTypes: [scanCore.ScanType.QR_CODE],
      enableMultiMode: false,
      enableAlbum: true
    };
    scanBarcode.startScanForResult(ctx, options)
      .then((result: scanBarcode.ScanResult) => {
        this.handleUri(result.originalValue);
      })
      .catch((e: Error) => {
        const err = e as BusinessError;
        if (err.code !== 1000500002) { // 1000500002 = 用户取消扫码：静默
          this.uriError = `扫码失败（${err.code}）`;
        }
      });
  }

  /** 互斥归一（needsPairing 的四种归因 → 各自文案）。 */
  statusOf(): ConnStatus {
    switch (this.conn.state) {
      case 'connecting':
        return 'connecting';
      case 'authed':
        return 'connected';
      case 'offline':
        return 'offline';
      case 'needsPairing': {
        const pe = this.conn.pairError;
        if (pe === 'expired') {
          return 'expired';
        }
        if (pe === 'revoked') {
          return 'revoked';
        }
        if (pe === 'unsupported') {
          return 'unsupported';
        }
        return 'badhandshake';
      }
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
          Text('扫码连接你的 Host aide').fontSize(14).fontColor($r('app.color.text_secondary'))
        }
        .margin({ top: 24, bottom: 8 })

        // ── 扫码配对（主路径）──
        Button({ type: ButtonType.Capsule }) {
          Row({ space: 8 }) {
            if (this.isBusy()) {
              LoadingProgress().width(14).height(14).color(Color.White)
            }
            Text(this.isBusy() ? '连接中' : '扫二维码配对').fontSize(16).fontColor(Color.White)
          }
          .justifyContent(FlexAlign.Center)
          .width('100%')
        }
        .width('100%')
        .height(48)
        .backgroundColor($r('app.color.accent'))
        .enabled(!this.isBusy())
        .onClick(() => {
          this.onScan();
        })

        Text('Host aide → 设置 → Link 配对，显示二维码').fontSize(12).fontColor($r('app.color.text_secondary'))

        // ── 粘贴配对码（兜底）──
        Column({ space: 8 }) {
          TextInput({ text: this.uriText, placeholder: '或粘贴配对码 aide-link://pair?…' })
            .onChange((value: string) => {
              this.uriText = value;
              if (this.uriError !== '') {
                this.uriError = '';
              }
            })
            .height(46)
            .fontSize(14)
            .fontColor($r('app.color.text_primary'))
            .placeholderColor($r('app.color.text_secondary'))
            .backgroundColor($r('app.color.input_bg'))
            .borderRadius(10)
            .padding({ left: 12, right: 12 })
          if (this.uriError !== '') {
            Text(this.uriError).fontSize(12).fontColor($r('app.color.status_danger'))
          }
          Button({ type: ButtonType.Capsule }) {
            Text('连 接').fontSize(14).fontColor(Color.White)
          }
          .width('100%')
          .height(40)
          .backgroundColor(
            this.uriText.trim() !== '' && !this.isBusy() ? $r('app.color.accent') : $r('app.color.btn_disabled_bg'))
          .enabled(this.uriText.trim() !== '' && !this.isBusy())
          .onClick(() => {
            this.handleUri(this.uriText);
          })
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)

        // ── 状态展示区：同一位置互斥展示 ──
        if (this.statusOf() === 'connecting') {
          this.statusCard('', '正在连接…',
            this.conn.pairing ? '配对中，等待 Host 确认' : '正在与 Host 建立加密通道',
            $r('app.color.accent'), true)
        }
        if (this.statusOf() === 'connected') {
          this.statusCard('✓', '已连接，正在进入会话…', this.conn.hostName ?? '', $r('app.color.status_ok'), false)
        }
        if (this.statusOf() === 'offline') {
          this.statusCard('', '连接中断，自动重试中…',
            this.conn.pairing ? '配对中断将自动续试（二维码 10 分钟内有效）' : 'Host 不在线或网络不可达',
            $r('app.color.status_warn'), true)
        }
        if (this.statusOf() === 'expired') {
          this.statusCard('✕', '二维码已过期或已被使用', '请在 Host 设置里重新生成二维码', $r('app.color.status_danger'), false)
        }
        if (this.statusOf() === 'badhandshake') {
          this.statusCard('✕', '配对失败', '二维码与这台 Host 不匹配，请重新扫码', $r('app.color.status_danger'), false)
        }
        if (this.statusOf() === 'revoked') {
          this.statusCard('⚠', '需要重新配对', '配对已被撤销或被新设备顶替，请重新扫码', $r('app.color.status_danger'), false)
        }
        if (this.statusOf() === 'unsupported') {
          this.statusCard('⚠', '协议版本不兼容', 'Host 使用了更新的协议版本，请升级本应用', $r('app.color.status_danger'), false)
        }

        // ── 已配对脚注 ──
        if (this.conn.hasCreds) {
          Row({ space: 6 }) {
            Column().width(8).height(8).borderRadius(4).backgroundColor($r('app.color.status_ok'))
            Text(`已配对${this.conn.hostName !== null ? ' · ' + this.conn.hostName : ''} · 下次启动自动连接`)
              .fontSize(12)
              .fontColor($r('app.color.text_secondary'))
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
