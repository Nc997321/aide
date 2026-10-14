/**
 * 连接管理页（多主机版）：我的主机列表（切换/忘记）+ 扫码配对新主机（主路径）
 * + 粘贴配对 URI（兜底）+ 连接状态展示。
 *
 * Aide Link v1（协议 §3）：配对 = 扫 Host 设置里显示的二维码
 * （aide-link://pair?… URI，含中继地址 / Host 公钥 / 一次性密钥）；
 * 粘贴兜底走同一解析路径。配对编排（身份密钥 → 握手 → 存凭据）下沉到 ConnModel。
 * 状态源是 conn/ConnModel 的 @ObservedV2 单例；needsPairing 按 pairError 细分四种文案。
 * 主机卡：字母头像（did 哈希取色）+ 名称/did 短显 + 状态行（正在使用/正在连接/
 * 离线重试/上次连接相对时间）+ 连接 › + 垃圾桶（忘记需自绘确认弹窗）。
 * 扫码用系统 ScanKit（免相机权限，自带相册入口）；用户取消（1000500002）静默。
 * 主题：跟随系统深浅模式（resources/base 亮色 + resources/dark 暗色同名资源自动切换）。
 */
import { scanBarcode, scanCore } from '@kit.ScanKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { common } from '@kit.AbilityKit';
import { ConnModel, connModel, hostColor, hostTint, hostShortId } from '../conn/ConnModel';
import { ConnState } from '../sdk/remote';
import { StoredCreds } from '../sdk/storage';
import { parsePairUri, PairUriError } from '../sdk/pair-uri';
import type { PairOffer } from '../sdk/pair-uri';

/** 遮罩色（与 ChatDrawer 半模态同源）。 */
const MASK_COLOR: ResourceColor = '#661D2129';

/** 状态展示区的互斥态（needsPairing 按 pairError 细分）。 */
type ConnStatus =
  'connecting' | 'connected' | 'offline' | 'expired' | 'badhandshake' | 'revoked' | 'unsupported' | undefined;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 相对时间（上次连接：刚刚 / N 分钟前 / N 小时前 / 昨天 HH:mm / M月D日）。 */
function relTime(ms: number): string {
  if (ms <= 0) {
    return '';
  }
  const now: number = Date.now();
  const diff: number = now - ms;
  if (diff < 60 * 1000) {
    return '刚刚';
  }
  if (diff < 60 * 60 * 1000) {
    return `${Math.floor(diff / (60 * 1000))} 分钟前`;
  }
  if (diff < 24 * 60 * 60 * 1000) {
    return `${Math.floor(diff / (60 * 60 * 1000))} 小时前`;
  }
  const d: Date = new Date(ms);
  const hhmm: string = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const y: Date = new Date(now - 24 * 60 * 60 * 1000);
  if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) {
    return `昨天 ${hhmm}`;
  }
  const n: Date = new Date(now);
  if (d.getFullYear() === n.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

@ComponentV2
export struct ConnectPage {
  @Local conn: ConnModel = connModel;
  /** 粘贴兜底的配对 URI 输入。 */
  @Local uriText: string = '';
  /** URI 解析失败 / 扫码失败的提示（空串 = 无错误）。 */
  @Local uriError: string = '';
  /** 待确认忘记的主机（deviceId；'' = 弹窗关闭）。 */
  @Local forgetTarget: string = '';

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

  /** 主机卡状态行互斥态。 */
  hostStatusOf(h: StoredCreds): string {
    if (this.conn.state === 'connecting' && this.conn.pendingDeviceId === h.deviceId) {
      return 'connecting';
    }
    if (this.conn.state === 'offline' && this.conn.pendingDeviceId === h.deviceId) {
      return 'offline-retry';
    }
    if (this.conn.state === 'authed' && this.conn.activeDeviceId === h.deviceId) {
      return 'active';
    }
    return 'idle';
  }

  hostStatusLabel(h: StoredCreds): string {
    const st: string = this.hostStatusOf(h);
    if (st === 'connecting') {
      return '正在连接…';
    }
    if (st === 'offline-retry') {
      return '连接中断 · 自动重试中';
    }
    if (st === 'active') {
      return '已连接 · 正在使用';
    }
    return h.lastSeen > 0 ? `上次连接 ${relTime(h.lastSeen)}` : '未连接过';
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

  forgetTargetHost(): StoredCreds | null {
    for (let i = 0; i < this.conn.hosts.length; i++) {
      if (this.conn.hosts[i].deviceId === this.forgetTarget) {
        return this.conn.hosts[i];
      }
    }
    return null;
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

  /** 主机字母头像（did 哈希取色，稳定不变）。 */
  @Builder
  hostAvatar(h: StoredCreds) {
    Column() {
      Text(h.hostName !== null && h.hostName !== ''
        ? h.hostName.substring(0, 1).toUpperCase()
        : hostShortId(h.deviceId).substring(0, 1).toUpperCase())
        .fontSize(17)
        .fontWeight(FontWeight.Bold)
        .fontColor(hostColor(h.deviceId))
    }
    .width(40)
    .height(40)
    .borderRadius(12)
    .backgroundColor(hostTint(h.deviceId))
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
  }

  /** 主机卡（当前态高亮描边；连接中卡内 spinner；垃圾桶贴右缘）。 */
  @Builder
  hostCard(h: StoredCreds) {
    Row({ space: 11 }) {
      this.hostAvatar(h)

      Column({ space: 2 }) {
        Row({ space: 6 }) {
          Text(h.hostName !== null && h.hostName !== '' ? h.hostName : hostShortId(h.deviceId))
            .fontSize(15)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('app.color.text_primary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .constraintSize({ maxWidth: 170 })
          if (this.hostStatusOf(h) === 'active') {
            Text('当前')
              .fontSize(9.5)
              .fontWeight(FontWeight.Medium)
              .fontColor($r('app.color.status_ok'))
              .backgroundColor($r('app.color.status_ok_weak'))
              .borderRadius(8)
              .padding({ left: 6, right: 6, top: 1, bottom: 1.5 })
          }
        }
        .alignItems(VerticalAlign.Center)

        Text(hostShortId(h.deviceId))
          .fontSize(10.5)
          .fontColor($r('app.color.text_secondary'))

        Row({ space: 5 }) {
          if (this.hostStatusOf(h) === 'connecting') {
            LoadingProgress().width(11).height(11).color($r('app.color.accent'))
          } else if (this.hostStatusOf(h) === 'active') {
            Column().width(6).height(6).borderRadius(3).backgroundColor($r('app.color.status_ok'))
          }
          Text(this.hostStatusLabel(h))
            .fontSize(11)
            .fontColor($r('app.color.text_secondary'))
        }
        .alignItems(VerticalAlign.Center)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      if (this.hostStatusOf(h) !== 'active') {
        Row({ space: 2 }) {
          Text('连接')
            .fontSize(12.5)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.accent'))
          SymbolGlyph($r('sys.symbol.chevron_right'))
            .fontSize(12)
            .fontColor([$r('app.color.accent')])
        }
        .alignItems(VerticalAlign.Center)
      }

      // 垃圾桶贴卡片右缘（Block 阻冒泡：点删除不触发行点击）
      Row() {
        SymbolGlyph($r('sys.symbol.trash'))
          .fontSize(16)
          .fontColor([$r('app.color.text_secondary')])
      }
      .width(30)
      .height(30)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
      .hitTestBehavior(HitTestMode.Block)
      .onClick(() => {
        this.forgetTarget = h.deviceId;
      })
    }
    .width('100%')
    .padding({ left: 12, right: 8, top: 12, bottom: 12 })
    .borderRadius(14)
    .backgroundColor($r('app.color.card_bg'))
    .border({
      width: this.hostStatusOf(h) === 'active' ? 1.5 : 1,
      color: this.hostStatusOf(h) === 'active' ? $r('app.color.accent') : $r('app.color.line')
    })
    .alignItems(VerticalAlign.Center)
    .onClick(() => {
      this.conn.switchTo(h.deviceId);
    })
  }

  @Builder
  forgetDialog() {
    Column() {
      Text('忘记这台主机？')
        .fontSize(16)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('app.color.text_primary'))
      Text('将删除它的连接凭据，下次使用需重新扫码配对。')
        .fontSize(12.5)
        .fontColor($r('app.color.text_secondary'))
        .lineHeight(20)
        .margin({ top: 8 })
      Row({ space: 10 }) {
        Row() {
          Text('取消')
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.text_primary'))
        }
        .layoutWeight(1)
        .height(40)
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .borderRadius(12)
        .backgroundColor($r('app.color.btn_disabled_bg'))
        .onClick(() => {
          this.forgetTarget = '';
        })

        Row() {
          Text('忘记')
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .fontColor(Color.White)
        }
        .layoutWeight(1)
        .height(40)
        .justifyContent(FlexAlign.Center)
        .alignItems(VerticalAlign.Center)
        .borderRadius(12)
        .backgroundColor($r('app.color.status_danger'))
        .onClick(() => {
          const target: string = this.forgetTarget;
          this.forgetTarget = '';
          this.conn.forgetHost(target);
        })
      }
      .width('100%')
      .margin({ top: 18 })
      .alignItems(VerticalAlign.Center)
    }
    .width('76%')
    .padding(20)
    .borderRadius(16)
    .backgroundColor($r('app.color.card_bg'))
    .alignItems(HorizontalAlign.Center)
    .onClick(() => {
      // 面板内点击不落穿遮罩
    })
  }

  build() {
    Stack() {
      Scroll() {
        Column({ space: 20 }) {
          // ── 头部 ──
          Column({ space: 8 }) {
            Image($r('app.media.startIcon')).width(64).height(64).borderRadius(16)
            Text('aide 远程').fontSize(26).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
            Text('扫码连接你的 Host aide').fontSize(14).fontColor($r('app.color.text_secondary'))
          }
          .margin({ top: 24, bottom: 8 })
          .width('100%')

          // ── 我的主机 ──
          if (this.conn.hosts.length > 0) {
            Column({ space: 8 }) {
              Row({ space: 6 }) {
                Text('我的主机')
                  .fontSize(12)
                  .fontColor($r('app.color.text_secondary'))
                  .letterSpacing(1)
                Blank()
                Text(`${this.conn.hosts.length} 台`)
                  .fontSize(12)
                  .fontColor($r('app.color.text_secondary'))
              }
              .width('100%')
              .alignItems(VerticalAlign.Center)

              ForEach(this.conn.hosts, (h: StoredCreds) => {
                this.hostCard(h)
              }, (h: StoredCreds) => h.deviceId + '|' + (h.hostName ?? '') + '|' + h.lastSeen)
            }
            .width('100%')
            .alignItems(HorizontalAlign.Start)
          }

          // ── 扫码添加（主路径）──
          Button({ type: ButtonType.Capsule }) {
            Row({ space: 8 }) {
              if (this.isBusy()) {
                LoadingProgress().width(14).height(14).color(Color.White)
              }
              Text(this.isBusy() ? '连接中' : '扫二维码添加主机').fontSize(16).fontColor(Color.White)
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

          Text('Host aide → 设置 → Link 配对，显示二维码')
            .fontSize(12)
            .fontColor($r('app.color.text_secondary'))

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
            this.statusCard('⚠', '需要重新配对', '该主机的配对已被撤销或被新设备顶替，请重新扫码', $r('app.color.status_danger'), false)
          }
          if (this.statusOf() === 'unsupported') {
            this.statusCard('⚠', '协议版本不兼容', 'Host 使用了更新的协议版本，请升级本应用', $r('app.color.status_danger'), false)
          }

          // ── 脚注 ──
          Text('自动连接上次使用的主机 · 各主机凭据分别保存')
            .fontSize(11)
            .fontColor($r('app.color.text_secondary'))
            .width('100%')
            .textAlign(TextAlign.Center)
        }
        .width('100%')
        .padding({ left: 24, right: 24, bottom: 32 })
      }
      .width('100%')
      .height('100%')
      .backgroundColor($r('app.color.page_bg'))
      .align(Alignment.Top)
      .scrollBar(BarState.Off)

      // ── 忘记主机确认弹窗（自绘：遮罩 + 居中卡片）──
      if (this.forgetTarget !== '') {
        Column() {
          this.forgetDialog()
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
        .alignItems(HorizontalAlign.Center)
        .backgroundColor(MASK_COLOR)
        .onClick(() => {
          this.forgetTarget = '';
        })
      }
    }
    .width('100%')
    .height('100%')
  }
}
