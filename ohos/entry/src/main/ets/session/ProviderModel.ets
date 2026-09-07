/**
 * 供应商模型：抽屉徽标 + 切换弹层的全局可观察状态。
 *
 * 协议面（REGISTRY 白名单内）：get_providers（脱敏视图，密钥只回配置与否
 * 布尔）/ get_active_provider_id / set_active_provider_id。切换写桌面设置
 * activeProvider——此后新发起的会话经 resolve_send_provider 的全局 active
 * 兜底解析；已在跑的会话不受影响（见 api.ets setActiveProviderId 注释）。
 * 生命周期：authed 后拉取一次；不挂重连补拉（供应商配置低频变化，切换弹层
 * 每次打开重拉兜底——与 PWA 设置页拉取同粒度）。
 */
import { ConnModel, connModel } from '../conn/ConnModel';
import { api } from '../sdk/api';
import { ProviderConfigView } from '../sdk/types';

@ObservedV2
export class ProviderModel {
  @Trace providers: ProviderConfigView[] = [];
  @Trace activeId: string = '';
  @Trace refreshing: boolean = false;
  /** 首次拉取完成（区分「加载中」与「真空」空态）。 */
  @Trace loaded: boolean = false;

  /** 拉取供应商列表 + 当前激活 id（authed 前置；防重入）。 */
  async refresh(): Promise<void> {
    if (this.refreshing || connModel.state !== 'authed') {
      return;
    }
    this.refreshing = true;
    try {
      this.providers = await api.getProviders();
      this.activeId = await api.getActiveProviderId();
      this.loaded = true;
    } catch (e) {
      // 拉取失败静默：徽标退占位；弹层按 loaded 呈现空态，重开即重试
    } finally {
      this.refreshing = false;
    }
  }

  /** 当前激活供应商（activeId 未命中 → null，UI 退占位徽标「供应商」）。 */
  activeProvider(): ProviderConfigView | null {
    for (let i = 0; i < this.providers.length; i++) {
      if (this.providers[i].id === this.activeId) {
        return this.providers[i];
      }
    }
    return null;
  }

  /**
   * 切换激活供应商：等桌面回执后更新本地态（失败返回 false，由调用方提示；
   * 不乐观更新——切换失败时徽标不该跳变）。
   */
  async setActive(id: string): Promise<boolean> {
    if (connModel.state !== 'authed') {
      return false;
    }
    try {
      await api.setActiveProviderId(id);
      this.activeId = id;
      return true;
    } catch (e) {
      return false;
    }
  }
}

/** 全局单例：抽屉徽标与切换弹层共用。 */
export const providerModel: ProviderModel = new ProviderModel();
