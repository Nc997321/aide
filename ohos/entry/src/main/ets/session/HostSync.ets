/**
 * 换主机复位协调器：connModel.onHostChanged → 会话层整体复位 + 并行重建。
 *
 * 为什么存在：ConnModel 不能 import 会话模型（会话模型 → connModel 已成链，
 * 回指即环），「换了一台主机」的复位编排沉到这里，由 EntryAbility.onCreate
 * 注册一次（registerHostSync，在 connModel.init 之后、autoConnect 之前）。
 *
 * 复位面（v1 单活连接，切换 = 旧主机的全部内存缓存作废）：
 *  - 播报/听书停止 + 会话 store 整体回空态（chatModel.newSession 内含）
 *  - 抽屉收起 + 全部半模态收起（drawerState.close）
 *  - 四模型 resetForHost（列表/工作区/供应商/自动化 + 全部浮层）
 *  - 并行 refresh 重建（切完抽屉数据即就绪；失败各模型自持错误态）
 *  - viaSwitch 才 toast「已连接 xxx」：冷启动自动重连不吵
 * 迟到响应防护：各模型 resetForHost 自增 hostEpoch，在途 refresh 按世代丢弃
 * （旧主机的迟到响应绝不回写新主机的内存面）。
 */
import { connModel, HostChangedInfo } from '../conn/ConnModel';
import { chatModel } from './ChatModel';
import { sessionsModel } from './SessionsModel';
import { workspaceModel } from './WorkspaceModel';
import { providerModel } from './ProviderModel';
import { automationModel } from './AutomationModel';
import { drawerState, toastModel } from './ChatDrawer';

/** EntryAbility.onCreate 里调用一次（connModel.init 后、autoConnect 前）。 */
export function registerHostSync(): void {
  connModel.registerHostChanged((info: HostChangedInfo) => {
    onHostChanged(info);
  });
}

function onHostChanged(info: HostChangedInfo): void {
  drawerState.close();
  // 停播报/听书 + store 回空态（resetForOpen('')）+ 附件清空 + 模型域重同步
  chatModel.newSession();
  sessionsModel.resetForHost();
  workspaceModel.resetForHost();
  providerModel.resetForHost();
  automationModel.resetForHost();
  // 并行重建（此时已 authed；各模型防重入/世代守卫齐备）
  void sessionsModel.refresh();
  void workspaceModel.refresh();
  void providerModel.refresh();
  void automationModel.refreshTasks();
  if (info.viaSwitch) {
    const name: string = info.hostName !== null && info.hostName !== '' ? info.hostName : info.deviceId;
    toastModel.show(`已连接 ${name}`, 'ok');
  }
}
