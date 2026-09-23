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
import { automationModel } from '../session/AutomationModel';

@Entry
@ComponentV2
struct Index {
  @Local conn: ConnModel = connModel;

  /** 系统返回：浮层逐层收起（自动化浮层 > 半模态 > 抽屉 > chip 浮层，见
   * AutomationModel.handleBack、DrawerState.handleBack 与 ChatStore.handlePopups），
   * 消费则不退出；无浮层返回 false 走默认。页面级返回只落在本页（唯一 @Entry）。 */
  onBackPress(): boolean {
    // 自动化域最前：转录 > 手册 > 表单 > 详情（全屏页式浮层盖住抽屉）
    if (automationModel.handleBack()) {
      return true;
    }
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
    // 背景用 background() 而非 backgroundColor()：背景层自动延伸进状态栏与
    // 底部导航条避让区（官方组件级沉浸方案，内容仍在安全区内布局）——上下
    // 系统栏与页面连成一体；手势导航的底部白条不认 navigationBarColor，只能
    // 靠背景延伸盖住
    .background($r('app.color.page_bg'))
  }
}
