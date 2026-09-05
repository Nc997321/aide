import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { connModel } from '../conn/ConnModel';
import { initStorage } from '../sdk/storage';

export default class EntryAbility extends UIAbility {
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
    // 入口页固定 pages/Index；后续接入连接管理/会话页后仍从这里路由
    windowStage.loadContent('pages/Index', (err) => {
      if (err.code) {
        hilog.error(0x0000, 'aide', 'Failed to load the content. Cause: %{public}s', JSON.stringify(err) ?? '');
        return;
      }
      hilog.info(0x0000, 'aide', 'Succeeded in loading the content.');
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(0x0000, 'aide', '%{public}s', 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    hilog.info(0x0000, 'aide', '%{public}s', 'Ability onForeground');
  }

  onBackground(): void {
    hilog.info(0x0000, 'aide', '%{public}s', 'Ability onBackground');
  }
}
