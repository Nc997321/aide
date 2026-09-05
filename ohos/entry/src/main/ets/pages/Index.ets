/**
 * 入口页：按连接状态二选一渲染——authed 进会话列表页，其余（含未连接/配对中/
 * 离线重试中）停留在连接管理页。对照 remote-pwa 的 view = conn | chat 二态；
 * 会话页为独立 router 页（main_pages 注册），从列表页点击进入。
 */
import { ConnModel, connModel } from '../conn/ConnModel';
import { ConnectPage } from './ConnectPage';
import { SessionsPage } from './SessionsPage';

@Entry
@ComponentV2
struct Index {
  @Local conn: ConnModel = connModel;

  build() {
    Column() {
      if (this.conn.state === 'authed') {
        SessionsPage()
      } else {
        ConnectPage()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_bg'))
  }
}
