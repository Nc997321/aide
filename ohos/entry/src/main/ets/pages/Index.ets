/**
 * 入口页：按连接状态二选一渲染——authed 进聊天主屏（ChatPage 常驻，会话列表/
 * 工作区/供应商/断开全收进 ChatDrawer 抽屉），其余（含未连接/配对中/离线重试
 * 中）停留在连接管理页。对照 remote-pwa 的 view = conn | chat 二态；仅本页
 * 注册在 main_pages（子组件不注册，@Entry 与注册一一配对）。
 */
import { ConnModel, connModel } from '../conn/ConnModel';
import { ConnectPage } from './ConnectPage';
import { ChatPage } from './ChatPage';
import { drawerState } from '../session/ChatDrawer';
import { chatModel } from '../session/ChatModel';

@Entry
@ComponentV2
struct Index {
  @Local conn: ConnModel = connModel;

  /** 系统返回：浮层逐层收起（半模态 > 抽屉 > chip 浮层，见 DrawerState.handleBack
   * 与 ChatStore.handlePopups），消费则不退出；无浮层返回 false 走默认。页面级
   * 返回只落在本页（唯一 @Entry）。 */
  onBackPress(): boolean {
    if (drawerState.handleBack()) {
      return true;
    }
    return chatModel.store.handlePopups();
  }

  build() {
    Column() {
      if (this.conn.state === 'authed') {
        ChatPage()
      } else {
        ConnectPage()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('app.color.page_bg'))
  }
}
