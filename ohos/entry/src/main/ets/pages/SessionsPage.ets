/**
 * 会话列表页：桌面当前工作区的历史会话 + live「回复中」徽标 + 下拉刷新。
 *
 * 信息架构对照 remote-pwa 的会话列表域（App.vue refreshSessions/liveSessions +
 * Drawer 列表），但 UI 为 HarmonyOS 原生风格（List/Refresh/卡片行），不搬 PWA 样式。
 * 点击会话 → 会话页（router pushUrl，参数 ChatPageParams）。
 */
import { ConnModel, connModel } from '../conn/ConnModel';
import { ChatPageParams } from '../session/ChatModel';
import { SessionsModel, sessionsModel } from '../session/SessionsModel';
import { Session } from '../sdk/types';

/** 毫秒时间戳 → 本地化短文本（列表行副标题）。 */
function formatSessionTime(ms: number): string {
  if (ms <= 0) {
    return '';
  }
  const d: Date = new Date(ms);
  const minute: number = d.getMinutes();
  const mm: string = minute < 10 ? `0${minute}` : `${minute}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${mm}`;
}

@ComponentV2
export struct SessionsPage {
  @Local conn: ConnModel = connModel;
  @Local model: SessionsModel = sessionsModel;

  aboutToAppear(): void {
    this.model.ensureListener();
    if (!this.model.loaded) {
      this.model.refresh();
    }
  }

  onSessionTap(s: Session): void {
    const p: ChatPageParams = { sid: s.id, name: s.name };
    try {
      this.getUIContext().getRouter().pushUrl({ url: 'pages/ChatPage', params: p });
    } catch (e) {
      // 跳转失败不阻断列表交互
    }
  }

  @Builder
  emptyState() {
    Column({ space: 8 }) {
      Text('暂无会话').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.text_primary'))
      Text('在桌面 aide 开始对话后，这里会显示当前工作区的历史会话')
        .fontSize(13)
        .fontColor($r('app.color.text_secondary'))
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .padding({ top: 96, left: 40, right: 40 })
    .alignItems(HorizontalAlign.Center)
  }

  build() {
    Column() {
      // ── 顶栏 ──
      Row() {
        Row({ space: 8 }) {
          Column().width(9).height(9).borderRadius(4.5).backgroundColor($r('app.color.status_ok'))
          Text('aide').fontSize(20).fontWeight(FontWeight.Bold).fontColor($r('app.color.text_primary'))
        }
        .alignItems(VerticalAlign.Center)

        Blank()

        Text('断开')
          .fontSize(14)
          .fontColor($r('app.color.text_secondary'))
          .padding({ left: 12, top: 8, bottom: 8 })
          .onClick(() => {
            this.conn.disconnectAll();
          })
      }
      .width('100%')
      .padding({ left: 20, right: 12, top: 12, bottom: 8 })
      .alignItems(VerticalAlign.Center)

      // ── 错误条（拉取失败不静默）──
      if (this.model.lastError !== '') {
        Text(`会话列表拉取失败：${this.model.lastError}`)
          .fontSize(12)
          .fontColor($r('app.color.status_warn'))
          .width('100%')
          .padding({ left: 20, right: 20, bottom: 4 })
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }

      // ── 会话列表（下拉刷新）──
      Refresh({ refreshing: this.model.refreshing }) {
        if (this.model.loaded && this.model.sessions.length === 0) {
          this.emptyState()
        } else {
          List({ space: 8 }) {
            ForEach(this.model.sessions, (s: Session) => {
              ListItem() {
                Row({ space: 12 }) {
                  Column({ space: 4 }) {
                    Text(s.name)
                      .fontSize(15)
                      .fontWeight(FontWeight.Medium)
                      .fontColor($r('app.color.text_primary'))
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                    if (s.timestamp > 0) {
                      Text(formatSessionTime(s.timestamp))
                        .fontSize(12)
                        .fontColor($r('app.color.text_secondary'))
                    }
                  }
                  .alignItems(HorizontalAlign.Start)
                  .layoutWeight(1)

                  if (this.model.isLive(s.id)) {
                    Row({ space: 4 }) {
                      LoadingProgress().width(12).height(12).color($r('app.color.accent'))
                      Text('回复中').fontSize(11).fontColor($r('app.color.accent'))
                    }
                    .alignItems(VerticalAlign.Center)
                  } else {
                    Text('›').fontSize(16).fontColor($r('app.color.text_secondary'))
                  }
                }
                .width('100%')
                .padding({ left: 16, right: 16, top: 12, bottom: 12 })
                .borderRadius(12)
                .backgroundColor($r('app.color.card_bg'))
                .alignItems(VerticalAlign.Center)
                .onClick(() => {
                  this.onSessionTap(s);
                })
              }
            }, (s: Session) => s.id)
          }
          .width('100%')
          .layoutWeight(1)
          .padding({ left: 16, right: 16, top: 4, bottom: 16 })
          .scrollBar(BarState.Off)
          .edgeEffect(EdgeEffect.Spring)
        }
      }
      .onRefreshing(() => {
        this.model.refresh();
      })
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_bg'))
  }
}
