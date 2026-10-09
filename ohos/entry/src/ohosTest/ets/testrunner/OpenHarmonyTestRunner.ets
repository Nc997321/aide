/**
 * ohosTest 驱动器（现行模板形态）。
 * aa test 经 -s unittest OpenHarmonyTestRunner 按名约定发现本类；onRun 只注册
 * AbilityMonitor 并 startAbility 拉起 TestAbility。用例真正执行在
 * TestAbility.onCreate 的 Hypium.hypiumTest。无 mock 场景，裁掉 checkMock。
 */
import { abilityDelegatorRegistry, TestRunner } from '@kit.TestKit';
import { UIAbility, Want } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { hilog } from '@kit.PerformanceAnalysisKit';

const DOMAIN: number = 0x0000;
const TAG: string = 'testTag';
const TEST_ABILITY_NAME: string = 'TestAbility';

async function onAbilityCreateCallback(data: UIAbility): Promise<void> {
  hilog.info(DOMAIN, TAG, 'onAbilityCreateCallback, data: %{public}s', JSON.stringify(data) ?? '');
}

async function addAbilityMonitorCallback(err: BusinessError): Promise<void> {
  hilog.info(DOMAIN, TAG, 'addAbilityMonitorCallback : %{public}s', JSON.stringify(err) ?? '');
}

export default class OpenHarmonyTestRunner implements TestRunner {
  constructor() {
  }

  onPrepare(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'OpenHarmonyTestRunner onPrepare');
  }

  async onRun(): Promise<void> {
    hilog.info(DOMAIN, TAG, '%{public}s', 'OpenHarmonyTestRunner onRun run');
    const args: abilityDelegatorRegistry.AbilityDelegatorArgs = abilityDelegatorRegistry.getArguments();
    const delegator: abilityDelegatorRegistry.AbilityDelegator = abilityDelegatorRegistry.getAbilityDelegator();
    const moduleName: string = args.parameters['-m'];
    const monitor: abilityDelegatorRegistry.AbilityMonitor = {
      abilityName: TEST_ABILITY_NAME,
      onAbilityCreate: onAbilityCreateCallback,
      moduleName: moduleName
    };
    delegator.addAbilityMonitor(monitor, addAbilityMonitorCallback);
    const want: Want = {
      bundleName: args.bundleName,
      abilityName: TEST_ABILITY_NAME,
      moduleName: moduleName
    };
    delegator.startAbility(want, (err: BusinessError) => {
      hilog.info(DOMAIN, TAG, 'startAbility : err : %{public}s', JSON.stringify(err) ?? '');
    });
    hilog.info(DOMAIN, TAG, '%{public}s', 'OpenHarmonyTestRunner onRun end');
  }
}
