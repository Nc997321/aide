import { getTransport } from "../transport";
import type { AppInfo } from "../types/apps";

/** Host 发的事件：应用增删改、同意或启停之后。收到就重新 `list`。 */
export const APPS_CHANGED_EVENT = "apps-changed";

/**
 * 侧栏应用：装在**当前窗口连着的 Host** 上（`~/.aide/apps`，受信任工作区的 `.aide/apps` 是开发态）。
 * 面板只在桌面，这些命令不进 Link 暴露目录。
 */
export const appsApi = {
  list(): Promise<AppInfo[]> {
    return getTransport().invoke("app_list");
  },
  /** 应用界面经桥发来的调用。权限由 Host 按清单裁决，这里只是管道。 */
  call(appId: string, method: string, params: unknown): Promise<unknown> {
    return getTransport().invoke("app_call", { appId, method, params });
  },
  consent(appId: string, grant: string): Promise<void> {
    return getTransport().invoke("app_consent", { appId, grant });
  },
  setEnabled(appId: string, enabled: boolean): Promise<void> {
    return getTransport().invoke("app_set_enabled", { appId, enabled });
  },
  /** 应用目录里的一个文件（字节）。未经同意只取得到清单里写的图标。 */
  asset(appId: string, path: string): Promise<ArrayBuffer> {
    return getTransport().invoke("app_asset", { appId, path });
  },
  /** 把工作区里的开发态应用装成用户级。 */
  install(appId: string): Promise<void> {
    return getTransport().invoke("app_install", { appId });
  },
  /** 删掉眼前这一个应用：安装版连同与它一样的开发态副本；或者只删开发态那一份。数据留着。 */
  uninstall(appId: string): Promise<void> {
    return getTransport().invoke("app_uninstall", { appId });
  },
  /** 本窗口里某个应用的资源根地址（以 `/` 结尾）。桌面壳能力：应用界面从回环地址加载。 */
  frameBase(appId: string): Promise<string> {
    return getTransport().invoke("app_frame_base", { appId });
  },
};
